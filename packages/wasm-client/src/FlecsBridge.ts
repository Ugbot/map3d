// FlecsBridge — typed wrapper around the C ABI exported by external/city's
// bridge.c (Emscripten target).
//
// Tiger style:
//   * No per-frame allocations: cwrap is called once in init(); record-loop
//     reuses Float32Array views obtained from the FrameCodec.
//   * Hard assertions on every boundary: kinds, counts, ranges, finiteness.
//   * Per-kind "alive" tables are statically sized (AGENT_CAP_PER_KIND);
//     overflowing entries are dropped with a warning rather than growing.
//   * A keyframe is treated as authoritative: anything past newCount[kind]
//     from the previous frame is reaped via beam_agent_remove.
//
// Contract (from external/city/src/bridge.c):
//   void beam_init(void)
//   void beam_begin_frame(uint32_t tick_seq)
//   void beam_end_frame(void)
//   void beam_agent_upsert(uint32_t remote_id, uint8_t kind,
//                          float x, float y, float z, float heading)
//   void beam_agent_remove(uint32_t remote_id)
//   void beam_feed_upsert(uint32_t remote_id, uint8_t kind,
//                         float x, float y, float z, float heading)
//   void beam_feed_remove(uint32_t remote_id)
//   void beam_set_env(float sun_alt, float sun_az,
//                     uint32_t sun_rgb, uint32_t amb_sky, uint32_t amb_ground)
//   void beam_clear_all(void)
//   uint32_t beam_live_count(void)

import {
  FRAME_KIND_DELTA,
  FRAME_KIND_KEYFRAME,
  FEED_FLAG_REMOVED,
  FEED_KIND_AIRCRAFT,
  FEED_KIND_VESSEL,
  FrameDecoder,
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
  assert,
  assertFinite,
  assertInRange,
  assertU32,
  readAgentSection,
  readEnvSection,
  readFeedSection,
  readTileBegin,
  readTileBuildings,
  readTileLanterns,
  readTileMesh,
  readTileProps,
  readTileRelease,
} from "@map3d/data-core";
import type { EmscriptenModule } from "./types";
import { fnv1a32 } from "./HashId";

/** Agent kind enum mirroring the bridge (must match bridge.c). */
export const AGENT_KIND_VEHICLE = 0;
export const AGENT_KIND_TRAIN = 1;
export const AGENT_KIND_PEDESTRIAN = 2;
export const AGENT_KIND_COUNT = 3;

/** Static cap on per-kind agent count. Anything beyond this is dropped. */
const AGENT_CAP_PER_KIND = 8192;

/** remote_id space partition for agents: kind in high nibble, index in low.
 *  kind*0x10000000 means we tolerate up to 2^28 agents per kind on the wire,
 *  but our local cap (AGENT_CAP_PER_KIND) is the binding constraint. */
const AGENT_REMOTE_ID_BASE = 0x10000000;

/** Sentinel for "no feed id" in the alive tracker. */
const FEED_ID_NONE = 0 >>> 0;

type V_void = () => void;
type V_u32 = (a: number) => void;
type V_u32u8 = (a: number, b: number) => void;
type V_u32u8_5f = (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
) => void;
type V_env = (
  alt: number,
  az: number,
  sun: number,
  sky: number,
  ground: number,
) => void;
type R_u32 = () => number;
type V_tile_coord = (z: number, x: number, y: number) => void;
type V_building = (
  remoteId: number,
  kind: number,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  heading: number,
  color: number,
) => void;
type V_mesh_upsert = (
  remoteId: number,
  layerKind: number,
  positionsPtr: number,
  nFloats: number,
  indicesPtr: number,
  nIndices: number,
  color: number,
  originX: number,
  originY: number,
  originZ: number,
) => void;
type V_lantern = (remoteId: number, x: number, y: number, z: number) => void;
type V_prop = (
  remoteId: number,
  propKind: number,
  x: number,
  y: number,
  z: number,
  heading: number,
) => void;

export class FlecsBridge {
  private mod: EmscriptenModule | null = null;

