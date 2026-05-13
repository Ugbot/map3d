import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    dts({
      insertTypesEntry: true,
    }),
    react({
      jsxImportSource: "@emotion/react",
      babel: {
        plugins: ["@emotion/babel-plugin"],
      },
    }),
  ],
  resolve: {
    alias: [{ find: "@", replacement: "/src" }],
  },
  server: {
    // Dev-only proxy. The Protomaps demo bucket (and many public PMTiles
    // hosts) ship without CORS headers, which blocks worker-side fetches
    // with Range. In production you should self-host the .pmtiles on a
    // CORS-enabled bucket and set VITE_PMTILES_URL.
    proxy: {
      "/pmtiles/protomaps": {
        target: "https://demo-bucket.protomaps.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/pmtiles\/protomaps/, ""),
      },
      // OpenSky returns Access-Control-Allow-Origin restricted to its own
      // domain; proxy it in dev. Production needs an equivalent proxy/backend.
      "/feeds/opensky": {
        target: "https://opensky-network.org",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/feeds\/opensky/, ""),
      },
    },
  },
});
