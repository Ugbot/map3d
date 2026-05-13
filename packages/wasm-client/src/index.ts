// Browser entry for the WASM client.
//
// Boot order (tiger style — explicit, sequenced, asserted):
//   1. Stake out the canvas and wire window.Module BEFORE loading city.js.
//   2. Inject /flecs/city.js as a classic <script>. Wait on a Promise that
//      resolves from Module.onRuntimeInitialized.
//   3. Construct FlecsBridge, call init().
//   4. Construct WsClient, point applyFrame at the bridge, set initial bbox.
//
// If /flecs/city.js or city.wasm are missing (no `bake build` has been run
// yet for external/city), we degrade to a "no engine" mode: the status badge
// turns orange and the WebSocket still connects so you can confirm the data
// pipeline. See public/flecs/README.md for build instructions.

import { FlecsBridge } from "./FlecsBridge";
import { WsClient, type Bbox, type WsState } from "./WsClient";
import type { EmscriptenModule } from "./types";

const CITY_JS_URL = "/flecs/city.js";
// Default bbox: a generous box around the data-server's NYC origin
// (packages/data-server/src/index.ts uses SCENE_ORIGIN_LAT/LON near NYC).
const DEFAULT_BBOX: Bbox = {
  minLat: 40,
  minLon: -74.5,
  maxLat: 41.5,
  maxLon: -73.5,
};

function buildWsUrl(): string {
  // Use same-origin so Vite's /ws proxy hands off to the data-server in dev.
  // In a static prod build, the user must put a reverse proxy at /ws.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function setStatus(state: WsState | "engine-missing", text?: string): void {
  const el = document.getElementById("status");
  const txt = document.getElementById("status-text");
  if (el == null || txt == null) return;
  el.setAttribute("data-state", state === "engine-missing" ? "error" : state);
  txt.textContent = text ?? state;
}

/** Load /flecs/city.js as a classic <script> and resolve once the
 *  Emscripten runtime has fired onRuntimeInitialized. The Promise rejects
 *  on script load error (e.g. the file hasn't been built yet). */
function loadCityModule(): Promise<EmscriptenModule> {
  return new Promise((resolve, reject) => {
    // Pre-install Module with our hooks. city.js (plain script build) reads
    // window.Module at top-level and merges; MODULARIZE=1 builds expose a
    // factory instead — we handle that branch below in onload.
    const canvas = document.getElementById("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      reject(new Error("boot: #canvas missing or not a canvas"));
      return;
    }

    const existing = (window.Module ?? {}) as Partial<EmscriptenModule>;
    const moduleStub: Partial<EmscriptenModule> = {
      ...existing,
      canvas,
      noInitialRun: false,
      print: (m: string) => console.log("[city]", m),
      printErr: (m: string) => console.warn("[city]", m),
      onAbort: (what: unknown) => reject(new Error("city abort: " + String(what))),
      onRuntimeInitialized: () => {
        // window.Module at this point is the fully-initialised runtime.
        const m = window.Module as EmscriptenModule | undefined;
        if (m == null || typeof m.cwrap !== "function") {
          reject(new Error("city runtime ready but cwrap missing"));
          return;
        }
        resolve(m);
      },
    };
    window.Module = moduleStub;

    const s = document.createElement("script");
    s.src = CITY_JS_URL;
    s.async = true;
    s.onerror = () =>
      reject(
        new Error(
          `failed to load ${CITY_JS_URL} — run \`bake build\` in external/city and copy the artefacts into packages/wasm-client/public/flecs/`,
        ),
      );
    document.head.appendChild(s);
  });
}

async function main(): Promise<void> {
  setStatus("connecting", "loading engine");

  let bridge: FlecsBridge | null = null;
  try {
    const mod = await loadCityModule();
    bridge = new FlecsBridge();
    bridge.init(mod);
    console.log("[boot] flecs bridge initialised");
  } catch (err) {
    console.error("[boot] engine load failed:", err);
    setStatus("engine-missing", "engine missing");
    // Continue without the bridge — useful for testing the wire pipeline.
  }

  const ws = new WsClient({
    url: buildWsUrl(),
    onFrame: (frame) => {
      if (bridge == null) return; // engine missing; nothing to drive.
      try {
        bridge.applyFrame(frame);
      } catch (err) {
        console.error("[applyFrame]", err);
      }
    },
    onState: (state) => {
      const detail =
        bridge == null && state === "open"
          ? "open — no engine"
          : state;
      setStatus(state, detail);
    },
  });

  ws.setBbox(DEFAULT_BBOX);
  ws.start();

  // Expose for ad-hoc poking in devtools. Not a stable API.
  (window as any).__map3d = { ws, bridge, setBbox: (b: Bbox) => ws.setBbox(b) };
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  setStatus("error", "boot failed");
});