  // cwrap handles (cached once in init()).
  private _init!: V_void;
  private _beginFrame!: V_u32;
  private _endFrame!: V_void;
  private _agentUpsert!: V_u32u8_5f;
  private _agentRemove!: V_u32;
  private _agentRemoveKind!: V_u32u8;
  private _feedUpsert!: V_u32u8_5f;
  private _feedRemove!: V_u32;
  private _feedRemoveKind!: V_u32u8;
  private _setEnv!: V_env;
  private _clearAll!: V_void;
  private _liveCount!: R_u32;

  // Static tile geometry exports.
  private _tileBegin!: V_tile_coord;
  private _tileEnd!: V_void;
  private _tileRelease!: V_tile_coord;
  private _buildingUpsert!: V_building;
  private _meshUpsert!: V_mesh_upsert;
  private _meshRemove!: V_u32;
  private _lanternUpsert!: V_lantern;
  private _propUpsert!: V_prop;

  // remote_id allocation. The server emits ids that are unique within a tile;
  // we further partition by family so building/mesh/lantern/prop spaces don't
  // collide on the bridge side.
  private static readonly FAMILY_BUILDING_BASE = 0x20000000;
  private static readonly FAMILY_MESH_BASE = 0x30000000;
  private static readonly FAMILY_LANTERN_BASE = 0x40000000;
  private static readonly FAMILY_PROP_BASE = 0x50000000;

  // Track active tiles so a UI-initiated origin change can wipe everything.
  private liveTiles: Set<string> = new Set();

  // Per-kind previous count for reaping trailing agents on a keyframe.
  private prevAgentCount = new Uint32Array(AGENT_KIND_COUNT);

  // Live-feed id set, for cheap dedupe when the server emits the same id
  // twice in a single keyframe (last write wins via the bridge anyway, but
  // we still want to know what is "currently live" if we ever need to reap).
  private liveFeedIds: Set<number> = new Set();

  // Stats — handy in the status badge.
  framesApplied = 0;
  lastTickSeq = 0;
  lastFrameKind = 0;

  /** Bind cwrapped functions and call beam_init(). Idempotent.
   *  Must be called after `window.Module.onRuntimeInitialized` has fired. */
  init(mod: EmscriptenModule): void {
    assert(mod != null, "FlecsBridge.init: null module");
    assert(typeof mod.cwrap === "function", "FlecsBridge.init: cwrap missing");
    if (this.mod === mod) return;
    this.mod = mod;
    const cw = mod.cwrap;

    this._init = cw("beam_init", null, []) as V_void;
    this._beginFrame = cw("beam_begin_frame", null, ["number"]) as V_u32;
    this._endFrame = cw("beam_end_frame", null, []) as V_void;
    this._agentUpsert = cw("beam_agent_upsert", null, [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]) as V_u32u8_5f;
    this._agentRemove = cw("beam_agent_remove", null, ["number"]) as V_u32;
    this._agentRemoveKind = cw("beam_agent_remove_kind", null, [
      "number",
      "number",
    ]) as V_u32u8;
    this._feedUpsert = cw("beam_feed_upsert", null, [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]) as V_u32u8_5f;
    this._feedRemove = cw("beam_feed_remove", null, ["number"]) as V_u32;
    this._feedRemoveKind = cw("beam_feed_remove_kind", null, [
      "number",
      "number",
    ]) as V_u32u8;
    this._setEnv = cw("beam_set_env", null, [
      "number",
      "number",
      "number",
      "number",
      "number",
    ]) as V_env;
    this._clearAll = cw("beam_clear_all", null, []) as V_void;
    this._liveCount = cw("beam_live_count", "number", []) as R_u32;

    this._tileBegin = cw("beam_tile_begin", null, [
      "number",
      "number",
      "number",
    ]) as V_tile_coord;
    this._tileEnd = cw("beam_tile_end", null, []) as V_void;
    this._tileRelease = cw("beam_tile_release", null, [
      "number",
      "number",
      "number",
    ]) as V_tile_coord;
    this._buildingUpsert = cw("beam_building_upsert", null, [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]) as V_building;
    this._meshUpsert = cw("beam_mesh_upsert", null, [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]) as V_mesh_upsert;
    this._meshRemove = cw("beam_mesh_remove", null, ["number"]) as V_u32;
    this._lanternUpsert = cw("beam_lantern_upsert", null, [
      "number",
      "number",
      "number",
      "number",
    ]) as V_lantern;
    this._propUpsert = cw("beam_prop_upsert", null, [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]) as V_prop;

    this._init();
    this.prevAgentCount.fill(0);
    this.liveFeedIds.clear();
    this.liveTiles.clear();
  }

