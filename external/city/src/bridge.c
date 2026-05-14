#include "bridge.h"
#include "beam_mesh.h"
#include <math.h>

/* The bridge holds a single world pointer set at import time. All beam_*
 * functions are called from JS without context, so a file-static is the
 * least-bad option. Tiger-style: every entry asserts s_world is set. */
static ecs_world_t *s_world = NULL;

static ecs_map_t s_agents;
static ecs_map_t s_feeds;
/* Statics live under a single map keyed by (family << 32) | remote_id. We
 * use a single map (not three) so beam_*_remove probes O(1) regardless of
 * which family the remote_id was originally upserted with. Families:
 *   1 = building, 2 = mesh, 3 = lantern, 4 = prop. */
static ecs_map_t s_statics;

#define BRIDGE_FAMILY_BUILDING 1u
#define BRIDGE_FAMILY_MESH     2u
#define BRIDGE_FAMILY_LANTERN  3u
#define BRIDGE_FAMILY_PROP     4u

static ecs_entity_t s_car_prefab = 0;
static ecs_entity_t s_train_prefab = 0;
static ecs_entity_t s_pedestrian_prefab = 0;
static ecs_entity_t s_aircraft_prefab = 0;
static ecs_entity_t s_vessel_prefab = 0;
static ecs_entity_t s_building_prefab = 0;
static ecs_entity_t s_modern_building_prefab = 0;
static ecs_entity_t s_lantern_prefab = 0;
static ecs_entity_t s_sidewalk_tree_prefab = 0;
static ecs_entity_t s_bin_prefab = 0;
static ecs_entity_t s_hydrant_prefab = 0;
static ecs_entity_t s_bench_prefab = 0;
static ecs_entity_t s_agents_root = 0;
static ecs_entity_t s_feeds_root = 0;
static ecs_entity_t s_statics_root = 0;
static ecs_entity_t s_sun_entity = 0;
static bool s_sun_missing_logged = false;

/* BeamTileKey tags every static entity created between beam_tile_begin and
 * beam_tile_end so beam_tile_release can wipe an entire tile in one query. */
typedef struct {
    uint32_t z;
    uint32_t x;
    uint32_t y;
} BeamTileKey;

ECS_COMPONENT_DECLARE(BeamTileKey);

/* Module-static "currently open tile". (0,0,0) means no tile open; we use
 * s_tile_open as the source of truth and ignore the zero-as-sentinel risk
 * because real tile keys at z=0 are valid. */
static BeamTileKey s_open_tile = {0, 0, 0};
static bool s_tile_open = false;
static ecs_query_t *s_tile_release_query = NULL;

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
    ECS_COMPONENT_DEFINE(world, BeamTileKey);

    s_world = world;

    ecs_map_init(&s_agents, NULL);
    ecs_map_init(&s_feeds, NULL);
    ecs_map_init(&s_statics, NULL);

    s_car_prefab = ecs_lookup(world, "Car");
    ecs_assert(s_car_prefab != 0, ECS_INVALID_OPERATION,
        "Car prefab missing; import FlecsCity before the bridge");

    /* Static-scene prefabs from city.flecs. All looked up by their unqualified
     * names — same convention module.c uses for the procedural generator. We
     * assert presence so a missing asset file fails loud instead of producing
     * silently invisible entities at runtime. */
    s_building_prefab        = ecs_lookup(world, "Building");
    s_modern_building_prefab = ecs_lookup(world, "ModernBuilding");
    s_lantern_prefab         = ecs_lookup(world, "Lantern");
    s_sidewalk_tree_prefab   = ecs_lookup(world, "SidewalkTree");
    s_bin_prefab             = ecs_lookup(world, "Bin");
    s_hydrant_prefab         = ecs_lookup(world, "Hydrant");
    s_bench_prefab           = ecs_lookup(world, "Bench");
    ecs_assert(s_building_prefab != 0, ECS_INVALID_OPERATION,
        "Building prefab missing");
    ecs_assert(s_modern_building_prefab != 0, ECS_INVALID_OPERATION,
        "ModernBuilding prefab missing");
    ecs_assert(s_lantern_prefab != 0, ECS_INVALID_OPERATION,
        "Lantern prefab missing");
    ecs_assert(s_sidewalk_tree_prefab != 0, ECS_INVALID_OPERATION,
        "SidewalkTree prefab missing");
    ecs_assert(s_bin_prefab != 0, ECS_INVALID_OPERATION, "Bin prefab missing");
    ecs_assert(s_hydrant_prefab != 0, ECS_INVALID_OPERATION,
        "Hydrant prefab missing");
    ecs_assert(s_bench_prefab != 0, ECS_INVALID_OPERATION,
        "Bench prefab missing");

    s_agents_root  = ecs_entity(world, { .name = "#0.beam_agents" });
    s_feeds_root   = ecs_entity(world, { .name = "#0.beam_feeds" });
    s_statics_root = ecs_entity(world, { .name = "#0.beam_statics" });
    s_env_singleton = ecs_entity(world, { .name = "#0.beam_env" });

    /* Cached query for tile release: matches every entity carrying a
     * BeamTileKey. The release path filters by value inside the iter loop
     * (Flecs queries don't filter on component data without extra plumbing). */
    s_tile_release_query = ecs_query(world, {
        .terms = {{ .id = ecs_id(BeamTileKey), .inout = EcsIn }},
        .cache_kind = EcsQueryCacheAuto
    });
    ecs_assert(s_tile_release_query != NULL, ECS_INTERNAL_ERROR,
        "failed to build tile-release query");

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
    bridge_clear_map(&s_statics);
    if (!deferred) ecs_defer_end(s_world);
}

