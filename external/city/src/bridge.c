#include "bridge.h"
#include <math.h>

/* The bridge holds a single world pointer set at import time. All beam_*
 * functions are called from JS without context, so a file-static is the
 * least-bad option. Tiger-style: every entry asserts s_world is set. */
static ecs_world_t *s_world = NULL;

static ecs_map_t s_agents;
static ecs_map_t s_feeds;

static ecs_entity_t s_car_prefab = 0;
static ecs_entity_t s_agents_root = 0;
static ecs_entity_t s_feeds_root = 0;

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

    s_active = true;
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

    /* All three agent kinds reuse the Car prefab for now; train/pedestrian
     * prefabs land in a follow-up. Storing kind in the map key lets us
     * swap prefabs without remapping ids. */
    ecs_entity_t e = bridge_lookup_or_create(
        &s_agents, remote_id, kind, s_agents_root, s_car_prefab);
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
        &s_feeds, remote_id, kind, s_feeds_root, s_car_prefab);
    bridge_apply_transform(e, x, y, z, heading);
}

void beam_feed_remove(uint32_t remote_id) {
    bridge_remove_id(&s_feeds, remote_id, 0);
    bridge_remove_id(&s_feeds, remote_id, 1);
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