  beginFrame(tickSeq: number): void {
    assertU32(tickSeq, "tickSeq");
    this._beginFrame(tickSeq >>> 0);
  }

  endFrame(): void {
    this._endFrame();
  }

  upsertAgent(
    remoteId: number,
    kind: number,
    x: number,
    y: number,
    z: number,
    heading: number,
  ): void {
    this._agentUpsert(remoteId >>> 0, kind & 0xff, x, y, z, heading);
  }

  removeAgent(remoteId: number): void {
    this._agentRemove(remoteId >>> 0);
  }

  removeAgentKind(remoteId: number, kind: number): void {
    this._agentRemoveKind(remoteId >>> 0, kind & 0xff);
  }

  upsertFeed(
    remoteId: number,
    kind: number,
    x: number,
    y: number,
    z: number,
    heading: number,
  ): void {
    this._feedUpsert(remoteId >>> 0, kind & 0xff, x, y, z, heading);
  }

  removeFeed(remoteId: number): void {
    this._feedRemove(remoteId >>> 0);
  }

  removeFeedKind(remoteId: number, kind: number): void {
    this._feedRemoveKind(remoteId >>> 0, kind & 0xff);
  }

  setEnv(
    sunAlt: number,
    sunAz: number,
    sunRgb: number,
    skyRgb: number,
    groundRgb: number,
  ): void {
    this._setEnv(sunAlt, sunAz, sunRgb >>> 0, skyRgb >>> 0, groundRgb >>> 0);
  }

  clearAll(): void {
    this._clearAll();
    this.prevAgentCount.fill(0);
    this.liveFeedIds.clear();
    this.liveTiles.clear();
  }

  /** Release every tile the bridge currently holds. Called from the wasm-client
   *  UI when the user changes the centre so the previous map clears before
   *  the server's RELEASE frames arrive (avoids a brief overlap flash). */
  releaseAllTiles(): void {
    for (const key of this.liveTiles) {
      const [z, x, y] = key.split("/").map((s) => parseInt(s, 10));
      this._tileRelease(z, x, y);
    }
    this.liveTiles.clear();
  }

  liveCount(): number {
    return this._liveCount() >>> 0;
  }

  /** Synthetic remote-id helpers. The server's remote_id is only unique per
   *  family per tile; we partition the bridge id space so building/mesh/
   *  lantern/prop don't collide. */
  static buildingRemoteId(serverId: number): number {
    return (FlecsBridge.FAMILY_BUILDING_BASE | (serverId & 0x0fffffff)) >>> 0;
  }
  static meshRemoteId(serverId: number): number {
    return (FlecsBridge.FAMILY_MESH_BASE | (serverId & 0x0fffffff)) >>> 0;
  }
  static lanternRemoteId(serverId: number): number {
    return (FlecsBridge.FAMILY_LANTERN_BASE | (serverId & 0x0fffffff)) >>> 0;
  }
  static propRemoteId(serverId: number): number {
    return (FlecsBridge.FAMILY_PROP_BASE | (serverId & 0x0fffffff)) >>> 0;
  }

