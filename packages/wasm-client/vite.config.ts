// Vite config for the WASM client.
//
// Tiger style: minimal config, explicit ports, hard-coded dev proxy target
// matching the data-server's default (packages/data-server/src/index.ts: PORT=8787).
// COOP/COEP are set so SharedArrayBuffer is available (needed if the Emscripten
// build is later compiled with -pthread). Headers are also applied to preview.
import { defineConfig } from "vite";

const COOP_COEP_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    headers: COOP_COEP_HEADERS,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
        changeOrigin: true,
        // The server accepts WebSocket upgrades on the root path.
        rewrite: (p) => p.replace(/^\/ws/, ""),
      },
    },
  },
  preview: {
    port: 5174,
    strictPort: true,
    headers: COOP_COEP_HEADERS,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
  },
  // Don't try to bundle /flecs/city.js — it's loaded at runtime as a plain script.
  optimizeDeps: {
    exclude: ["/flecs/city.js"],
  },
});