uint32_t beam_live_count(void) {
    if (!s_world) return 0;
    uint64_t n = (uint64_t)ecs_map_count(&s_agents)
               + (uint64_t)ecs_map_count(&s_feeds)
               + (uint64_t)ecs_map_count(&s_statics);
    ecs_assert(n <= 0xFFFFFFFFu, ECS_INTERNAL_ERROR, NULL);
    return (uint32_t)n;
}

/* --- Static tile geometry ABI --------------------------------------------- */

static inline void bridge_tag_tile(ecs_entity_t e) {
    /* Caller-asserts s_tile_open. We re-assert defensively because the cost
     * is trivial and miss-tagged entities are very confusing to debug. */
    ecs_assert(s_tile_open, ECS_INVALID_OPERATION,
        "static upsert outside beam_tile_begin/end");
    ecs_set(s_world, e, BeamTileKey, {
        .z = s_open_tile.z,
        .x = s_open_tile.x,
        .y = s_open_tile.y
    });
}

static ecs_entity_t bridge_static_lookup_or_create(
    uint32_t remote_id, uint32_t family, ecs_entity_t prefab)
{
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(prefab != 0, ECS_INVALID_PARAMETER, NULL);

    uint64_t key = ((uint64_t)family << 32) | (uint64_t)remote_id;
    ecs_map_val_t *slot = ecs_map_get(&s_statics, key);
    if (slot && *slot) {
        return (ecs_entity_t)*slot;
    }

    ecs_assert(ecs_map_count(&s_statics) < BRIDGE_MAX_ENTITIES,
        ECS_OUT_OF_RANGE, "BRIDGE_MAX_ENTITIES exceeded (statics)");

    ecs_entity_t e = ecs_new_w_pair(s_world, EcsChildOf, s_statics_root);
    ecs_add_pair(s_world, e, EcsIsA, prefab);
    bridge_tag_tile(e);
    ecs_map_insert(&s_statics, key, (ecs_map_val_t)e);
    return e;
}

void beam_tile_begin(uint32_t z, uint32_t x, uint32_t y) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(!s_tile_open, ECS_INVALID_OPERATION, "nested beam_tile_begin");
    s_open_tile = (BeamTileKey){ .z = z, .x = x, .y = y };
    s_tile_open = true;
}

void beam_tile_end(void) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(s_tile_open, ECS_INVALID_OPERATION, "beam_tile_end without begin");
    s_tile_open = false;
}