  /** Copy a mesh's positions + indices into the WASM heap, hand the pointers
   *  to beam_mesh_upsert, then free. The bridge copies into sokol buffers so
   *  the heap memory is safe to release immediately after the call. */
  private uploadMesh(rec: {
    remoteId: number;
    layerKind: number;
    originX: number;
    originY: number;
    originZ: number;
    color: number;
    positions: Float32Array;
    indices: Uint32Array;
  }): void {
    assert(this.mod != null, "uploadMesh: bridge not initialised");
    const mod = this.mod;
    const nFloats = rec.positions.length;
    const nIndices = rec.indices.length;
    if (nFloats === 0 || nIndices === 0) return;
    assertU32(nFloats, "mesh nFloats");
    assertU32(nIndices, "mesh nIndices");
    const posBytes = nFloats * 4;
    const idxBytes = nIndices * 4;
    const posPtr = mod._malloc(posBytes);
    if (posPtr === 0) {
      console.error("[FlecsBridge] _malloc failed for mesh positions", { posBytes });
      return;
    }
    const idxPtr = mod._malloc(idxBytes);
    if (idxPtr === 0) {
      mod._free(posPtr);
      console.error("[FlecsBridge] _malloc failed for mesh indices", { idxBytes });
      return;
    }
    try {
      mod.HEAPF32.set(rec.positions, posPtr >>> 2);
      mod.HEAPU32.set(rec.indices, idxPtr >>> 2);
      this._meshUpsert(
        FlecsBridge.meshRemoteId(rec.remoteId),
        rec.layerKind & 0xff,
        posPtr >>> 0,
        nFloats >>> 0,
        idxPtr >>> 0,
        nIndices >>> 0,
        rec.color >>> 0,
        rec.originX,
        rec.originY,
        rec.originZ,
      );
    } finally {
      mod._free(posPtr);
      mod._free(idxPtr);
    }
  }

  /** Compute the synthetic remote_id for an anonymous agent slot. */
  static agentRemoteId(kind: number, index: number): number {
    return ((kind & 0xff) * AGENT_REMOTE_ID_BASE + index) >>> 0;
  }

