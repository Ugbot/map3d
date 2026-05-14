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
//
//   Tile streaming sections
//   -----------------------
//   SECTION_TILE_BEGIN     (12-byte payload)  z u32 | x u32 | y u32
//   SECTION_TILE_END       (0-byte payload)
//   SECTION_TILE_RELEASE   (12-byte payload)  z u32 | x u32 | y u32
//
//   SECTION_TILE_BUILDINGS (header 4 bytes + 40-byte records):
//     +0  count u32
//     records[count]:
//       +0  remote_id u32
//       +4  kind u8 | pad u8 | pad u16
//       +8  cx f32, +12 cy f32, +16 cz f32
//       +20 sx f32, +24 sy f32, +28 sz f32
//       +32 heading f32
//       +36 color u32
//
//   SECTION_TILE_MESH      (variable: 32-byte header + payload):
//     +0  remote_id u32
//     +4  layer_kind u8 | pad u8 | pad u16
//     +8  origin_x f32, +12 origin_y f32, +16 origin_z f32
//     +20 color_rgb u32
//     +24 n_floats u32
//     +28 n_indices u32
//     +32 positions[n_floats] f32
//     +32 + n_floats*4 indices[n_indices] u32
//
//   SECTION_TILE_LANTERNS  (header 4 bytes + 16-byte records):
//     +0  count u32
//     records[count]: remote_id u32 | x f32 | y f32 | z f32
//
//   SECTION_TILE_PROPS     (header 4 bytes + 24-byte records):
//     +0  count u32
//     records[count]:
//       +0  remote_id u32
//       +4  prop_kind u8 | pad u8 | pad u16
//       +8  x f32, +12 y f32, +16 z f32, +20 heading f32
//       (Spec quoted "20-byte" but the four f32s + 8 bytes of header sum
//        to 24; we honour the field list — see PROP_RECORD_BYTES.)