void beam_tile_release(uint32_t z, uint32_t x, uint32_t y) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(s_tile_release_query != NULL, ECS_INVALID_OPERATION, NULL);

    bool deferred = s_in_frame;
    if (!deferred) ecs_defer_begin(s_world);

    /* Walk every entity with a BeamTileKey, delete those whose key matches.
     * The on_remove hook on BeamMesh frees sokol buffers automatically; the
     * map slots are cleaned up by ECS_DTOR on entity deletion.
     *
     * We also lazily prune s_statics entries that match by scanning the map
     * after the delete pass — bounded by BRIDGE_MAX_ENTITIES, so O(N) is OK
     * for the release path which is not hot. */
    ecs_iter_t it = ecs_query_iter(s_world, s_tile_release_query);
    while (ecs_query_next(&it)) {
        BeamTileKey *keys = ecs_field(&it, BeamTileKey, 0);
        int i;
        for (i = 0; i < it.count; i++) {
            if (keys[i].z == z && keys[i].x == x && keys[i].y == y) {
                ecs_delete(s_world, it.entities[i]);
            }
        }
    }

    /* Drop stale map entries (their entities are gone). Use a copy-on-write
     * pattern: collect dead keys first, then remove. ecs_map_remove during
     * iteration is undefined behaviour.
     *
     * The buffer is heap-allocated rather than on the stack because
     * BRIDGE_MAX_ENTITIES * sizeof(uint64_t) == 256 KiB on the Emscripten
     * 1 MiB stack — leaving that much headroom for the rest of the call
     * chain would be tight. The release path is cold, so one malloc/free is
     * fine. */
    size_t cap = (size_t)BRIDGE_MAX_ENTITIES;
    uint64_t *dead_keys = (uint64_t*)ecs_os_malloc(cap * sizeof(uint64_t));
    ecs_assert(dead_keys != NULL, ECS_OUT_OF_MEMORY, NULL);
    uint32_t n_dead = 0;
    ecs_map_iter_t mit = ecs_map_iter(&s_statics);
    while (ecs_map_next(&mit) && n_dead < cap) {
        ecs_entity_t e = (ecs_entity_t)ecs_map_value(&mit);
        if (!ecs_is_alive(s_world, e)) {
            dead_keys[n_dead++] = ecs_map_key(&mit);
        }
    }
    uint32_t i;
    for (i = 0; i < n_dead; i++) {
        ecs_map_remove(&s_statics, dead_keys[i]);
    }
    ecs_os_free(dead_keys);

    if (!deferred) ecs_defer_end(s_world);
}

void beam_building_upsert(uint32_t remote_id, uint8_t kind,
    float cx, float cy, float cz,
    float sx, float sy, float sz,
    float heading, uint32_t color_rgb)
{
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(kind <= 2, ECS_INVALID_PARAMETER, "building kind out of range");
    ecs_assert(s_tile_open, ECS_INVALID_OPERATION,
        "beam_building_upsert outside beam_tile_begin/end");
    ecs_assert(cx == cx && cy == cy && cz == cz, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(sx == sx && sy == sy && sz == sz, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(sx > 0.0f && sy > 0.0f && sz > 0.0f, ECS_INVALID_PARAMETER,
        "building size must be positive");
    ecs_assert(heading == heading, ECS_INVALID_PARAMETER, NULL);

    ecs_entity_t prefab = (kind == 0)
        ? s_building_prefab
        : s_modern_building_prefab;

    ecs_entity_t e = bridge_static_lookup_or_create(
        remote_id, BRIDGE_FAMILY_BUILDING, prefab);

    ecs_set(s_world, e, EcsPosition3, { .x = cx, .y = cy, .z = cz });
    ecs_set(s_world, e, EcsBox,
        { .width = sx, .height = sy, .depth = sz });
    ecs_set(s_world, e, EcsRotation3, { .x = 0.0f, .y = heading, .z = 0.0f });

    if (color_rgb != 0u) {
        float r, g, b;
        bridge_unpack_rgb(color_rgb, &r, &g, &b);
        ecs_set(s_world, e, EcsRgb, { .r = r, .g = g, .b = b });
    }
}

void beam_mesh_upsert(uint32_t remote_id, uint8_t layer_kind,
    uint32_t positions_ptr, uint32_t n_floats,
    uint32_t indices_ptr,   uint32_t n_indices,
    uint32_t color_rgb,
    float origin_x, float origin_y, float origin_z)
{
    (void)layer_kind; /* Reserved for future per-layer materials. */

    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(s_tile_open, ECS_INVALID_OPERATION,
        "beam_mesh_upsert outside beam_tile_begin/end");
    ecs_assert(positions_ptr != 0, ECS_INVALID_PARAMETER, "null positions_ptr");
    ecs_assert(indices_ptr   != 0, ECS_INVALID_PARAMETER, "null indices_ptr");
    ecs_assert(n_floats  > 0 && n_floats  <= BEAM_MESH_MAX_FLOATS,
        ECS_OUT_OF_RANGE, "n_floats out of range");
    ecs_assert(n_indices > 0 && n_indices <= BEAM_MESH_MAX_INDICES,
        ECS_OUT_OF_RANGE, "n_indices out of range");

    const float *positions = (const float*)(uintptr_t)positions_ptr;
    const uint32_t *indices = (const uint32_t*)(uintptr_t)indices_ptr;

    /* Look up or create the entity. We don't IsA any prefab — BeamMesh is
     * the sole renderable component on these entities. */
    uint64_t key = ((uint64_t)BRIDGE_FAMILY_MESH << 32) | (uint64_t)remote_id;
    ecs_map_val_t *slot = ecs_map_get(&s_statics, key);
    ecs_entity_t e = slot && *slot ? (ecs_entity_t)*slot : 0;

    if (!e) {
        ecs_assert(ecs_map_count(&s_statics) < BRIDGE_MAX_ENTITIES,
            ECS_OUT_OF_RANGE, "BRIDGE_MAX_ENTITIES exceeded (mesh)");
        e = ecs_new_w_pair(s_world, EcsChildOf, s_statics_root);
        bridge_tag_tile(e);
        ecs_map_insert(&s_statics, key, (ecs_map_val_t)e);
    } else {
        /* Existing entity: tear down the previous BeamMesh so we don't leak
         * sokol buffers when we overwrite. The on_remove hook handles this
         * via ecs_remove. */
        if (ecs_has(s_world, e, BeamMesh)) {
            ecs_remove(s_world, e, BeamMesh);
        }
    }

    BeamMesh built = {0};
    if (!beam_mesh_build(&built, positions, n_floats, indices, n_indices,
            color_rgb, origin_x, origin_y, origin_z))
    {
        /* Build failed (sokol not ready yet, or validation tripped). Leave
         * the entity alive but bare — it'll be re-upserted on the next tile
         * push, or cleaned up by tile_release. */
        return;
    }

    ecs_set_ptr(s_world, e, BeamMesh, &built);
}

void beam_mesh_remove(uint32_t remote_id) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, NULL);

    uint64_t key = ((uint64_t)BRIDGE_FAMILY_MESH << 32) | (uint64_t)remote_id;
    ecs_map_val_t v = ecs_map_remove(&s_statics, key);
    if (v) {
        ecs_delete(s_world, (ecs_entity_t)v);
    }
}

