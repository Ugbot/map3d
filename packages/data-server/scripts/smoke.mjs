// Bring up the data-server, connect a WebSocket client, capture the first
// frame, and assert it decodes correctly. Exits non-zero on any failure.

import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import {
  FRAME_KIND_KEYFRAME,
  FrameDecoder,
  SECTION_AGENTS,
  SECTION_ENV,
  SECTION_FEEDS,
} from "@map3d/data-core";

const TIMEOUT_MS = 10_000;

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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame")), TIMEOUT_MS);
    ws.on("message", (data) => {
      clearTimeout(timer);
      try {
        const u8 = new Uint8Array(data);
        const dec = new FrameDecoder(u8);
        const hdr = dec.header();
        if (hdr.kind !== FRAME_KIND_KEYFRAME) throw new Error(`kind ${hdr.kind}`);
        const seen = new Set();
        dec.forEachSection((type) => {
          seen.add(type);
        });
        if (!seen.has(SECTION_AGENTS)) throw new Error("no agents section");
        if (!seen.has(SECTION_FEEDS)) throw new Error("no feeds section");
        // ENV may or may not be present yet on first frame.
        void SECTION_ENV;
        console.log(`[smoke] frame ok: ${u8.byteLength} bytes, sections=${[...seen]}`);
        exitCode = 0;
      } catch (err) {
        console.error("[smoke] frame check failed:", err);
      }
      ws.close();
      resolve();
    });
    ws.on("error", reject);
  });
} catch (err) {
  console.error("[smoke]", err);
} finally {
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
  process.exit(exitCode);
}
