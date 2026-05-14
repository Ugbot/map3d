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

// Tile-ring half-extent in latitude degrees at the default base zoom (~15).
// One MVT tile at z=15 spans roughly 1.2 km. A 0.04° box (~4.5 km on each
// side) gives the server enough centre to pick the right ring centre.
const BBOX_HALF_DEG = 0.04;

function bboxAround(lat: number, lon: number): Bbox {
  return {
    minLat: Math.max(-85, lat - BBOX_HALF_DEG),
    maxLat: Math.min(85, lat + BBOX_HALF_DEG),
    minLon: Math.max(-180, lon - BBOX_HALF_DEG),
    maxLon: Math.min(180, lon + BBOX_HALF_DEG),
  };
}

const DEFAULT_LAT = 24.4539;
const DEFAULT_LON = 54.3773;
const DEFAULT_BBOX: Bbox = bboxAround(DEFAULT_LAT, DEFAULT_LON);

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

  wireOriginPanel(ws, bridge);
  wirePointerLook(bridge);
  wireStatsHud(bridge, ws);

  // Expose for ad-hoc poking in devtools. Not a stable API.
  (window as any).__map3d = { ws, bridge, setBbox: (b: Bbox) => ws.setBbox(b) };
}

/** Camera defaults — bird's-eye over the streamed tile cluster. Keep in sync
 *  with the values in external/city/etc/assets/app.flecs so a "reset" matches
 *  the initial WASM camera. */
const CAM_HOME = { x: 0, y: 600, z: 600, yaw: 0, pitch: -0.6 } as const;

/** Mouse-drag rotation: ~0.17° per CSS pixel. Feels about right for a 60° FOV. */
const POINTER_RAD_PER_PX = 0.003;

/** Hook up the lat/lon panel: on submit (or preset click) compute a fresh
 *  bbox, wipe the bridge's existing tiles so the previous map doesn't ghost
 *  during the swap, and send the new bbox to the server. */
function wireOriginPanel(ws: WsClient, bridge: FlecsBridge | null): void {
  const form = document.getElementById("origin-panel") as HTMLFormElement | null;
  const latIn = document.getElementById("origin-lat") as HTMLInputElement | null;
  const lonIn = document.getElementById("origin-lon") as HTMLInputElement | null;
  const info = document.getElementById("origin-info") as HTMLElement | null;
  if (form == null || latIn == null || lonIn == null) return;

  const apply = (lat: number, lon: number, name?: string): void => {
    if (!Number.isFinite(lat) || lat < -85 || lat > 85) return;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return;
    latIn.value = lat.toFixed(4);
    lonIn.value = lon.toFixed(4);
    if (info != null) info.textContent = name ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    bridge?.releaseAllTiles();
    bridge?.setCamera(CAM_HOME.x, CAM_HOME.y, CAM_HOME.z, CAM_HOME.yaw, CAM_HOME.pitch);
    ws.setBbox(bboxAround(lat, lon));
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    apply(parseFloat(latIn.value), parseFloat(lonIn.value));
  });

  const presets = document.getElementById("origin-presets");
  if (presets != null) {
    presets.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLButtonElement)) return;
      const lat = parseFloat(t.getAttribute("data-lat") ?? "");
      const lon = parseFloat(t.getAttribute("data-lon") ?? "");
      const name = t.getAttribute("data-name") ?? undefined;
      apply(lat, lon, name);
    });
  }
}

/** Mouse-drag look. The Flecs CameraController already handles WASD/QE/
 *  arrows via sokol_app's keyboard hooks; pointer events are not wired into
 *  EcsInput on the C side, so we drive rotation directly through the bridge. */
function wirePointerLook(bridge: FlecsBridge | null): void {
  if (bridge == null) return;
  const canvas = document.getElementById("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // left only
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // Yaw left+ = look right, pitch up+ = look down — match flecs.game's
    // convention where Rotation3.x is pitch and Rotation3.y is yaw.
    bridge.cameraRotateDelta(-dx * POINTER_RAD_PER_PX, -dy * POINTER_RAD_PER_PX);
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // already released — ignore
    }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

/** Stats panel + 5s console summary. Driven by requestAnimationFrame for
 *  smooth FPS; bridge.worldInfo() is polled once per second for the C-side
 *  frame_count and entity_count. */
function wireStatsHud(bridge: FlecsBridge | null, ws: WsClient): void {
  const $ = (id: string) => document.getElementById(id);
  const elFps = $("stat-fps");
  const elFrames = $("stat-frames");
  const elEntities = $("stat-entities");
  const elTiles = $("stat-tiles");
  const elBuildings = $("stat-buildings");
  const elMeshes = $("stat-meshes");
  const elLanterns = $("stat-lanterns");
  const elProps = $("stat-props");
  const elWs = $("stat-ws");

  let lastRafMs = performance.now();
  let emaFps = 0;          // exponential moving average over ~1 s
  let lastInfoPollMs = 0;
  let lastConsoleMs = 0;
  let bridgeFrames = 0;
  let bridgeEntities = 0;

  const fmt = (n: number): string => {
    if (!Number.isFinite(n)) return "—";
    if (n >= 10_000) return n.toLocaleString();
    return String(n);
  };

  const setText = (el: Element | null, text: string): void => {
    if (el == null) return;
    if (el.textContent !== text) el.textContent = text;
  };

  const tick = (nowMs: number): void => {
    const dt = Math.max(1, nowMs - lastRafMs);
    lastRafMs = nowMs;
    const instFps = 1000 / dt;
    // First sample seeds the average; afterwards smooth with α tuned to ~1 s.
    const alpha = Math.min(0.2, dt / 1000);
    emaFps = emaFps > 0 ? emaFps + alpha * (instFps - emaFps) : instFps;

    if (bridge != null && nowMs - lastInfoPollMs > 500) {
      lastInfoPollMs = nowMs;
      try {
        const info = bridge.worldInfo();
        bridgeFrames = info.frameCount;
        bridgeEntities = info.entityCount;
      } catch {
        // bridge not ready yet
      }
    }

    setText(elFps, emaFps.toFixed(1));
    setText(elFrames, fmt(bridge ? bridgeFrames : 0));
    setText(elEntities, fmt(bridge ? bridgeEntities : 0));
    setText(elTiles, bridge ? `${bridge.totalTilesBegun}` : "0");
    setText(elBuildings, fmt(bridge?.totalBuildings ?? 0));
    setText(elMeshes, fmt(bridge?.totalMeshes ?? 0));
    setText(elLanterns, fmt(bridge?.totalLanterns ?? 0));
    setText(elProps, fmt(bridge?.totalProps ?? 0));
    setText(elWs, ws.getState());

    if (nowMs - lastConsoleMs > 5000) {
      lastConsoleMs = nowMs;
      console.log(
        "[stats] fps=%s frames=%s entities=%s tiles=%s buildings=%s meshes=%s ws=%s",
        emaFps.toFixed(1),
        fmt(bridgeFrames),
        fmt(bridgeEntities),
        bridge ? bridge.totalTilesBegun : 0,
        fmt(bridge?.totalBuildings ?? 0),
        fmt(bridge?.totalMeshes ?? 0),
        ws.getState(),
      );
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  setStatus("error", "boot failed");
});
