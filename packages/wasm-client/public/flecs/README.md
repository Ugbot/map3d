# flecs/city Emscripten artefacts

This directory is where the runtime loader expects to find the Flecs/sokol
procedural city build:

```
public/flecs/
├── city.js     ← Emscripten JS glue (loaded as a classic <script>)
├── city.wasm   ← The compiled module (fetched by city.js at runtime)
└── README.md   ← (this file)
```

Both files are intentionally **not** committed. They are produced by building
`external/city` with the Emscripten target.

## Building

From the repo root:

```bash
cd external/city
bake build        # produces etc/city.js and etc/city.wasm
cp etc/city.js   ../../packages/wasm-client/public/flecs/
cp etc/city.wasm ../../packages/wasm-client/public/flecs/
```

(If you have a separate `em` build target, use it — the artefact names are
the same.)

## Required exported symbols

The C bridge (in `external/city/src/bridge.c`) must export the following
functions via `EMSCRIPTEN_KEEPALIVE` (or the `-s EXPORTED_FUNCTIONS=...`
linker flag). The TS wrapper `src/FlecsBridge.ts` `cwrap`s these by name:

| Symbol               | Signature                                                                 |
|----------------------|---------------------------------------------------------------------------|
| `beam_init`          | `void(void)`                                                              |
| `beam_begin_frame`   | `void(uint32_t tick_seq)`                                                 |
| `beam_end_frame`     | `void(void)`                                                              |
| `beam_agent_upsert`  | `void(uint32_t id, uint8_t kind, float x, float y, float z, float h)`     |
| `beam_agent_remove`  | `void(uint32_t id)`                                                       |
| `beam_feed_upsert`   | `void(uint32_t id, uint8_t kind, float x, float y, float z, float h)`     |
| `beam_feed_remove`   | `void(uint32_t id)`                                                       |
| `beam_set_env`       | `void(float alt, float az, uint32_t sun_rgb, uint32_t sky, uint32_t gnd)` |
| `beam_clear_all`     | `void(void)`                                                              |
| `beam_live_count`    | `uint32_t(void)`                                                          |

Also required in the Emscripten link (so the JS wrapper can call them):

```
-s EXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPF32,HEAPU32,HEAP8,HEAPU8
-s MODULARIZE=0          # we use the plain-script boot path
-s ENVIRONMENT=web
-s ALLOW_MEMORY_GROWTH=1
```

The page (`index.html`) provides a `<canvas id="canvas">` element which the
sokol Emscripten backend picks up automatically (the loader also sets
`Module.canvas` explicitly for safety).

## What happens if these files are missing

The client logs `failed to load /flecs/city.js …` and the status badge in
the corner turns red with the text `engine missing`. The WebSocket still
connects to the data-server so you can verify the wire pipeline end-to-end
even without the engine present.
