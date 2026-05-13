# Build pipeline

map3d is a pnpm workspace with four packages and one C subproject:

```
packages/
  data-core/     pure TS, bitECS world, codec, sun, projection
  data-server/   Node WS server that broadcasts world frames at 30 Hz
  app/           existing three.js / WebGPU renderer
  wasm-client/   browser page that drives a Flecs/sokol city WASM
external/
  city/          Flecs/sokol procedural city (forked from flecs-hub/city)
```

## TypeScript / Node

```bash
pnpm install
pnpm --filter @map3d/data-core test     # 13 vitest specs
pnpm --filter @map3d/app dev            # existing three.js scene
pnpm --filter @map3d/data-server start  # WebSocket server on 8787
pnpm --filter @map3d/wasm-client dev    # Flecs renderer page (needs WASM)
```

Convenience scripts at the root: `pnpm dev`, `pnpm dev:server`, `pnpm dev:wasm`,
`pnpm test`, `pnpm build`.

## Flecs city → WebAssembly

The wasm-client expects `packages/wasm-client/public/flecs/city.{js,wasm}`.
Those are produced by building `external/city/` with the Emscripten target.

### Option A — local toolchain

Install bake (the Flecs build tool) and the Emscripten SDK once:

```bash
git clone https://github.com/SanderMertens/bake && bake/setup.sh
git clone https://github.com/emscripten-core/emsdk && cd emsdk \
  && ./emsdk install latest && ./emsdk activate latest \
  && source ./emsdk_env.sh
```

Then from the repo root:

```bash
pnpm build:city
```

That runs `scripts/build-city-wasm.sh`, which calls `bake --target em` in
`external/city/`, copies `etc/city.{js,wasm}` into the wasm-client's public
folder, and grep-checks that the `beam_*` exports are present in the glue.

### Option B — containerised (no host toolchain)

If you'd rather not install emsdk + bake on the host (we use **podman**, not
docker, per the project preference):

```bash
pnpm build:city:podman
```

First run builds the image `localhost/map3d-city-build` from
`Containerfile.city-build` (~5 min, cached after). Subsequent runs just bind
mount the repo and invoke the same script inside the container.

### Native (non-WASM) build of the city

```bash
cd external/city
bake run
```

The native build keeps `BEAM_DRIVEN` off so the original procedural traffic
spawns as before — useful for sanity-checking the renderer side.

## What goes where after a city build

```
external/city/etc/city.js        ←  bake output (Emscripten glue)
external/city/etc/city.wasm      ←  bake output
packages/wasm-client/public/flecs/city.{js,wasm}   ←  copied by build-city-wasm.sh
```

Neither set is committed; both are gitignored.

## Bridge ABI version

The C bridge exports are documented in `external/city/BRIDGE.md`. The TS
client `cwrap`s them in `packages/wasm-client/src/FlecsBridge.ts`. If you
change the ABI on one side, change it on the other in the same commit.
