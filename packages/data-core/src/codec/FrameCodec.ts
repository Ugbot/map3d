// Wire frame codec. Little-endian, fixed-width records, tiger style:
//   * Static record layouts (no variable-length records in v1).
//   * Encoder fails fast when capacity is insufficient — never grows silently.
//   * Decoder asserts every length and bound; corrupt input throws.
//
// Layout
// ------
//   Header (20 bytes):
//     +0  magic   u32  'M3DF'
//     +4  version u8
//     +5  kind    u8
//     +6  flags   u16
//     +8  tickSeq u32
//     +12 tsMs    f64
//
//   Body: zero or more TLV sections:
//     type    u16
//     byteLen u32
//     payload <byteLen> bytes
//
//   Section AGENTS (header 6 bytes + 12-byte records):
//     +0  kind  u8     (0=vehicle, 1=train, 2=pedestrian)
//     +1  pad   u8
//     +2  count u32
//     +6  records[count]: x f32, z f32, heading f32
//
//   Section FEEDS (header 4 bytes + 40-byte records):
//     +0  count u32
//     +4  records[count]:
//       +0   id char[16]       ASCII, NUL-padded
//       +16  lon f32
//       +20  lat f32
//       +24  altM f32
//       +28  heading f32
//       +32  speedMs f32
//       +36  kind u8           (0=aircraft, 1=vessel)
//       +37  flags u8          (bit0 = onGround, bit1 = removed)
//       +38  pad u16
//
//   Section ENV (20 bytes):
//     +0  sunAltitude f32
//     +4  sunAzimuth  f32
//     +8  sunColorRgb u32
//     +12 ambientSky  u32
//     +16 ambientGround u32
//
//   Section HELLO (8 bytes, client→server):
//     +0  clientCaps u32
//     +4  reserved   u32
//
//   Section BBOX (32 bytes, client→server):
//     +0  minLat f64, +8 minLon f64, +16 maxLat f64, +24 maxLon f64

import {
  assert,
  assertEq,
  assertFinite,
  assertInRange,
  assertU32,
} from "../util/assert";

export const FRAME_MAGIC = 0x4644334d; // 'M','3','D','F' little-endian
export const FRAME_VERSION = 1;
export const HEADER_BYTES = 20;
export const SECTION_HEADER_BYTES = 6;

export const FRAME_KIND_KEYFRAME = 0x01;
export const FRAME_KIND_DELTA = 0x02;
export const FRAME_KIND_HELLO = 0x10;
export const FRAME_KIND_BBOX = 0x11;

export const SECTION_AGENTS = 0x0001;
export const SECTION_FEEDS = 0x0002;
export const SECTION_ENV = 0x0003;
export const SECTION_HELLO = 0x0010;
export const SECTION_BBOX = 0x0011;

export const AGENT_RECORD_BYTES = 12;
export const FEED_RECORD_BYTES = 40;
export const FEED_ID_BYTES = 16;
export const ENV_PAYLOAD_BYTES = 20;

export const FEED_KIND_AIRCRAFT = 0;
export const FEED_KIND_VESSEL = 1;
export const FEED_FLAG_ON_GROUND = 1 << 0;
export const FEED_FLAG_REMOVED = 1 << 1;

export interface FrameHeader {
  version: number;
  kind: number;
  flags: number;
  tickSeq: number;
  tsMs: number;
}

export interface AgentSectionView {
  kind: number;
  count: number;
  x: Float32Array;
  z: Float32Array;
  heading: Float32Array;
}

export interface FeedSectionRecord {
  id: string;
  lon: number;
  lat: number;
  altM: number;
  heading: number;
  speedMs: number;
  kind: number;
  flags: number;
}

export interface EnvSection {
  sunAltitude: number;
  sunAzimuth: number;
  sunColorRgb: number;
  ambientSky: number;
  ambientGround: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("ascii");

// =====================================================================
// Encoder
// =====================================================================

export class FrameEncoder {
  private buf: Uint8Array;
  private view: DataView;
  private offset = 0;
  private opened = false;

