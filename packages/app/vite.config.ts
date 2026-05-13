import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";

// https://vitejs.dev/config/
export default defineConfig({
  base: "./",
  resolve: {
    alias: [{ find: "@", replacement: "/src" }],
  },
  // Three's WebGPU dev bundle has a single `import 'https://greggman.../...js'`
  // diagnostic line that breaks Vite's pre-bundle step. Tiny plugin below
  // strips it on the fly so we get the unminified bundle for proper stack
  // traces in dev.
  // ESM identity trap: when Vite pre-bundles "three" but ships "three/webgpu"
  // unbundled, the two paths each pull in their own copy of three.core, so
  // `THREE.DirectionalLight` ≠ the class registered with the WebGPU node
  // library. Exclude every Three entry-point so they share one resolution.
  optimizeDeps: {
    exclude: ["three", "three/webgpu", "three/tsl"],
  },
  plugins: [
    dts({ insertTypesEntry: true }),
    react({
      jsxImportSource: "@emotion/react",
      babel: { plugins: ["@emotion/babel-plugin"] },
    }),
    {
      name: "strip-three-webgpu-diagnostic-import",
      transform(code, id) {
        if (id.includes("three.webgpu.js") || id.includes("three.tsl.js")) {
          return code.replace(
            /import\s+["']https:\/\/greggman[^"']+["'];?/g,
            "/* removed: webgpu diagnostic remote import */",
          );
        }
        return null;
      },
    },
  ],
  server: {
    proxy: {
      // Protomaps demo bucket has no CORS — proxy in dev.
      "/pmtiles/protomaps": {
        target: "https://demo-bucket.protomaps.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/pmtiles\/protomaps/, ""),
      },
      // OpenSky returns Access-Control-Allow-Origin restricted to its own
      // domain; proxy in dev. Production needs an equivalent proxy.
      "/feeds/opensky": {
        target: "https://opensky-network.org",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/feeds\/opensky/, ""),
      },
    },
  },
});
