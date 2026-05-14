#include "bridge.h"
#include <math.h>

/* The bridge holds a single world pointer set at import time. All beam_*
 * functions are called from JS without context, so a file-static is the
 * least-bad option. Tiger-style: every entry asserts s_world is set. */
static ecs_world_t *s_world = NULL;

static ecs_map_t s_agents;
static ecs_map_t s_feeds;

static ecs_entity_t s_car_prefab = 0;
static ecs_entity_t s_train_prefab = 0;
static ecs_entity_t s_pedestrian_prefab = 0;
static ecs_entity_t s_aircraft_prefab = 0;
static ecs_entity_t s_vessel_prefab = 0;
static ecs_entity_t s_agents_root = 0;
static ecs_entity_t s_feeds_root = 0;
static ecs_entity_t s_sun_entity = 0;
static bool s_sun_missing_logged = false;

static bool s_active = false;
static bool s_in_frame = false;
static uint32_t s_last_tick_seq = 0;

/* Environment hint singleton fed by the server-side SunCalc. Kept as a
 * plain component so render systems / UIs can query it later without us
 * pulling a renderer dep into the bridge. */
typedef struct {
    float sun_altitude;
    float sun_azimuth;
    uint32_t sun_color_rgb;
    uint32_t ambient_sky_rgb;
    uint32_t ambient_ground_rgb;
} BeamEnv;

ECS_COMPONENT_DECLARE(BeamEnv);

static ecs_entity_t s_env_singleton = 0;

static inline uint64_t bridge_key(uint32_t remote_id, uint8_t kind) {
    return ((uint64_t)kind << 32) | (uint64_t)remote_id;
}

static ecs_entity_t bridge_lookup_or_create(
    ecs_map_t *map,
    uint32_t remote_id,
    uint8_t kind,
    ecs_entity_t parent,
    ecs_entity_t prefab)
{
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, "bridge not initialised");
    ecs_assert(map != NULL, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, "remote_id 0 is reserved");
    ecs_assert(prefab != 0, ECS_INVALID_PARAMETER, "prefab missing");

    uint64_t key = bridge_key(remote_id, kind);
    ecs_map_val_t *slot = ecs_map_get(map, key);
    if (slot && *slot) {
        return (ecs_entity_t)*slot;
    }

    ecs_assert(ecs_map_count(map) < BRIDGE_MAX_ENTITIES, ECS_OUT_OF_RANGE,
        "BRIDGE_MAX_ENTITIES exceeded");

    ecs_entity_t e = ecs_new_w_pair(s_world, EcsChildOf, parent);
    ecs_add_pair(s_world, e, EcsIsA, prefab);
    ecs_map_insert(map, key, (ecs_map_val_t)e);
    return e;
}

static void bridge_apply_transform(
    ecs_entity_t e,
    float x, float y, float z,
    float heading)
{
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(e != 0, ECS_INVALID_PARAMETER, NULL);

    /* Reject NaNs from the wire: server bugs must not corrupt ECS data. */
    ecs_assert(x == x && y == y && z == z && heading == heading,
        ECS_INVALID_PARAMETER, "non-finite transform from feed");

    ecs_set(s_world, e, EcsPosition3, { .x = x, .y = y, .z = z });
    ecs_set(s_world, e, EcsRotation3, { .x = 0.0f, .y = heading, .z = 0.0f });
}

static void bridge_remove_id(ecs_map_t *map, uint32_t remote_id, uint8_t kind) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(map != NULL, ECS_INVALID_PARAMETER, NULL);
    if (remote_id == 0) return;

    uint64_t key = bridge_key(remote_id, kind);
    ecs_map_val_t v = ecs_map_remove(map, key);
    if (v) {
        ecs_delete(s_world, (ecs_entity_t)v);
    }
}

static void bridge_clear_map(ecs_map_t *map) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    if (!ecs_map_is_init(map)) return;

    ecs_map_iter_t it = ecs_map_iter(map);
    while (ecs_map_next(&it)) {
        ecs_entity_t e = (ecs_entity_t)ecs_map_value(&it);
        if (e) ecs_delete(s_world, e);
    }
    ecs_map_clear(map);
}