  constructor(capacityBytes: number) {
    assertInRange(capacityBytes, HEADER_BYTES, 64 * 1024 * 1024, "capacity");
    this.buf = new Uint8Array(capacityBytes);
    this.view = new DataView(this.buf.buffer);
  }

  beginFrame(kind: number, tickSeq: number, tsMs: number): void {
    assert(!this.opened, "encoder: frame already open");
    assertU32(tickSeq, "tickSeq");
    assertFinite(tsMs, "tsMs");
    assertInRange(kind, 0, 0xff, "frame kind");
    this.requireCapacity(0, HEADER_BYTES);
    this.view.setUint32(0, FRAME_MAGIC, true);
    this.view.setUint8(4, FRAME_VERSION);
    this.view.setUint8(5, kind);
    this.view.setUint16(6, 0, true);
    this.view.setUint32(8, tickSeq >>> 0, true);
    this.view.setFloat64(12, tsMs, true);
    this.offset = HEADER_BYTES;
    this.opened = true;
  }

  endFrame(): Uint8Array {
    assert(this.opened, "encoder: no frame open");
    const out = this.buf.subarray(0, this.offset);
    this.opened = false;
    return out;
  }

  writeAgentSection(
    kind: number,
    count: number,
    x: Float32Array,
    z: Float32Array,
    heading: Float32Array,
  ): void {
    assert(this.opened, "writeAgentSection: no frame");
    assertInRange(kind, 0, 0xff, "agent section kind");
    assertU32(count, "count");
    assert(count <= x.length, "count<=x.length");
    assert(count <= z.length, "count<=z.length");
    assert(count <= heading.length, "count<=heading.length");
    const payloadBytes = 6 + count * AGENT_RECORD_BYTES;
    this.beginSection(SECTION_AGENTS, payloadBytes);
    this.view.setUint8(this.offset + 0, kind);
    this.view.setUint8(this.offset + 1, 0);
    this.view.setUint32(this.offset + 2, count >>> 0, true);
    this.offset += 6;
    for (let i = 0; i < count; i++) {
      this.view.setFloat32(this.offset + 0, x[i], true);
      this.view.setFloat32(this.offset + 4, z[i], true);
      this.view.setFloat32(this.offset + 8, heading[i], true);
      this.offset += AGENT_RECORD_BYTES;
    }
  }

  writeFeedSection(
    records: readonly FeedSectionRecord[],
    countArg?: number,
  ): void {
    assert(this.opened, "writeFeedSection: no frame");
    const count = countArg ?? records.length;
    assertU32(count, "feed count");
    assert(count <= records.length, "writeFeedSection: count > records.length");
    const payloadBytes = 4 + count * FEED_RECORD_BYTES;
    this.beginSection(SECTION_FEEDS, payloadBytes);
    this.view.setUint32(this.offset, count >>> 0, true);
    this.offset += 4;
    for (let i = 0; i < count; i++) {
      const r = records[i];
      assertFinite(r.lon, "feed.lon");
      assertFinite(r.lat, "feed.lat");
      assertFinite(r.altM, "feed.altM");
      assertFinite(r.heading, "feed.heading");
      assertFinite(r.speedMs, "feed.speedMs");
      assertInRange(r.kind, 0, 0xff, "feed.kind");
      assertInRange(r.flags, 0, 0xff, "feed.flags");
      writeFixedAscii(this.buf, this.offset, r.id, FEED_ID_BYTES);
      this.view.setFloat32(this.offset + 16, r.lon, true);
      this.view.setFloat32(this.offset + 20, r.lat, true);
      this.view.setFloat32(this.offset + 24, r.altM, true);
      this.view.setFloat32(this.offset + 28, r.heading, true);
      this.view.setFloat32(this.offset + 32, r.speedMs, true);
      this.view.setUint8(this.offset + 36, r.kind & 0xff);
      this.view.setUint8(this.offset + 37, r.flags & 0xff);
      this.view.setUint16(this.offset + 38, 0, true);
      this.offset += FEED_RECORD_BYTES;
    }
  }

