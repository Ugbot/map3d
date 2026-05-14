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

/** Load /flecs/city.js and instantiate the runtime.
 *
 *  We support both Emscripten output shapes:
 *  - MODULARIZE=1 (bake's em target uses this): the script defines a global
 *    factory (`window.city`) that returns a Promise<Module> when invoked.
 *  - Plain script (no MODULARIZE): the glue reads `window.Module` at top
 *    level and calls `Module.onRuntimeInitialized` when ready.
 *
 *  The factory path is preferred because it lets us pass `canvas`, `print`,
 *  etc. as constructor args instead of side-effecting a global. */
function loadCityModule(): Promise<EmscriptenModule> {
  return new Promise((resolve, reject) => {
    const canvas = document.getElementById("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      reject(new Error("boot: #canvas missing or not a canvas"));
      return;
    }

    const moduleArg: Partial<EmscriptenModule> = {
      canvas,
      noInitialRun: false,
      print: (m: string) => console.log("[city]", m),
      printErr: (m: string) => console.warn("[city]", m),
      onAbort: (what: unknown) => reject(new Error("city abort: " + String(what))),
    };
    // Pre-install for the non-MODULARIZE branch.
    window.Module = { ...moduleArg };

    const s = document.createElement("script");
    s.src = CITY_JS_URL;
    s.async = true;
    s.onerror = () =>
      reject(
        new Error(
          `failed to load ${CITY_JS_URL} — run \`bake build\` in external/city and copy the artefacts into packages/wasm-client/public/flecs/`,
        ),
      );
    s.onload = () => {
      // MODULARIZE branch first: bake's em build defines `var city = ...`
      // at module scope. With Emscripten >= 3.x, that factory returns a
      // Promise<Module>.
      const factory = window.city;
      if (typeof factory === "function") {
        factory({ ...moduleArg })
          .then((m) => {
            if (typeof m.cwrap !== "function") {
              reject(new Error("city runtime ready but cwrap missing"));
              return;
            }
            resolve(m);
          })
          .catch(reject);
        return;
      }
      // Plain-script branch: the glue wires onRuntimeInitialized on the
      // pre-installed window.Module. Re-bind it now that the script has
      // executed (it may have replaced Module wholesale).
      const m = window.Module as EmscriptenModule | undefined;
      if (m == null) {
        reject(new Error("city.js loaded but window.Module is undefined"));
        return;
      }
      m.onRuntimeInitialized = () => {
        if (typeof m.cwrap !== "function") {
          reject(new Error("city runtime ready but cwrap missing"));
          return;
        }
        resolve(m);
      };
    };
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