static inline void bridge_unpack_rgb(uint32_t packed, float *r, float *g, float *b) {
    /* Packed as 0x00RRGGBB; gamma is the caller's problem. */
    *r = (float)((packed >> 16) & 0xFFu) * (1.0f / 255.0f);
    *g = (float)((packed >>  8) & 0xFFu) * (1.0f / 255.0f);
    *b = (float)((packed      ) & 0xFFu) * (1.0f / 255.0f);
}

/* Sun-sync system: lifts BeamEnv onto the named scene light entity once per
 * tick. Bounded by design: one ecs_get + at most one ecs_set per invocation,
 * no iteration. We deliberately don't run a query — the system is a phase
 * hook keyed off EcsOnUpdate so it fires exactly once per frame. */
static void bridge_sun_sync(ecs_iter_t *it) {
    ecs_world_t *world = it->world;
    ecs_assert(world != NULL, ECS_INTERNAL_ERROR, NULL);

    const BeamEnv *env = ecs_get(world, s_env_singleton, BeamEnv);
    if (!env) {
        return;
    }

    if (!s_sun_entity) {
        /* The scene asset names the directional-light entity `light` and
         * tags it with EcsSun (see etc/assets/app.flecs). The script runs
         * after the bridge is imported, so we resolve lazily. */
        s_sun_entity = ecs_lookup(world, "light");
        if (!s_sun_entity) {
            if (!s_sun_missing_logged) {
                ecs_dbg("bridge_sun_sync: `light` entity not found; "
                        "BeamEnv will not drive scene lighting");
                s_sun_missing_logged = true;
            }
            return;
        }
    }

    /* Altitude/azimuth → unit direction on an xz-up world. altitude is the
     * angle above the horizon, azimuth is measured clockwise from +z to
     * match the heading convention used by beam_agent_upsert. Light points
     * *from* the sun toward the ground, so direction = -sun_vector. */
    float ca = cosf(env->sun_altitude);
    float sa = sinf(env->sun_altitude);
    float cz = cosf(env->sun_azimuth);
    float sz = sinf(env->sun_azimuth);

    /* Position3 carries the unit sun direction scaled by a radius so a
     * renderer can read it as a direction without us inventing a new
     * component. The radius is arbitrary but stable across frames. */
    const float radius = 1.0f;
    float sx = ca * sz * radius;
    float sy = sa * radius;
    float sz_pos = ca * cz * radius;

    ecs_set(world, s_sun_entity, EcsPosition3,
        { .x = sx, .y = sy, .z = sz_pos });

    float r, g, b;
    bridge_unpack_rgb(env->sun_color_rgb, &r, &g, &b);
    ecs_set(world, s_sun_entity, EcsRgb, { .r = r, .g = g, .b = b });
}

/* --- Module import -------------------------------------------------------- */

