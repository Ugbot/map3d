#!/usr/bin/env bash
# Build external/city for the Emscripten target via bake and copy the
# resulting .js + .wasm into packages/wasm-client/public/flecs/.
#
# Requires bake + emcc on $PATH. If you don't want to install those locally,
# use scripts/build-city-podman.sh instead (uses a container image).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
city_dir="$repo_root/external/city"
out_dir="$repo_root/packages/wasm-client/public/flecs"

if ! command -v bake >/dev/null 2>&1; then
  echo "error: bake not on PATH. Install: git clone https://github.com/SanderMertens/bake && bake/setup.sh" >&2
  exit 2
fi
if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not on PATH. Install emsdk: https://emscripten.org/docs/getting_started/downloads.html" >&2
  exit 2
fi

echo "[build-city] bake build em target in $city_dir"
cd "$city_dir"
bake --target em

src_js="$city_dir/etc/city.js"
src_wasm="$city_dir/etc/city.wasm"
for f in "$src_js" "$src_wasm"; do
  if [ ! -f "$f" ]; then
    echo "error: expected build artefact missing: $f" >&2
    exit 1
  fi
done

mkdir -p "$out_dir"
cp "$src_js"   "$out_dir/city.js"
cp "$src_wasm" "$out_dir/city.wasm"

# Sanity check: confirm the beam_* exports are present in the glue.
missing=0
for sym in beam_init beam_begin_frame beam_end_frame beam_agent_upsert \
           beam_agent_remove beam_feed_upsert beam_feed_remove \
           beam_set_env beam_clear_all beam_live_count; do
  if ! grep -q "_$sym" "$out_dir/city.js"; then
    echo "warn: expected export _$sym not found in city.js" >&2
    missing=$((missing + 1))
  fi
done
if [ "$missing" -gt 0 ]; then
  echo "warn: $missing beam_* export(s) missing — check project.json EXPORTED_FUNCTIONS"
fi

echo "[build-city] artefacts in $out_dir"
ls -l "$out_dir"