import {
  AssertionError,
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
export const SECTION_TILE_BEGIN = 0x0020;
export const SECTION_TILE_END = 0x0021;
export const SECTION_TILE_RELEASE = 0x0022;
export const SECTION_TILE_BUILDINGS = 0x0023;
export const SECTION_TILE_MESH = 0x0024;
export const SECTION_TILE_LANTERNS = 0x0025;
export const SECTION_TILE_PROPS = 0x0026;

export const AGENT_RECORD_BYTES = 12;
export const FEED_RECORD_BYTES = 40;
export const FEED_ID_BYTES = 16;
export const ENV_PAYLOAD_BYTES = 20;
export const TILE_COORD_PAYLOAD_BYTES = 12;
export const BUILDING_RECORD_BYTES = 40;
export const TILE_MESH_HEADER_BYTES = 32;
export const LANTERN_RECORD_BYTES = 16;
export const PROP_RECORD_BYTES = 24;
// Conservative sanity bound for tile-space coordinates (metres). Anything
// beyond this is almost certainly corrupt or a misencoded geographic value.
export const TILE_COORD_LIMIT_M = 1e8;

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

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface BuildingRecord {
  remoteId: number;
  kind: number;
  cx: number;
  cy: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
  heading: number;
  color: number;
}

export interface MeshRecord {
  remoteId: number;
  layerKind: number;
  originX: number;
  originY: number;
  originZ: number;
  color: number;
  positions: Float32Array;
  indices: Uint32Array;
}

export interface LanternRecord {
  remoteId: number;
  x: number;
  y: number;
  z: number;
}

export interface PropRecord {
  remoteId: number;
  propKind: number;
  x: number;
  y: number;
  z: number;
  heading: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("ascii");

// Detect host endianness once. We only ship to LE platforms but the wasm
// client may eventually run elsewhere; the slow path is correct in either case.
const HOST_IS_LITTLE_ENDIAN = (() => {
  const probe = new Uint16Array([0x0102]);
  return new Uint8Array(probe.buffer)[0] === 0x02;
})();

function assertFiniteCoord(n: number, msg: string): void {
  if (!Number.isFinite(n) || n < -TILE_COORD_LIMIT_M || n > TILE_COORD_LIMIT_M) {
    throw new AssertionError(
      `${msg}: ${n} not in [-${TILE_COORD_LIMIT_M}, ${TILE_COORD_LIMIT_M}]`,
    );
  }
}

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

  writeTileBegin(z: number, x: number, y: number): void {
    this.writeTileCoordSection(SECTION_TILE_BEGIN, z, x, y);
  }

  writeTileEnd(): void {
    assert(this.opened, "writeTileEnd: no frame");
    this.beginSection(SECTION_TILE_END, 0);
  }

  writeTileRelease(z: number, x: number, y: number): void {
    this.writeTileCoordSection(SECTION_TILE_RELEASE, z, x, y);
  }

  writeTileBuildings(
    records: readonly BuildingRecord[],
    countArg?: number,
  ): void {
    assert(this.opened, "writeTileBuildings: no frame");
    const count = countArg ?? records.length;
    assertU32(count, "building count");
    assert(
      count <= records.length,
      "writeTileBuildings: count > records.length",
    );
    const payloadBytes = 4 + count * BUILDING_RECORD_BYTES;
    const startOffset = this.offset;
    this.beginSection(SECTION_TILE_BUILDINGS, payloadBytes);
    this.view.setUint32(this.offset, count >>> 0, true);
    this.offset += 4;
    for (let i = 0; i < count; i++) {
      const r = records[i];
      assertU32(r.remoteId, "building.remoteId");
      assertInRange(r.kind, 0, 0xff, "building.kind");
      assert(
        Number.isInteger(r.color) && r.color >= 0 && r.color <= 0xffffffff,
        "building.color: not u32",
      );
      assertFiniteCoord(r.cx, "building.cx");
      assertFiniteCoord(r.cy, "building.cy");
      assertFiniteCoord(r.cz, "building.cz");
      assertFinite(r.sx, "building.sx");
      assertFinite(r.sy, "building.sy");
      assertFinite(r.sz, "building.sz");
      assertFinite(r.heading, "building.heading");
      const base = this.offset;
      this.view.setUint32(base + 0, r.remoteId >>> 0, true);
      this.view.setUint8(base + 4, r.kind & 0xff);
      this.view.setUint8(base + 5, 0);
      this.view.setUint16(base + 6, 0, true);
      this.view.setFloat32(base + 8, r.cx, true);
      this.view.setFloat32(base + 12, r.cy, true);
      this.view.setFloat32(base + 16, r.cz, true);
      this.view.setFloat32(base + 20, r.sx, true);
      this.view.setFloat32(base + 24, r.sy, true);
      this.view.setFloat32(base + 28, r.sz, true);
      this.view.setFloat32(base + 32, r.heading, true);
      this.view.setUint32(base + 36, r.color >>> 0, true);
      this.offset += BUILDING_RECORD_BYTES;
    }
    assertEq(
      this.offset - startOffset - SECTION_HEADER_BYTES,
      payloadBytes,
      "tile buildings: encoded length",
    );
  }

  writeTileMesh(rec: MeshRecord): void {
    assert(this.opened, "writeTileMesh: no frame");
    assertU32(rec.remoteId, "mesh.remoteId");
    assertInRange(rec.layerKind, 0, 0xff, "mesh.layerKind");
    assert(
      Number.isInteger(rec.color) && rec.color >= 0 && rec.color <= 0xffffffff,
      "mesh.color: not u32",
    );
    assertFiniteCoord(rec.originX, "mesh.originX");
    assertFiniteCoord(rec.originY, "mesh.originY");
    assertFiniteCoord(rec.originZ, "mesh.originZ");
    const nFloats = rec.positions.length;
    const nIndices = rec.indices.length;
    assertU32(nFloats, "mesh.nFloats");
    assertU32(nIndices, "mesh.nIndices");
    assertEq(nFloats % 3, 0, "mesh.positions: not multiple of 3");
    assertEq(nIndices % 3, 0, "mesh.indices: not multiple of 3");
    // Verify positions are finite and within sane range.
    for (let i = 0; i < nFloats; i++) {
      const v = rec.positions[i];
      if (!Number.isFinite(v) || v < -TILE_COORD_LIMIT_M || v > TILE_COORD_LIMIT_M) {
        throw new AssertionError(
          `mesh.positions[${i}]: ${v} not in [-${TILE_COORD_LIMIT_M}, ${TILE_COORD_LIMIT_M}]`,
        );
      }
    }
    const payloadBytes =
      TILE_MESH_HEADER_BYTES + nFloats * 4 + nIndices * 4;
    const startOffset = this.offset;
    this.beginSection(SECTION_TILE_MESH, payloadBytes);
    const base = this.offset;
    this.view.setUint32(base + 0, rec.remoteId >>> 0, true);
    this.view.setUint8(base + 4, rec.layerKind & 0xff);
    this.view.setUint8(base + 5, 0);
    this.view.setUint16(base + 6, 0, true);
    this.view.setFloat32(base + 8, rec.originX, true);
    this.view.setFloat32(base + 12, rec.originY, true);
    this.view.setFloat32(base + 16, rec.originZ, true);
    this.view.setUint32(base + 20, rec.color >>> 0, true);
    this.view.setUint32(base + 24, nFloats >>> 0, true);
    this.view.setUint32(base + 28, nIndices >>> 0, true);
    this.offset += TILE_MESH_HEADER_BYTES;
    // Per-float setFloat32 honours little-endian regardless of buffer
    // alignment — no UB risk from misaligned typed-array views here.
    for (let i = 0; i < nFloats; i++) {
      this.view.setFloat32(this.offset, rec.positions[i], true);
      this.offset += 4;
    }
    for (let i = 0; i < nIndices; i++) {
      const idx = rec.indices[i];
      assertU32(idx, "mesh.index");
      assert(idx * 3 < nFloats, "mesh: index out of range");
      this.view.setUint32(this.offset, idx >>> 0, true);
      this.offset += 4;
    }
    assertEq(
      this.offset - startOffset - SECTION_HEADER_BYTES,
      payloadBytes,
      "tile mesh: encoded length",
    );
  }

  writeTileLanterns(
    records: readonly LanternRecord[],
    countArg?: number,
  ): void {
    assert(this.opened, "writeTileLanterns: no frame");
    const count = countArg ?? records.length;
    assertU32(count, "lantern count");
    assert(
      count <= records.length,
      "writeTileLanterns: count > records.length",
    );
    const payloadBytes = 4 + count * LANTERN_RECORD_BYTES;
    const startOffset = this.offset;
    this.beginSection(SECTION_TILE_LANTERNS, payloadBytes);
    this.view.setUint32(this.offset, count >>> 0, true);
    this.offset += 4;
    for (let i = 0; i < count; i++) {
      const r = records[i];
      assertU32(r.remoteId, "lantern.remoteId");
      assertFiniteCoord(r.x, "lantern.x");
      assertFiniteCoord(r.y, "lantern.y");
      assertFiniteCoord(r.z, "lantern.z");
      this.view.setUint32(this.offset + 0, r.remoteId >>> 0, true);
      this.view.setFloat32(this.offset + 4, r.x, true);
      this.view.setFloat32(this.offset + 8, r.y, true);
      this.view.setFloat32(this.offset + 12, r.z, true);
      this.offset += LANTERN_RECORD_BYTES;
    }
    assertEq(
      this.offset - startOffset - SECTION_HEADER_BYTES,
      payloadBytes,
      "tile lanterns: encoded length",
    );
  }

  writeTileProps(records: readonly PropRecord[], countArg?: number): void {
    assert(this.opened, "writeTileProps: no frame");
    const count = countArg ?? records.length;
    assertU32(count, "prop count");
    assert(count <= records.length, "writeTileProps: count > records.length");
    const payloadBytes = 4 + count * PROP_RECORD_BYTES;
    const startOffset = this.offset;
    this.beginSection(SECTION_TILE_PROPS, payloadBytes);
    this.view.setUint32(this.offset, count >>> 0, true);
    this.offset += 4;
    for (let i = 0; i < count; i++) {
      const r = records[i];
      assertU32(r.remoteId, "prop.remoteId");
      assertInRange(r.propKind, 0, 0xff, "prop.propKind");
      assertFiniteCoord(r.x, "prop.x");
      assertFiniteCoord(r.y, "prop.y");
      assertFiniteCoord(r.z, "prop.z");
      assertFinite(r.heading, "prop.heading");
      const base = this.offset;
      this.view.setUint32(base + 0, r.remoteId >>> 0, true);
      this.view.setUint8(base + 4, r.propKind & 0xff);
      this.view.setUint8(base + 5, 0);
      this.view.setUint16(base + 6, 0, true);
      this.view.setFloat32(base + 8, r.x, true);
      this.view.setFloat32(base + 12, r.y, true);
      this.view.setFloat32(base + 16, r.z, true);
      this.view.setFloat32(base + 20, r.heading, true);
      this.offset += PROP_RECORD_BYTES;
    }
    assertEq(
      this.offset - startOffset - SECTION_HEADER_BYTES,
      payloadBytes,
      "tile props: encoded length",
    );
  }

  private writeTileCoordSection(
    type: number,
    z: number,
    x: number,
    y: number,
  ): void {
    assert(this.opened, "tile-coord section: no frame");
    assertU32(z, "tile.z");
    assertU32(x, "tile.x");
    assertU32(y, "tile.y");
    assertInRange(z, 0, 30, "tile.z");
    this.beginSection(type, TILE_COORD_PAYLOAD_BYTES);
    this.view.setUint32(this.offset + 0, z >>> 0, true);
    this.view.setUint32(this.offset + 4, x >>> 0, true);
    this.view.setUint32(this.offset + 8, y >>> 0, true);
    this.offset += TILE_COORD_PAYLOAD_BYTES;
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

function readTileCoord(payload: DataView, msg: string): TileCoord {
  assertEq(payload.byteLength, TILE_COORD_PAYLOAD_BYTES, msg);
  const z = payload.getUint32(0, true) >>> 0;
  const x = payload.getUint32(4, true) >>> 0;
  const y = payload.getUint32(8, true) >>> 0;
  assertInRange(z, 0, 30, `${msg}: z`);
  return { z, x, y };
}

export function readTileBegin(payload: DataView): TileCoord {
  return readTileCoord(payload, "tile-begin section length");
}

export function readTileRelease(payload: DataView): TileCoord {
  return readTileCoord(payload, "tile-release section length");
}

export function readTileBuildings(payload: DataView): BuildingRecord[] {
  assert(payload.byteLength >= 4, "tile buildings section header truncated");
  const count = payload.getUint32(0, true) >>> 0;
  const expected = 4 + count * BUILDING_RECORD_BYTES;
  assertEq(payload.byteLength, expected, "tile buildings section length");
  const out: BuildingRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = 4 + i * BUILDING_RECORD_BYTES;
    const remoteId = payload.getUint32(base + 0, true) >>> 0;
    const kind = payload.getUint8(base + 4);
    const cx = payload.getFloat32(base + 8, true);
    const cy = payload.getFloat32(base + 12, true);
    const cz = payload.getFloat32(base + 16, true);
    const sx = payload.getFloat32(base + 20, true);
    const sy = payload.getFloat32(base + 24, true);
    const sz = payload.getFloat32(base + 28, true);
    const heading = payload.getFloat32(base + 32, true);
    const color = payload.getUint32(base + 36, true) >>> 0;
    assertFiniteCoord(cx, "building.cx");
    assertFiniteCoord(cy, "building.cy");
    assertFiniteCoord(cz, "building.cz");
    assertFinite(sx, "building.sx");
    assertFinite(sy, "building.sy");
    assertFinite(sz, "building.sz");
    assertFinite(heading, "building.heading");
    out[i] = {
      remoteId,
      kind,
      cx,
      cy,
      cz,
      sx,
      sy,
      sz,
      heading,
      color,
    };
  }
  return out;
}

export function readTileMesh(payload: DataView): MeshRecord {
  assert(
    payload.byteLength >= TILE_MESH_HEADER_BYTES,
    "tile mesh section header truncated",
  );
  const remoteId = payload.getUint32(0, true) >>> 0;
  const layerKind = payload.getUint8(4);
  const originX = payload.getFloat32(8, true);
  const originY = payload.getFloat32(12, true);
  const originZ = payload.getFloat32(16, true);
  const color = payload.getUint32(20, true) >>> 0;
  const nFloats = payload.getUint32(24, true) >>> 0;
  const nIndices = payload.getUint32(28, true) >>> 0;
  assertFiniteCoord(originX, "mesh.originX");
  assertFiniteCoord(originY, "mesh.originY");
  assertFiniteCoord(originZ, "mesh.originZ");
  assertEq(nFloats % 3, 0, "mesh.nFloats not multiple of 3");
  assertEq(nIndices % 3, 0, "mesh.nIndices not multiple of 3");
  const expected = TILE_MESH_HEADER_BYTES + nFloats * 4 + nIndices * 4;
  assertEq(payload.byteLength, expected, "tile mesh section length");
  const posByteOffset = payload.byteOffset + TILE_MESH_HEADER_BYTES;
  const idxByteOffset = posByteOffset + nFloats * 4;
  // Zero-copy when the payload's underlying buffer happens to be aligned for
  // 4-byte typed-array views; otherwise fall back to a copy via per-element
  // DataView reads (still little-endian on both arches we ship to, but typed
  // arrays use host endianness so we can only zero-copy on LE hosts).
  let positions: Float32Array;
  let indices: Uint32Array;
  const hostLE = HOST_IS_LITTLE_ENDIAN;
  if (hostLE && (posByteOffset & 0x3) === 0) {
    positions = new Float32Array(payload.buffer, posByteOffset, nFloats);
  } else {
    positions = new Float32Array(nFloats);
    for (let i = 0; i < nFloats; i++) {
      positions[i] = payload.getFloat32(
        TILE_MESH_HEADER_BYTES + i * 4,
        true,
      );
    }
  }
  if (hostLE && (idxByteOffset & 0x3) === 0) {
    indices = new Uint32Array(payload.buffer, idxByteOffset, nIndices);
  } else {
    indices = new Uint32Array(nIndices);
    for (let i = 0; i < nIndices; i++) {
      indices[i] =
        payload.getUint32(
          TILE_MESH_HEADER_BYTES + nFloats * 4 + i * 4,
          true,
        ) >>> 0;
    }
  }
  // Range-check positions (cheap defence against corrupt streams).
  for (let i = 0; i < nFloats; i++) {
    assertFiniteCoord(positions[i], "mesh.positions");
  }
  for (let i = 0; i < nIndices; i++) {
    assert(indices[i] * 3 < nFloats, "mesh: index out of range");
  }
  return {
    remoteId,
    layerKind,
    originX,
    originY,
    originZ,
    color,
    positions,
    indices,
  };
}

export function readTileLanterns(payload: DataView): LanternRecord[] {
  assert(payload.byteLength >= 4, "tile lanterns section header truncated");
  const count = payload.getUint32(0, true) >>> 0;
  const expected = 4 + count * LANTERN_RECORD_BYTES;
  assertEq(payload.byteLength, expected, "tile lanterns section length");
  const out: LanternRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = 4 + i * LANTERN_RECORD_BYTES;
    const remoteId = payload.getUint32(base + 0, true) >>> 0;
    const x = payload.getFloat32(base + 4, true);
    const y = payload.getFloat32(base + 8, true);
    const z = payload.getFloat32(base + 12, true);
    assertFiniteCoord(x, "lantern.x");
    assertFiniteCoord(y, "lantern.y");
    assertFiniteCoord(z, "lantern.z");
    out[i] = { remoteId, x, y, z };
  }
  return out;
}

export function readTileProps(payload: DataView): PropRecord[] {
  assert(payload.byteLength >= 4, "tile props section header truncated");
  const count = payload.getUint32(0, true) >>> 0;
  const expected = 4 + count * PROP_RECORD_BYTES;
  assertEq(payload.byteLength, expected, "tile props section length");
  const out: PropRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = 4 + i * PROP_RECORD_BYTES;
    const remoteId = payload.getUint32(base + 0, true) >>> 0;
    const propKind = payload.getUint8(base + 4);
    const x = payload.getFloat32(base + 8, true);
    const y = payload.getFloat32(base + 12, true);
    const z = payload.getFloat32(base + 16, true);
    const heading = payload.getFloat32(base + 20, true);
    assertFiniteCoord(x, "prop.x");
    assertFiniteCoord(y, "prop.y");
    assertFiniteCoord(z, "prop.z");
    assertFinite(heading, "prop.heading");
    out[i] = { remoteId, propKind, x, y, z, heading };
  }
  return out;
}