void FlecsCityBridgeImport(ecs_world_t *world) {
    ecs_assert(world != NULL, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(s_world == NULL, ECS_INVALID_OPERATION, "bridge already imported");

    ECS_MODULE(world, FlecsCityBridge);

    ECS_IMPORT(world, FlecsComponentsTransform);
    ECS_IMPORT(world, FlecsCity);

    ECS_COMPONENT_DEFINE(world, BeamEnv);

    s_world = world;

    ecs_map_init(&s_agents, NULL);
    ecs_map_init(&s_feeds, NULL);

    s_car_prefab = ecs_lookup(world, "Car");
    ecs_assert(s_car_prefab != 0, ECS_INVALID_OPERATION,
        "Car prefab missing; import FlecsCity before the bridge");

    s_agents_root = ecs_entity(world, { .name = "#0.beam_agents" });
    s_feeds_root  = ecs_entity(world, { .name = "#0.beam_feeds" });
    s_env_singleton = ecs_entity(world, { .name = "#0.beam_env" });

    ecs_set(world, s_env_singleton, BeamEnv, {0});

    /* Kind-specific prefabs. Each IsA's the Car prefab so it inherits the
     * wheel/light children, but overrides the body Box + Rgb so trains,
     * pedestrians, aircraft, and vessels are visually distinguishable.
     * Sizes/colours picked to read at the city scale; renderers can
     * specialise further by replacing these prefabs. */
    s_train_prefab = ecs_entity(world, { .name = "BeamTrain" });
    ecs_add_id(world, s_train_prefab, EcsPrefab);
    ecs_add_pair(world, s_train_prefab, EcsIsA, s_car_prefab);
    ecs_set(world, s_train_prefab, EcsBox,
        { .width = 4.0f, .height = 3.5f, .depth = 30.0f });
    ecs_set(world, s_train_prefab, EcsRgb,
        { .r = 0.45f, .g = 0.45f, .b = 0.48f });

    s_pedestrian_prefab = ecs_entity(world, { .name = "BeamPedestrian" });
    ecs_add_id(world, s_pedestrian_prefab, EcsPrefab);
    ecs_add_pair(world, s_pedestrian_prefab, EcsIsA, s_car_prefab);
    ecs_set(world, s_pedestrian_prefab, EcsBox,
        { .width = 0.6f, .height = 1.8f, .depth = 0.6f });
    ecs_set(world, s_pedestrian_prefab, EcsRgb,
        { .r = 0.0f, .g = 0.85f, .b = 0.95f });

    s_aircraft_prefab = ecs_entity(world, { .name = "BeamAircraft" });
    ecs_add_id(world, s_aircraft_prefab, EcsPrefab);
    ecs_add_pair(world, s_aircraft_prefab, EcsIsA, s_car_prefab);
    ecs_set(world, s_aircraft_prefab, EcsBox,
        { .width = 30.0f, .height = 3.0f, .depth = 4.0f });
    ecs_set(world, s_aircraft_prefab, EcsRgb,
        { .r = 0.95f, .g = 0.95f, .b = 0.97f });

    s_vessel_prefab = ecs_entity(world, { .name = "BeamVessel" });
    ecs_add_id(world, s_vessel_prefab, EcsPrefab);
    ecs_add_pair(world, s_vessel_prefab, EcsIsA, s_car_prefab);
    ecs_set(world, s_vessel_prefab, EcsBox,
        { .width = 14.0f, .height = 6.0f, .depth = 60.0f });
    ecs_set(world, s_vessel_prefab, EcsRgb,
        { .r = 0.05f, .g = 0.1f, .b = 0.35f });

    /* Phase-hook system: empty query, runs once on EcsOnUpdate. Tiger-style
     * bound — the callback does O(1) work and asserts the world. */
    ecs_system(world, {
        .entity = ecs_entity(world, {
            .name = "BridgeSunSync",
            .add = (ecs_id_t[]){ ecs_dependson(EcsOnUpdate), EcsOnUpdate, 0 }
        }),
        .callback = bridge_sun_sync
    });

    s_active = true;
}

static ecs_entity_t bridge_agent_prefab(uint8_t kind) {
    switch (kind) {
        case 0: return s_car_prefab;
        case 1: return s_train_prefab;
        case 2: return s_pedestrian_prefab;
        default:
            ecs_assert(false, ECS_INVALID_PARAMETER, "agent kind out of range");
            return 0;
    }
}

static ecs_entity_t bridge_feed_prefab(uint8_t kind) {
    switch (kind) {
        case 0: return s_aircraft_prefab;
        case 1: return s_vessel_prefab;
        default:
            ecs_assert(false, ECS_INVALID_PARAMETER, "feed kind out of range");
            return 0;
    }
}

bool beam_is_active(void) {
    return s_active;
}

/* --- Exported ABI --------------------------------------------------------- */

void beam_init(void) {
    /* The TS side calls this after FlecsCity has been imported and the world
     * is ticking. If FlecsCityBridgeImport hasn't run we trip here so the
     * problem is loud rather than silent. */
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION,
        "FlecsCityBridgeImport must run before beam_init");
    ecs_assert(s_active, ECS_INVALID_OPERATION, "bridge inactive");
}

