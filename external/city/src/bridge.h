#ifndef CITY_BRIDGE_H
#define CITY_BRIDGE_H

#include <city.h>
#include <stdint.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define BRIDGE_MAX_ENTITIES 32768

/* Module import; binds the bridge to a world. Must be called once after
 * FlecsCity has been imported, before any beam_* upserts. */
void FlecsCityBridgeImport(ecs_world_t *world);

/* Returns true once FlecsCityBridgeImport has succeeded. The TS side relies
 * on this for "bridge active -> suppress procedural traffic" gating. */
bool beam_is_active(void);

EMSCRIPTEN_KEEPALIVE void beam_init(void);

EMSCRIPTEN_KEEPALIVE void beam_begin_frame(uint32_t tick_seq);
EMSCRIPTEN_KEEPALIVE void beam_end_frame(void);

EMSCRIPTEN_KEEPALIVE void beam_agent_upsert(uint32_t remote_id, uint8_t kind,
    float x, float y, float z, float heading);
EMSCRIPTEN_KEEPALIVE void beam_agent_remove(uint32_t remote_id);
EMSCRIPTEN_KEEPALIVE void beam_agent_remove_kind(uint32_t remote_id, uint8_t kind);

EMSCRIPTEN_KEEPALIVE void beam_feed_upsert(uint32_t remote_id, uint8_t kind,
    float x, float y, float z, float heading);
EMSCRIPTEN_KEEPALIVE void beam_feed_remove(uint32_t remote_id);
EMSCRIPTEN_KEEPALIVE void beam_feed_remove_kind(uint32_t remote_id, uint8_t kind);

EMSCRIPTEN_KEEPALIVE void beam_set_env(float sun_altitude, float sun_azimuth,
    uint32_t sun_color_rgb, uint32_t ambient_sky_rgb, uint32_t ambient_ground_rgb);

EMSCRIPTEN_KEEPALIVE void beam_clear_all(void);

EMSCRIPTEN_KEEPALIVE uint32_t beam_live_count(void);

/* ---- Static tile geometry -------------------------------------------------
 *
 * The bridge groups static (non-agent, non-feed) entities under a tile key
 * `BeamTileKey{z,x,y}` so the JS host can drop a tile by id when its
 * viewport changes. Upserts must be wrapped in a begin/end pair; the open
 * tile key is module-static state. */

EMSCRIPTEN_KEEPALIVE void beam_tile_begin   (uint32_t z, uint32_t x, uint32_t y);
EMSCRIPTEN_KEEPALIVE void beam_tile_end     (void);
EMSCRIPTEN_KEEPALIVE void beam_tile_release (uint32_t z, uint32_t x, uint32_t y);

/* kind: 0=building (CityBuilding), 1=modern (CityModernBuilding),
 * 2=skyscraper (CityModernBuilding + scaled). color_rgb==0 means
 * "inherit the prefab default". */
EMSCRIPTEN_KEEPALIVE void beam_building_upsert(uint32_t remote_id, uint8_t kind,
    float cx, float cy, float cz,
    float sx, float sy, float sz,
    float heading, uint32_t color_rgb);

/* Generic triangulated mesh. positions_ptr / indices_ptr are uint32 offsets
 * into the wasm linear memory (i.e. heap pointers the JS host obtained via
 * _malloc). beam_mesh_upsert copies the bytes into fresh sokol buffers; the
 * caller is responsible for _free'ing the heap allocations after this call
 * returns. */
EMSCRIPTEN_KEEPALIVE void beam_mesh_upsert(uint32_t remote_id, uint8_t layer_kind,
    uint32_t positions_ptr, uint32_t n_floats,
    uint32_t indices_ptr,   uint32_t n_indices,
    uint32_t color_rgb,
    float origin_x, float origin_y, float origin_z);
EMSCRIPTEN_KEEPALIVE void beam_mesh_remove(uint32_t remote_id);

/* Lantern (CityLantern prefab). */
EMSCRIPTEN_KEEPALIVE void beam_lantern_upsert(uint32_t remote_id,
    float x, float y, float z);

/* prop_kind: 0=tree(CitySidewalkTree), 1=bin(CityBin),
 *            2=hydrant(CityHydrant), 3=bench(CityBench). */
EMSCRIPTEN_KEEPALIVE void beam_prop_upsert(uint32_t remote_id, uint8_t prop_kind,
    float x, float y, float z, float heading);

/* ---- Camera + stats -------------------------------------------------------
 *
 * Two ways to drive the camera: absolute placement (used on origin change)
 * and incremental rotation (used by mouse-drag look in JS). Both mutate the
 * named `camera` entity declared in app.flecs. Pitch is clamped internally
 * to [-PI/2 + 0.05, PI/2 - 0.05] so the controller can't gimbal-flip. */
EMSCRIPTEN_KEEPALIVE void beam_set_camera(float x, float y, float z,
    float yaw, float pitch);
EMSCRIPTEN_KEEPALIVE void beam_camera_rotate_delta(float dyaw, float dpitch);

/* Fills a 4-float scratch buffer the caller allocated on the wasm heap.
 * Slot 0: frame_count_total (cast u32 -> f32). Slot 1: delta_time_total
 * seconds. Slot 2: world_time_total seconds. Slot 3: live entity count
 * (cast u32 -> f32). */
EMSCRIPTEN_KEEPALIVE void beam_world_info(uint32_t out_floats_ptr);

#ifdef __cplusplus
}
#endif

#endif
