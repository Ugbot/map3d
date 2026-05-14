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

#ifdef __cplusplus
}
#endif

#endif
