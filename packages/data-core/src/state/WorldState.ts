// Serialises the bitECS map3d world into the wire frame codec. Tiger style:
//   * Holds preallocated dense scratch arrays sized to entityCap; the encoder
//     consumes those arrays directly.
//   * No allocation in produceKeyframe() beyond the encoder's static buffer.
//   * The scratch FeedSectionRecord array reuses object slots in place.

import { query } from "bitecs";
import {
  AGENT_RECORD_BYTES,
  ENV_PAYLOAD_BYTES,
  FEED_FLAG_ON_GROUND,
  FEED_FLAG_REMOVED,
  FEED_KIND_AIRCRAFT,
  FEED_KIND_VESSEL,
  FEED_RECORD_BYTES,
  FRAME_KIND_KEYFRAME,
  FrameEncoder,
  HEADER_BYTES,
  SECTION_HEADER_BYTES,
  type FeedSectionRecord,
} from "../codec/FrameCodec";
import {
  FLAG_IS_AGENT,
  FLAG_IS_FEED,
  FLAG_ON_GROUND,
  FLAG_REMOVED,
  KIND_AGENT_PEDESTRIAN,
  KIND_AGENT_TRAIN,
  KIND_AGENT_VEHICLE,
  KIND_FEED_AIRCRAFT,
  KIND_FEED_VESSEL,
  type Map3dWorld,
} from "../ecs/world";
import { rgbToHex, type SunState } from "../time/SunCalc";
import { assertFinite, assertU32 } from "../util/assert";

const AGENT_KINDS = [
  KIND_AGENT_VEHICLE,
  KIND_AGENT_TRAIN,
  KIND_AGENT_PEDESTRIAN,
] as const;

export class WorldState {
  private world: Map3dWorld;
  private env: SunState | null = null;
  private denseX: Float32Array;
  private denseZ: Float32Array;
  private denseHeading: Float32Array;
  private feedRecords: FeedSectionRecord[];

  constructor(world: Map3dWorld) {
    this.world = world;
    const cap = world.context.config.entityCap;
    this.denseX = new Float32Array(cap);
    this.denseZ = new Float32Array(cap);
    this.denseHeading = new Float32Array(cap);
    this.feedRecords = new Array(cap);
    for (let i = 0; i < cap; i++) {
      this.feedRecords[i] = makeBlankFeedRecord();
    }
  }

  setEnv(env: SunState): void {
    this.env = env;
  }

  /** Upper bound on serialised keyframe size for the current world contents. */
  estimatedKeyframeBytes(): number {
    let total = HEADER_BYTES;
    const c = this.world.components;
    let agentCount = 0;
    let feedCount = 0;
    for (const eid of query(this.world, [c.Flags])) {
      const b = c.Flags.bits[eid];
      if ((b & FLAG_IS_AGENT) !== 0) agentCount++;
      else if ((b & FLAG_IS_FEED) !== 0) feedCount++;
    }
    // Per-kind agent sections (worst case: all agents in one kind).
    for (let i = 0; i < AGENT_KINDS.length; i++) {
      total += SECTION_HEADER_BYTES + 6;
    }
    total += agentCount * AGENT_RECORD_BYTES;
    total += SECTION_HEADER_BYTES + 4 + feedCount * FEED_RECORD_BYTES;
    total += SECTION_HEADER_BYTES + ENV_PAYLOAD_BYTES;
    return total + 256;
  }

  produceKeyframe(
    encoder: FrameEncoder,
    tickSeq: number,
    tsMs: number,
  ): Uint8Array {
    assertU32(tickSeq, "tickSeq");
    assertFinite(tsMs, "tsMs");
    encoder.beginFrame(FRAME_KIND_KEYFRAME, tickSeq, tsMs);
    for (const kind of AGENT_KINDS) this.encodeAgentKind(encoder, kind);
    this.encodeFeeds(encoder);
    if (this.env) {
      encoder.writeEnvSection({
        sunAltitude: this.env.altitude,
        sunAzimuth: this.env.azimuth,
        sunColorRgb: rgbToHex(this.env.directional) >>> 0,
        ambientSky: rgbToHex(this.env.ambientSky) >>> 0,
        ambientGround: rgbToHex(this.env.ambientGround) >>> 0,
      });
    }
    return encoder.endFrame();
  }

  private encodeAgentKind(encoder: FrameEncoder, kind: number): void {
    const c = this.world.components;
    let n = 0;
    for (const eid of query(this.world, [c.Kind, c.Position, c.Heading, c.PathRef, c.Flags])) {
      if (c.Kind.value[eid] !== kind) continue;
      if ((c.Flags.bits[eid] & FLAG_IS_AGENT) === 0) continue;
      if (c.PathRef.polylineIdx[eid] < 0) continue;
      this.denseX[n] = c.Position.x[eid];
      this.denseZ[n] = c.Position.z[eid];
      this.denseHeading[n] = c.Heading.angle[eid];
      n++;
    }
    encoder.writeAgentSection(kind, n, this.denseX, this.denseZ, this.denseHeading);
  }

  private encodeFeeds(encoder: FrameEncoder): void {
    const c = this.world.components;
    const ctx = this.world.context;
    // Build inverse map eid → id once; bounded by feedIdToEid.size.
    let n = 0;
    for (const [id, eid] of ctx.feedIdToEid) {
      const flags = c.Flags.bits[eid];
      if ((flags & FLAG_IS_FEED) === 0) continue;
      const rec = this.feedRecords[n++];
      rec.id = id;
      rec.lon = c.Geo.lon[eid];
      rec.lat = c.Geo.lat[eid];
      rec.altM = c.Geo.altM[eid];
      rec.heading = c.Heading.angle[eid] * (180 / Math.PI);
      rec.speedMs = c.Speed.value[eid];
      rec.kind = c.Kind.value[eid] === KIND_FEED_AIRCRAFT ? FEED_KIND_AIRCRAFT : FEED_KIND_VESSEL;
      let wireFlags = 0;
      if ((flags & FLAG_ON_GROUND) !== 0) wireFlags |= FEED_FLAG_ON_GROUND;
      if ((flags & FLAG_REMOVED) !== 0) wireFlags |= FEED_FLAG_REMOVED;
      rec.flags = wireFlags;
    }
    encoder.writeFeedSection(this.feedRecords, n);
  }
}

function makeBlankFeedRecord(): FeedSectionRecord {
  return {
    id: "",
    lon: 0,
    lat: 0,
    altM: 0,
    heading: 0,
    speedMs: 0,
    kind: 0,
    flags: 0,
  };
}
