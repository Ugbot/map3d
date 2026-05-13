// Node entry point: boots the bitECS world, drives the simulation tick,
// runs feeds, and broadcasts keyframes over WebSocket. Tiger style: the
// FrameEncoder is allocated once with a hard capacity; every tick reuses it.

import {
  AISStreamFeed,
  computeSun,
  createMap3dWorld,
  feedCommitRemovalsSystem,
  feedExpireSystem,
  feedRemoveSystem,
  feedUpsertSystem,
  FrameEncoder,
  lonLatToMeters,
  OpenSkyFeed,
  simUpdateSystem,
  WorldState,
  type FeedEntity,
  type FeedSource,
} from "@map3d/data-core";
import { WsTransport, type ClientBbox } from "./WsTransport";

const PORT = Number(process.env.MAP3D_SERVER_PORT ?? 8787);
const TICK_HZ = Number(process.env.MAP3D_TICK_HZ ?? 30);
const SCENE_ORIGIN_LON = Number(process.env.MAP3D_ORIGIN_LON ?? -73.985);
const SCENE_ORIGIN_LAT = Number(process.env.MAP3D_ORIGIN_LAT ?? 40.758);
const FRAME_CAPACITY_BYTES = 1 << 20; // 1 MiB hard cap per frame
const ENTITY_CAP = 8192;

interface ServerState {
  world: ReturnType<typeof createMap3dWorld>;
  worldState: WorldState;
  encoder: FrameEncoder;
  transport: WsTransport;
  sources: FeedSource[];
  tickSeq: number;
  lastTickMs: number;
}

function start(): ServerState {
  const world = createMap3dWorld({
    entityCap: ENTITY_CAP,
    polylineCap: 4096,
    feedStaleMs: 5 * 60 * 1000,
    seed: 0xc0ffee,
  });
  const worldState = new WorldState(world);
  const encoder = new FrameEncoder(FRAME_CAPACITY_BYTES);
  const transport = new WsTransport({ port: PORT });

  const opensky = new OpenSkyFeed();
  const aisKey = process.env.AISSTREAM_KEY ?? null;
  const aisstream = new AISStreamFeed({ apiKey: aisKey });
  const sources: FeedSource[] = [opensky, aisstream];

  const sceneOrigin = lonLatToMeters(SCENE_ORIGIN_LON, SCENE_ORIGIN_LAT);
  for (const src of sources) {
    src.start((ev) => {
      if (ev.type === "update") handleFeedUpdate(world, ev.entity, sceneOrigin);
      else feedRemoveSystem(world, ev.id);
    });
  }
  // Seed initial bboxes around the configured origin so feeds start polling.
  const aircraftBbox = bboxAround(SCENE_ORIGIN_LAT, SCENE_ORIGIN_LON, 200);
  const vesselBbox = bboxAround(SCENE_ORIGIN_LAT, SCENE_ORIGIN_LON, 80);
  for (const src of sources) {
    if (src.kind === "aircraft") src.setRegion(aircraftBbox);
    if (src.kind === "vessel") src.setRegion(vesselBbox);
  }

  const state: ServerState = {
    world,
    worldState,
    encoder,
    transport,
    sources,
    tickSeq: 0,
    lastTickMs: Date.now(),
  };

  transport.onClient((c) => {
    // Send a keyframe immediately so the client renders something.
    try {
      const frame = state.worldState.produceKeyframe(state.encoder, state.tickSeq, Date.now());
      c.send(frame);
    } catch (err) {
      console.error("initial keyframe failed", err);
    }
  });

  const intervalMs = 1000 / TICK_HZ;
  setInterval(() => tick(state), intervalMs);

  console.log(
    `[data-server] tick=${TICK_HZ}Hz origin=${SCENE_ORIGIN_LAT},${SCENE_ORIGIN_LON} ws://0.0.0.0:${PORT}`,
  );
  return state;
}

function tick(state: ServerState): void {
  const now = Date.now();
  const dt = Math.min(0.25, (now - state.lastTickMs) / 1000);
  state.lastTickMs = now;
  simUpdateSystem(state.world, dt);
  feedExpireSystem(state.world, now);
  state.worldState.setEnv(computeSun(hourOfDay(now)));
  let frame: Uint8Array;
  try {
    frame = state.worldState.produceKeyframe(state.encoder, state.tickSeq++, now);
  } catch (err) {
    console.error("encode failed", err);
    return;
  }
  state.transport.publish(frame);
  feedCommitRemovalsSystem(state.world);
}

function handleFeedUpdate(
  world: ReturnType<typeof createMap3dWorld>,
  e: FeedEntity,
  sceneOrigin: { x: number; y: number },
): void {
  // The data-core feedUpsertSystem projects into scene metres; pass the
  // origin so we get matching coords to the simulated agents.
  // Aircraft altitude compression mirrors the existing renderer (12 km → 3 km).
  const altScale = e.kind === "aircraft" ? 3000 / 12000 : 1.0;
  feedUpsertSystem(world, e, { sceneOrigin, altitudeScale: altScale });
}

function bboxAround(lat: number, lon: number, padKm: number) {
  const dLat = padKm / 111;
  const dLon = padKm / (111 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon,
  };
}

function hourOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

const state = start();
process.on("SIGINT", () => {
  console.log("[data-server] shutting down");
  for (const s of state.sources) s.stop();
  state.transport.close();
  process.exit(0);
});
