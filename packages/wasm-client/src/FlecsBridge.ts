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
  assert,
  assertFinite,
  assertInRange,
  assertU32,
  readAgentSection,
  readEnvSection,
  readFeedSection,
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

export class FlecsBridge {
  private mod: EmscriptenModule | null = null;

  // cwrap handles (cached once in init()).
  private _init!: V_void;
  private _beginFrame!: V_u32;
  private _endFrame!: V_void;
  private _agentUpsert!: V_u32u8_5f;
  private _agentRemove!: V_u32;
  private _feedUpsert!: V_u32u8_5f;
  private _feedRemove!: V_u32;
  private _setEnv!: V_env;
  private _clearAll!: V_void;
  private _liveCount!: R_u32;

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
    this._feedUpsert = cw("beam_feed_upsert", null, [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]) as V_u32u8_5f;
    this._feedRemove = cw("beam_feed_remove", null, ["number"]) as V_u32;
    this._setEnv = cw("beam_set_env", null, [
      "number",
      "number",
      "number",
      "number",
      "number",
    ]) as V_env;
    this._clearAll = cw("beam_clear_all", null, []) as V_void;
    this._liveCount = cw("beam_live_count", "number", []) as R_u32;

    this._init();
    this.prevAgentCount.fill(0);
    this.liveFeedIds.clear();
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
  }

  liveCount(): number {
    return this._liveCount() >>> 0;
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
          if ((r.flags & FEED_FLAG_REMOVED) !== 0) {
            this._feedRemove(id);
            this.liveFeedIds.delete(id);
            continue;
          }
          assertInRange(
            r.kind,
            FEED_KIND_AIRCRAFT,
            FEED_KIND_VESSEL,
            "feed.kind",
          );
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
          this._agentRemove(FlecsBridge.agentRemoteId(k, i));
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
