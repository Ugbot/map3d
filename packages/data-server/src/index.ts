// Node entry point: boots the bitECS world, drives the simulation tick,
// runs feeds, fetches and parses PMTiles per client, and ships per-client
// keyframes containing shared world sections plus client-specific TILE_*
// sections. Tiger style: every per-client FrameEncoder is preallocated with a
// hard capacity and reused every tick.

import {
  AISStreamFeed,
  computeSun,
  createMap3dWorld,
  feedCommitRemovalsSystem,
  feedExpireSystem,
  feedRemoveSystem,
  feedUpsertSystem,
  FRAME_KIND_KEYFRAME,
  FrameEncoder,
  lonLatToMeters,
  OpenSkyFeed,
  simUpdateSystem,
  WorldState,
  type FeedEntity,
  type FeedSource,
} from "@map3d/data-core";
import { WsTransport, type WsClientHandle, type ClientBbox } from "./WsTransport";
import { TileService } from "./TileService";

const PORT = Number(process.env.MAP3D_SERVER_PORT ?? 8787);
const TICK_HZ = Number(process.env.MAP3D_TICK_HZ ?? 30);
const SCENE_ORIGIN_LON = Number(process.env.MAP3D_ORIGIN_LON ?? -73.985);
const SCENE_ORIGIN_LAT = Number(process.env.MAP3D_ORIGIN_LAT ?? 40.758);
const FRAME_CAPACITY_BYTES = 4 * 1024 * 1024; // 4 MiB per-client frame
const ENTITY_CAP = 8192;
const PMTILES_URL = process.env.MAP3D_PMTILES_URL ?? "https://demo-bucket.protomaps.com/v4.pmtiles";

interface PerClient {
  handle: WsClientHandle;
  encoder: FrameEncoder;
  origin: { lon: number; lat: number };
}

interface ServerState {
  world: ReturnType<typeof createMap3dWorld>;
  worldState: WorldState;
  transport: WsTransport;
  tileService: TileService;
  sources: FeedSource[];
  tickSeq: number;
  lastTickMs: number;
  perClient: Map<string, PerClient>;
}

function start(): ServerState {
  const world = createMap3dWorld({
    entityCap: ENTITY_CAP,
    polylineCap: 131_072,
    feedStaleMs: 5 * 60 * 1000,
    seed: 0xc0ffee,
  });
  const worldState = new WorldState(world);
  const transport = new WsTransport({ port: PORT });
  const tileService = new TileService({
    pmtilesUrl: PMTILES_URL,
    schema: "protomaps-v4",
    baseZoom: 15,
    ringRadius: 2,
    maxBatchesPerTick: 4,
  });

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
  const aircraftBbox = bboxAround(SCENE_ORIGIN_LAT, SCENE_ORIGIN_LON, 200);
  const vesselBbox = bboxAround(SCENE_ORIGIN_LAT, SCENE_ORIGIN_LON, 80);
  for (const src of sources) {
    if (src.kind === "aircraft") src.setRegion(aircraftBbox);
    if (src.kind === "vessel") src.setRegion(vesselBbox);
  }

  const state: ServerState = {
    world,
    worldState,
    transport,
    tileService,
    sources,
    tickSeq: 0,
    lastTickMs: Date.now(),
    perClient: new Map(),
  };

  transport.onClient((c) => {
    const handle = c as WsClientHandle;
    const pc: PerClient = {
      handle,
      encoder: new FrameEncoder(FRAME_CAPACITY_BYTES),
      origin: { lon: SCENE_ORIGIN_LON, lat: SCENE_ORIGIN_LAT },
    };
    state.perClient.set(handle.id, pc);
    tileService.registerClient(handle.id, {
      origin: { lon: SCENE_ORIGIN_LON, lat: SCENE_ORIGIN_LAT },
    });
    handle.onBbox((b: ClientBbox) => onClientBbox(state, handle.id, b));
    handle.onClose(() => {
      state.perClient.delete(handle.id);
      tileService.unregisterClient(handle.id);
    });
    // Send the initial keyframe immediately so the client renders something
    // even before the first tick.
    try {
      const frame = worldState.produceKeyframe(pc.encoder, state.tickSeq, Date.now());
      // Take ownership before we reuse the encoder buffer.
      handle.send(new Uint8Array(frame));
    } catch (err) {
      console.error("initial keyframe failed", err);
    }
  });

  const intervalMs = 1000 / TICK_HZ;
  setInterval(() => tick(state), intervalMs);

  console.log(
    `[data-server] tick=${TICK_HZ}Hz origin=${SCENE_ORIGIN_LAT},${SCENE_ORIGIN_LON} pmtiles=${PMTILES_URL} ws://0.0.0.0:${PORT}`,
  );
  return state;
}

function tick(state: ServerState): void {
  const now = Date.now();
  const dt = Math.min(0.25, Math.max(0, (now - state.lastTickMs) / 1000));
  state.lastTickMs = now;
  simUpdateSystem(state.world, dt);
  feedExpireSystem(state.world, now);
  state.worldState.setEnv(computeSun(hourOfDay(now)));
  const seq = state.tickSeq++;

  // Frame A: world keyframe — same shared content for every client, but we
  // emit one per client so per-client FrameEncoders remain isolated (and so
  // any future per-client filtering of agents/feeds slots in naturally).
  for (const [clientId, pc] of state.perClient) {
    try {
      const frame = state.worldState.produceKeyframe(pc.encoder, seq, now);
      pc.handle.send(new Uint8Array(frame));
    } catch (err) {
      console.error("world encode failed", { clientId, err });
    }
  }

  // Frame B: per-client tile streaming — only sent if the tile service
  // actually emitted at least one section for *that* client this tick.
  for (const [, pc] of state.perClient) {
    try {
      pc.encoder.beginFrame(FRAME_KIND_KEYFRAME, seq, now);
    } catch (err) {
      console.error("tile frame open failed", err);
    }
  }
  const wrote = state.tileService.tickAndEncode((id) => {
    const pc = state.perClient.get(id);
    if (!pc) throw new Error(`unknown client ${id}`);
    return pc.encoder;
  });
  for (const [clientId, pc] of state.perClient) {
    try {
      const frame = pc.encoder.endFrame();
      if (wrote.has(clientId)) pc.handle.send(new Uint8Array(frame));
    } catch (err) {
      console.error("tile frame close failed", { clientId, err });
    }
  }

  feedCommitRemovalsSystem(state.world);
}

function onClientBbox(state: ServerState, clientId: string, b: ClientBbox): void {
  if (!state.tileService.hasClient(clientId)) return;
  const centerLon = (b.minLon + b.maxLon) * 0.5;
  const centerLat = (b.minLat + b.maxLat) * 0.5;
  // Clamp to valid mercator range — guards against malformed client traffic.
  if (centerLat < -85 || centerLat > 85) return;
  if (centerLon < -180 || centerLon > 180) return;
  state.tileService.updateClientOrigin(clientId, centerLon, centerLat);
}

function handleFeedUpdate(
  world: ReturnType<typeof createMap3dWorld>,
  e: FeedEntity,
  sceneOrigin: { x: number; y: number },
): void {
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