  writeEnvSection(env: EnvSection): void {
    assert(this.opened, "writeEnvSection: no frame");
    assertFinite(env.sunAltitude, "sunAltitude");
    assertFinite(env.sunAzimuth, "sunAzimuth");
    assertU32(env.sunColorRgb, "sunColorRgb");
    assertU32(env.ambientSky, "ambientSky");
    assertU32(env.ambientGround, "ambientGround");
    this.beginSection(SECTION_ENV, ENV_PAYLOAD_BYTES);
    this.view.setFloat32(this.offset + 0, env.sunAltitude, true);
    this.view.setFloat32(this.offset + 4, env.sunAzimuth, true);
    this.view.setUint32(this.offset + 8, env.sunColorRgb >>> 0, true);
    this.view.setUint32(this.offset + 12, env.ambientSky >>> 0, true);
    this.view.setUint32(this.offset + 16, env.ambientGround >>> 0, true);
    this.offset += ENV_PAYLOAD_BYTES;
  }

  writeHelloSection(clientCaps: number): void {
    assert(this.opened, "writeHelloSection: no frame");
    assertU32(clientCaps, "clientCaps");
    this.beginSection(SECTION_HELLO, 8);
    this.view.setUint32(this.offset + 0, clientCaps >>> 0, true);
    this.view.setUint32(this.offset + 4, 0, true);
    this.offset += 8;
  }

  writeBboxSection(
    minLat: number,
    minLon: number,
    maxLat: number,
    maxLon: number,
  ): void {
    assert(this.opened, "writeBboxSection: no frame");
    assertInRange(minLat, -90, 90, "minLat");
    assertInRange(maxLat, -90, 90, "maxLat");
    assertInRange(minLon, -180, 180, "minLon");
    assertInRange(maxLon, -180, 180, "maxLon");
    assert(minLat <= maxLat, "bbox: lat order");
    assert(minLon <= maxLon, "bbox: lon order");
    this.beginSection(SECTION_BBOX, 32);
    this.view.setFloat64(this.offset + 0, minLat, true);
    this.view.setFloat64(this.offset + 8, minLon, true);
    this.view.setFloat64(this.offset + 16, maxLat, true);
    this.view.setFloat64(this.offset + 24, maxLon, true);
    this.offset += 32;
  }

  private beginSection(type: number, payloadBytes: number): void {
    this.requireCapacity(this.offset, SECTION_HEADER_BYTES + payloadBytes);
    this.view.setUint16(this.offset, type, true);
    this.view.setUint32(this.offset + 2, payloadBytes >>> 0, true);
    this.offset += SECTION_HEADER_BYTES;
  }

  private requireCapacity(start: number, extra: number): void {
    const need = start + extra;
    if (need > this.buf.length) {
      throw new Error(
        `frame capacity exceeded: need ${need}, cap ${this.buf.length}`,
      );
    }
  }
}

function writeFixedAscii(
  buf: Uint8Array,
  offset: number,
  s: string,
  width: number,
): void {
  for (let i = 0; i < width; i++) buf[offset + i] = 0;
  textEncoder.encodeInto(s, buf.subarray(offset, offset + width));
}

// =====================================================================
// Decoder
// =====================================================================

export class FrameDecoder {
  private view: DataView;
  private buf: Uint8Array;
  private offset = 0;
  private end = 0;

  constructor(frame: Uint8Array) {
    assert(frame.byteLength >= HEADER_BYTES, "decoder: frame too short");
    this.buf = frame;
    this.view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    this.end = frame.byteLength;
    const magic = this.view.getUint32(0, true);
    assertEq(magic, FRAME_MAGIC, "decoder: magic");
    const version = this.view.getUint8(4);
    assertEq(version, FRAME_VERSION, "decoder: version");
    this.offset = HEADER_BYTES;
  }