void beam_begin_frame(uint32_t tick_seq) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(!s_in_frame, ECS_INVALID_OPERATION, "nested beam_begin_frame");
    s_in_frame = true;
    s_last_tick_seq = tick_seq;
    ecs_defer_begin(s_world);
}

void beam_end_frame(void) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(s_in_frame, ECS_INVALID_OPERATION, "beam_end_frame without begin");
    ecs_defer_end(s_world);
    s_in_frame = false;
}

void beam_agent_upsert(uint32_t remote_id, uint8_t kind,
    float x, float y, float z, float heading)
{
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(kind <= 2, ECS_INVALID_PARAMETER, "agent kind out of range");

    /* kind: 0=vehicle, 1=train, 2=pedestrian. The kind is part of the map
     * key so id-collisions across families resolve to distinct entities. */
    ecs_entity_t e = bridge_lookup_or_create(
        &s_agents, remote_id, kind, s_agents_root, bridge_agent_prefab(kind));
    bridge_apply_transform(e, x, y, z, heading);
}

void beam_agent_remove(uint32_t remote_id) {
    /* We don't know the kind on remove; the contract is that ids are unique
     * across kinds so we try all three. */
    bridge_remove_id(&s_agents, remote_id, 0);
    bridge_remove_id(&s_agents, remote_id, 1);
    bridge_remove_id(&s_agents, remote_id, 2);
}

void beam_feed_upsert(uint32_t remote_id, uint8_t kind,
    float x, float y, float z, float heading)
{
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(kind <= 1, ECS_INVALID_PARAMETER, "feed kind out of range");

    ecs_entity_t e = bridge_lookup_or_create(
        &s_feeds, remote_id, kind, s_feeds_root, bridge_feed_prefab(kind));
    bridge_apply_transform(e, x, y, z, heading);
}

void beam_feed_remove(uint32_t remote_id) {
    bridge_remove_id(&s_feeds, remote_id, 0);
    bridge_remove_id(&s_feeds, remote_id, 1);
}

void beam_agent_remove_kind(uint32_t remote_id, uint8_t kind) {
    /* Kind-aware fast path: single O(1) map lookup vs. probing all three
     * agent kinds. The TS reaper knows the kind so we use it. */
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, "remote_id 0 is reserved");
    ecs_assert(kind <= 2, ECS_INVALID_PARAMETER, "agent kind out of range");
    bridge_remove_id(&s_agents, remote_id, kind);
}

void beam_feed_remove_kind(uint32_t remote_id, uint8_t kind) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, "remote_id 0 is reserved");
    ecs_assert(kind <= 1, ECS_INVALID_PARAMETER, "feed kind out of range");
    bridge_remove_id(&s_feeds, remote_id, kind);
}

void beam_set_env(float sun_altitude, float sun_azimuth,
    uint32_t sun_color_rgb, uint32_t ambient_sky_rgb, uint32_t ambient_ground_rgb)
{
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(sun_altitude == sun_altitude && sun_azimuth == sun_azimuth,
        ECS_INVALID_PARAMETER, "non-finite sun angles");

    ecs_set(s_world, s_env_singleton, BeamEnv, {
        .sun_altitude = sun_altitude,
        .sun_azimuth = sun_azimuth,
        .sun_color_rgb = sun_color_rgb,
        .ambient_sky_rgb = ambient_sky_rgb,
        .ambient_ground_rgb = ambient_ground_rgb
    });
}

void beam_clear_all(void) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);

    bool deferred = s_in_frame;
    if (!deferred) ecs_defer_begin(s_world);
    bridge_clear_map(&s_agents);
    bridge_clear_map(&s_feeds);
    if (!deferred) ecs_defer_end(s_world);
}

uint32_t beam_live_count(void) {
    if (!s_world) return 0;
    uint64_t n = (uint64_t)ecs_map_count(&s_agents) + (uint64_t)ecs_map_count(&s_feeds);
    ecs_assert(n <= 0xFFFFFFFFu, ECS_INTERNAL_ERROR, NULL);
    return (uint32_t)n;
}
