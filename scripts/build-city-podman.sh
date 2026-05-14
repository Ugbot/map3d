#!/usr/bin/env bash
# Build external/city → WASM inside a podman container so contributors don't
# need bake or emsdk installed locally. The container image is built on first
# run from Containerfile.city-build and cached as localhost/map3d-city-build.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="localhost/map3d-city-build"

if ! command -v podman >/dev/null 2>&1; then
  echo "error: podman not on PATH. brew install podman (and 'podman machine start' on macOS)." >&2
  exit 2
fi

if ! podman image exists "$image"; then
  echo "[build-city-podman] image $image missing — building (one-off, ~5 min)…"
  podman build \
    -t "$image" \
    -f "$repo_root/Containerfile.city-build" \
    "$repo_root"
fi

# Run the build with the host repo bind-mounted; output is written straight
# into external/city/etc/ on the host, then copied into wasm-client/public/.
podman run --rm \
  -v "$repo_root:/work:Z" \
  -w /work \
  "$image" \
  "source /opt/emsdk/emsdk_env.sh >/dev/null && bash scripts/build-city-wasm.sh"