  header(): FrameHeader {
    return {
      version: this.view.getUint8(4),
      kind: this.view.getUint8(5),
      flags: this.view.getUint16(6, true),
      tickSeq: this.view.getUint32(8, true) >>> 0,
      tsMs: this.view.getFloat64(12, true),
    };
  }

  forEachSection(
    cb: (type: number, payload: DataView, payloadBytes: number) => void,
  ): void {
    const guard = 1 << 20;
    let iter = 0;
    while (this.offset < this.end) {
      assert(iter++ < guard, "decoder: too many sections");
      assert(
        this.offset + SECTION_HEADER_BYTES <= this.end,
        "decoder: section header truncated",
      );
      const type = this.view.getUint16(this.offset, true);
      const payloadBytes = this.view.getUint32(this.offset + 2, true) >>> 0;
      const payloadStart = this.offset + SECTION_HEADER_BYTES;
      assert(
        payloadStart + payloadBytes <= this.end,
        "decoder: section overruns",
      );
      const payload = new DataView(
        this.buf.buffer,
        this.buf.byteOffset + payloadStart,
        payloadBytes,
      );
      cb(type, payload, payloadBytes);
      this.offset = payloadStart + payloadBytes;
    }
  }
}

export function readAgentSection(payload: DataView): AgentSectionView {
  assert(payload.byteLength >= 6, "agent section header truncated");
  const kind = payload.getUint8(0);
  const count = payload.getUint32(2, true) >>> 0;
  const expected = 6 + count * AGENT_RECORD_BYTES;
  assertEq(payload.byteLength, expected, "agent section length");
  const x = new Float32Array(count);
  const z = new Float32Array(count);
  const heading = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const base = 6 + i * AGENT_RECORD_BYTES;
    x[i] = payload.getFloat32(base + 0, true);
    z[i] = payload.getFloat32(base + 4, true);
    heading[i] = payload.getFloat32(base + 8, true);
  }
  return { kind, count, x, z, heading };
}

export function readFeedSection(payload: DataView): FeedSectionRecord[] {
  assert(payload.byteLength >= 4, "feed section header truncated");
  const count = payload.getUint32(0, true) >>> 0;
  const expected = 4 + count * FEED_RECORD_BYTES;
  assertEq(payload.byteLength, expected, "feed section length");
  const out: FeedSectionRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = 4 + i * FEED_RECORD_BYTES;
    const idBytes = new Uint8Array(
      payload.buffer,
      payload.byteOffset + base,
      FEED_ID_BYTES,
    );
    let idLen = FEED_ID_BYTES;
    for (let j = 0; j < FEED_ID_BYTES; j++) {
      if (idBytes[j] === 0) {
        idLen = j;
        break;
      }
    }
    out[i] = {
      id: textDecoder.decode(idBytes.subarray(0, idLen)),
      lon: payload.getFloat32(base + 16, true),
      lat: payload.getFloat32(base + 20, true),
      altM: payload.getFloat32(base + 24, true),
      heading: payload.getFloat32(base + 28, true),
      speedMs: payload.getFloat32(base + 32, true),
      kind: payload.getUint8(base + 36),
      flags: payload.getUint8(base + 37),
    };
  }
  return out;
}

export function readEnvSection(payload: DataView): EnvSection {
  assertEq(payload.byteLength, ENV_PAYLOAD_BYTES, "env section length");
  return {
    sunAltitude: payload.getFloat32(0, true),
    sunAzimuth: payload.getFloat32(4, true),
    sunColorRgb: payload.getUint32(8, true) >>> 0,
    ambientSky: payload.getUint32(12, true) >>> 0,
    ambientGround: payload.getUint32(16, true) >>> 0,
  };
}

export function readBboxSection(payload: DataView): {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
} {
  assertEq(payload.byteLength, 32, "bbox section length");
  return {
    minLat: payload.getFloat64(0, true),
    minLon: payload.getFloat64(8, true),
    maxLat: payload.getFloat64(16, true),
    maxLon: payload.getFloat64(24, true),
  };
}