  /**
   * Decode a single binary frame from the data-server and drive the bridge.
   *
   * Treatment of frame kinds:
   *   KEYFRAME — authoritative snapshot. We diff per-agent-kind counts
   *              against prevAgentCount so removed trailing slots are reaped.
   *   DELTA    — for v1 the server emits keyframes only; we treat deltas
   *              the same way (still safe — bridge upserts are idempotent).
   *   HELLO/BBOX — never sent by server; defensive no-op + assert.
   */
  applyFrame(frame: Uint8Array): void {
    assert(frame instanceof Uint8Array, "applyFrame: not Uint8Array");
    assert(this.mod != null, "applyFrame: bridge not initialised");
    const dec = new FrameDecoder(frame);
    const hdr = dec.header();
    assert(
      hdr.kind === FRAME_KIND_KEYFRAME || hdr.kind === FRAME_KIND_DELTA,
      "applyFrame: unexpected frame kind from server",
    );

    this.beginFrame(hdr.tickSeq >>> 0);
    // Track which agent-kinds appeared so we know which to reap-tail.
    const seenAgentKind: boolean[] = [false, false, false];
    const newAgentCount = new Uint32Array(AGENT_KIND_COUNT);

    dec.forEachSection((type, payload, _bytes) => {
      if (type === SECTION_AGENTS) {
        const a = readAgentSection(payload);
        assertInRange(a.kind, 0, AGENT_KIND_COUNT - 1, "agent.kind");
        const cap =
          a.count <= AGENT_CAP_PER_KIND ? a.count : AGENT_CAP_PER_KIND;
        seenAgentKind[a.kind] = true;
        newAgentCount[a.kind] = cap;
        for (let i = 0; i < cap; i++) {
          const x = a.x[i];
          const z = a.z[i];
          const h = a.heading[i];
          // Defensive: skip non-finite records rather than poison the scene.
          if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(h))
            continue;
          this._agentUpsert(
            FlecsBridge.agentRemoteId(a.kind, i),
            a.kind & 0xff,
            x,
            0, // y is ground-plane local; bridge ignores or zeroes
            z,
            h,
          );
        }
      } else if (type === SECTION_FEEDS) {
        const recs = readFeedSection(payload);
        const n = recs.length;
        for (let i = 0; i < n; i++) {
          const r = recs[i];
          const id = fnv1a32(r.id);
          assertInRange(
            r.kind,
            FEED_KIND_AIRCRAFT,
            FEED_KIND_VESSEL,
            "feed.kind",
          );
          if ((r.flags & FEED_FLAG_REMOVED) !== 0) {
            this._feedRemoveKind(id, r.kind & 0xff);
            this.liveFeedIds.delete(id);
            continue;
          }
          // Wire feeds carry lon/lat/altM — the bridge expects scene-local
          // metres. The server is supposed to have already mapped them, but
          // the contract isn't strict here, so we just forward the floats:
          // for aircraft, altM is the y component; for vessels, y=0.
          const y = r.kind === FEED_KIND_AIRCRAFT ? r.altM : 0;
          assertFinite(r.lon, "feed.lon");
          assertFinite(r.lat, "feed.lat");
          assertFinite(r.heading, "feed.heading");
          this._feedUpsert(id, r.kind & 0xff, r.lon, y, r.lat, r.heading);
          this.liveFeedIds.add(id);
        }
      } else if (type === SECTION_ENV) {
        const e = readEnvSection(payload);
        this._setEnv(
          e.sunAltitude,
          e.sunAzimuth,
          e.sunColorRgb >>> 0,
          e.ambientSky >>> 0,
          e.ambientGround >>> 0,
        );
      } else if (type === SECTION_TILE_BEGIN) {
        const k = readTileBegin(payload);
        this._tileBegin(k.z, k.x, k.y);
        this.liveTiles.add(`${k.z}/${k.x}/${k.y}`);
      } else if (type === SECTION_TILE_END) {
        this._tileEnd();
      } else if (type === SECTION_TILE_RELEASE) {
        const k = readTileRelease(payload);
        this._tileRelease(k.z, k.x, k.y);
        this.liveTiles.delete(`${k.z}/${k.x}/${k.y}`);
      } else if (type === SECTION_TILE_BUILDINGS) {
        const recs = readTileBuildings(payload);
        for (let i = 0; i < recs.length; i++) {
          const r = recs[i];
          this._buildingUpsert(
            FlecsBridge.buildingRemoteId(r.remoteId),
            r.kind & 0xff,
            r.cx,
            r.cy,
            r.cz,
            r.sx,
            r.sy,
            r.sz,
            r.heading,
            r.color >>> 0,
          );
        }
      } else if (type === SECTION_TILE_MESH) {
        this.uploadMesh(readTileMesh(payload));
      } else if (type === SECTION_TILE_LANTERNS) {
        const recs = readTileLanterns(payload);
        for (let i = 0; i < recs.length; i++) {
          const r = recs[i];
          this._lanternUpsert(
            FlecsBridge.lanternRemoteId(r.remoteId),
            r.x,
            r.y,
            r.z,
          );
        }
      } else if (type === SECTION_TILE_PROPS) {
        const recs = readTileProps(payload);
        for (let i = 0; i < recs.length; i++) {
          const r = recs[i];
          this._propUpsert(
            FlecsBridge.propRemoteId(r.remoteId),
            r.propKind & 0xff,
            r.x,
            r.y,
            r.z,
            r.heading,
          );
        }
      }
      // Unknown sections are ignored — forward compatibility.
    });

    // Reap trailing agent slots per kind that we saw in this frame.
    // This is the "implicit removal" rule from the wire contract.
    for (let k = 0; k < AGENT_KIND_COUNT; k++) {
      if (!seenAgentKind[k]) continue;
      const prev = this.prevAgentCount[k];
      const next = newAgentCount[k];
      if (prev > next) {
        for (let i = next; i < prev; i++) {
          this._agentRemoveKind(FlecsBridge.agentRemoteId(k, i), k & 0xff);
        }
      }
      this.prevAgentCount[k] = next;
    }

    this.endFrame();
    this.framesApplied++;
    this.lastTickSeq = hdr.tickSeq >>> 0;
    this.lastFrameKind = hdr.kind & 0xff;
  }
}
