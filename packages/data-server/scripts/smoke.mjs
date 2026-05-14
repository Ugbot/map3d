// Bring up the data-server, connect a WebSocket client, capture the first
// keyframe, then send a SECTION_BBOX over Abu Dhabi and assert a TILE_BEGIN +
// (TILE_BUILDINGS|TILE_MESH) + TILE_END sequence comes back. Exits non-zero
// on any failure.

import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import {
  FRAME_KIND_BBOX,
  FRAME_KIND_KEYFRAME,
  FrameDecoder,
  FrameEncoder,
  SECTION_AGENTS,
  SECTION_ENV,
  SECTION_FEEDS,
  SECTION_TILE_BEGIN,
  SECTION_TILE_BUILDINGS,
  SECTION_TILE_END,
  SECTION_TILE_LANTERNS,
  SECTION_TILE_MESH,
  SECTION_TILE_PROPS,
  SECTION_TILE_RELEASE,
  readTileBegin,
  readTileBuildings,
  readTileMesh,
} from "@map3d/data-core";

const TIMEOUT_MS = 30_000;

const child = spawn(
  "pnpm",
  ["--filter", "@map3d/data-server", "exec", "tsx", "src/index.ts"],
  {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      MAP3D_SERVER_PORT: "8788",
      MAP3D_TICK_HZ: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverReady = false;
child.stdout.on("data", (b) => {
  const s = String(b);
  process.stderr.write(`[server] ${s}`);
  if (s.includes("ws://")) serverReady = true;
});
child.stderr.on("data", (b) => process.stderr.write(`[server-err] ${b}`));

async function waitReady() {
  const t0 = Date.now();
  while (!serverReady) {
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error("server never ready");
    await new Promise((r) => setTimeout(r, 50));
  }
}

let exitCode = 1;
try {
  await waitReady();
  const ws = new WebSocket("ws://127.0.0.1:8788");
  ws.binaryType = "arraybuffer";

  const state = {
    sawKeyframe: false,
    sawTileBegin: false,
    sawTileBody: false,
    sawTileEnd: false,
    inTile: false,
    bboxSent: false,
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("tile stream timeout")),
      TIMEOUT_MS,
    );

    ws.on("open", () => {
      // Send HELLO first (informational) — already implicit. Then send a
      // BBOX over Abu Dhabi to drive tile streaming.
      const enc = new FrameEncoder(256);
      enc.beginFrame(FRAME_KIND_BBOX, 0, Date.now());
      // Tight bbox around Abu Dhabi waterfront.
      enc.writeBboxSection(24.45, 54.35, 24.50, 54.40);
      const frame = enc.endFrame();
      ws.send(new Uint8Array(frame), { binary: true });
      state.bboxSent = true;
      console.log("[smoke] bbox sent");
    });

    ws.on("message", (data) => {
      try {
        const u8 = new Uint8Array(data);
        const dec = new FrameDecoder(u8);
        const hdr = dec.header();
        if (hdr.kind !== FRAME_KIND_KEYFRAME) return;
        let frameHasTile = false;
        dec.forEachSection((type, payload) => {
          if (type === SECTION_AGENTS || type === SECTION_FEEDS || type === SECTION_ENV) {
            state.sawKeyframe = true;
          } else if (type === SECTION_TILE_BEGIN) {
            const tk = readTileBegin(payload);
            state.sawTileBegin = true;
            state.inTile = true;
            frameHasTile = true;
            console.log(`[smoke] TILE_BEGIN ${tk.z}/${tk.x}/${tk.y}`);
          } else if (type === SECTION_TILE_BUILDINGS && state.inTile) {
            const recs = readTileBuildings(payload);
            state.sawTileBody = true;
            console.log(`[smoke] TILE_BUILDINGS n=${recs.length}`);
          } else if (type === SECTION_TILE_MESH && state.inTile) {
            const m = readTileMesh(payload);
            state.sawTileBody = true;
            console.log(
              `[smoke] TILE_MESH layer=${m.layerKind} verts=${m.positions.length / 3} tris=${m.indices.length / 3}`,
            );
          } else if (type === SECTION_TILE_LANTERNS && state.inTile) {
            state.sawTileBody = true;
          } else if (type === SECTION_TILE_PROPS && state.inTile) {
            state.sawTileBody = true;
          } else if (type === SECTION_TILE_END) {
            state.sawTileEnd = true;
            state.inTile = false;
            console.log("[smoke] TILE_END");
          } else if (type === SECTION_TILE_RELEASE) {
            // OK; ignore.
          }
        });
        if (
          state.sawKeyframe &&
          state.sawTileBegin &&
          state.sawTileBody &&
          state.sawTileEnd
        ) {
          clearTimeout(timer);
          console.log("[smoke] all sections ok");
          exitCode = 0;
          ws.close();
          resolve();
        }
        void frameHasTile;
      } catch (err) {
        console.error("[smoke] decode failure:", err);
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
} catch (err) {
  console.error("[smoke]", err);
} finally {
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
  process.exit(exitCode);
}