void beam_lantern_upsert(uint32_t remote_id, float x, float y, float z) {
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(s_tile_open, ECS_INVALID_OPERATION,
        "beam_lantern_upsert outside beam_tile_begin/end");
    ecs_assert(x == x && y == y && z == z, ECS_INVALID_PARAMETER, NULL);

    ecs_entity_t e = bridge_static_lookup_or_create(
        remote_id, BRIDGE_FAMILY_LANTERN, s_lantern_prefab);
    ecs_set(s_world, e, EcsPosition3, { .x = x, .y = y, .z = z });
}

void beam_prop_upsert(uint32_t remote_id, uint8_t prop_kind,
    float x, float y, float z, float heading)
{
    ecs_assert(s_world != NULL, ECS_INVALID_OPERATION, NULL);
    ecs_assert(remote_id != 0, ECS_INVALID_PARAMETER, NULL);
    ecs_assert(prop_kind <= 3, ECS_INVALID_PARAMETER, "prop kind out of range");
    ecs_assert(s_tile_open, ECS_INVALID_OPERATION,
        "beam_prop_upsert outside beam_tile_begin/end");
    ecs_assert(x == x && y == y && z == z && heading == heading,
        ECS_INVALID_PARAMETER, NULL);

    ecs_entity_t prefab = 0;
    switch (prop_kind) {
        case 0: prefab = s_sidewalk_tree_prefab; break;
        case 1: prefab = s_bin_prefab;           break;
        case 2: prefab = s_hydrant_prefab;       break;
        case 3: prefab = s_bench_prefab;         break;
        default:
            ecs_assert(false, ECS_INVALID_PARAMETER, NULL);
            return;
    }

    ecs_entity_t e = bridge_static_lookup_or_create(
        remote_id, BRIDGE_FAMILY_PROP, prefab);
    ecs_set(s_world, e, EcsPosition3, { .x = x, .y = y, .z = z });
    ecs_set(s_world, e, EcsRotation3, { .x = 0.0f, .y = heading, .z = 0.0f });
}

