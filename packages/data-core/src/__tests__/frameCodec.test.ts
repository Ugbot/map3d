import { describe, expect, it } from "vitest";
import {
  AGENT_RECORD_BYTES,
  BUILDING_RECORD_BYTES,
  ENV_PAYLOAD_BYTES,
  FEED_FLAG_ON_GROUND,
  FEED_KIND_AIRCRAFT,
  FEED_KIND_VESSEL,
  FEED_RECORD_BYTES,
  FRAME_KIND_KEYFRAME,
  FrameDecoder,
  FrameEncoder,
  HEADER_BYTES,
  LANTERN_RECORD_BYTES,
  PROP_RECORD_BYTES,
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
  TILE_MESH_HEADER_BYTES,
  readAgentSection,
  readEnvSection,
  readFeedSection,
  readTileBegin,
  readTileBuildings,
  readTileLanterns,
  readTileMesh,
  readTileProps,
  readTileRelease,
  type BuildingRecord,
  type FeedSectionRecord,
  type LanternRecord,
  type MeshRecord,
  type PropRecord,
} from "../codec/FrameCodec";
import { makeRng } from "../util/rng";

function randomAgentArrays(rng: ReturnType<typeof makeRng>, n: number) {
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const heading = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (rng.next() - 0.5) * 10_000;
    z[i] = (rng.next() - 0.5) * 10_000;
    heading[i] = (rng.next() - 0.5) * Math.PI * 2;
  }
  return { x, z, heading };
}

describe("FrameCodec", () => {
  it("round-trips a keyframe with random agents/feeds/env", () => {
    const rng = makeRng(0x1234);
    const enc = new FrameEncoder(1 << 16);
    const tickSeq = 42;
    const tsMs = 1_700_000_000_000;
    enc.beginFrame(FRAME_KIND_KEYFRAME, tickSeq, tsMs);

    const a0 = randomAgentArrays(rng, 12);
    const a1 = randomAgentArrays(rng, 3);
    const a2 = randomAgentArrays(rng, 0);
    enc.writeAgentSection(0, 12, a0.x, a0.z, a0.heading);
    enc.writeAgentSection(1, 3, a1.x, a1.z, a1.heading);
    enc.writeAgentSection(2, 0, a2.x, a2.z, a2.heading);

    const feeds: FeedSectionRecord[] = [];
    for (let i = 0; i < 7; i++) {
      feeds.push({
        id: i % 2 === 0 ? `A${i.toString(16).padStart(5, "0")}` : `${100000 + i}`,
        lon: (rng.next() - 0.5) * 360,
        lat: (rng.next() - 0.5) * 170,
        altM: rng.next() * 12000,
        heading: rng.next() * 360,
        speedMs: rng.next() * 250,
        kind: i % 2 === 0 ? FEED_KIND_AIRCRAFT : FEED_KIND_VESSEL,
        flags: i === 0 ? FEED_FLAG_ON_GROUND : 0,
      });
    }
    enc.writeFeedSection(feeds);
    enc.writeEnvSection({
      sunAltitude: 0.7,
      sunAzimuth: -0.2,
      sunColorRgb: 0xffe0c0,
      ambientSky: 0xaabbcc,
      ambientGround: 0x331100,
    });
    const frame = enc.endFrame();
    expect(frame.byteLength).toBeGreaterThan(HEADER_BYTES);

    const dec = new FrameDecoder(frame);
    const hdr = dec.header();
    expect(hdr.kind).toBe(FRAME_KIND_KEYFRAME);
    expect(hdr.tickSeq).toBe(tickSeq);
    expect(hdr.tsMs).toBe(tsMs);

    const agentKinds: number[] = [];
    const decodedFeeds: FeedSectionRecord[] = [];
    let envSeen = false;
    dec.forEachSection((type, payload) => {
      if (type === SECTION_AGENTS) {
        const a = readAgentSection(payload);
        agentKinds.push(a.kind);
        if (a.kind === 0) {
          for (let i = 0; i < a.count; i++) {
            expect(a.x[i]).toBeCloseTo(a0.x[i], 3);
            expect(a.z[i]).toBeCloseTo(a0.z[i], 3);
            expect(a.heading[i]).toBeCloseTo(a0.heading[i], 5);
          }
        }
      } else if (type === SECTION_FEEDS) {
        const arr = readFeedSection(payload);
        decodedFeeds.push(...arr);
      } else if (type === SECTION_ENV) {
        const env = readEnvSection(payload);
        envSeen = true;
        expect(env.sunColorRgb).toBe(0xffe0c0);
      }
    });
    expect(agentKinds).toEqual([0, 1, 2]);
    expect(envSeen).toBe(true);
    expect(decodedFeeds.length).toBe(feeds.length);
    for (let i = 0; i < feeds.length; i++) {
      expect(decodedFeeds[i].id).toBe(feeds[i].id);
      expect(decodedFeeds[i].lon).toBeCloseTo(feeds[i].lon, 3);
      expect(decodedFeeds[i].lat).toBeCloseTo(feeds[i].lat, 3);
      expect(decodedFeeds[i].kind).toBe(feeds[i].kind);
      expect(decodedFeeds[i].flags).toBe(feeds[i].flags);
    }
  });

  it("reports correct fixed record sizes", () => {
    expect(AGENT_RECORD_BYTES).toBe(12);
    expect(FEED_RECORD_BYTES).toBe(40);
    expect(ENV_PAYLOAD_BYTES).toBe(20);
  });

  it("encoder throws on capacity overflow", () => {
    const enc = new FrameEncoder(HEADER_BYTES + 32);
    enc.beginFrame(FRAME_KIND_KEYFRAME, 0, 0);
    const big = new Float32Array(1000);
    expect(() => enc.writeAgentSection(0, 1000, big, big, big)).toThrow(
      /capacity/,
    );
  });

  it("decoder rejects bad magic", () => {
    const bad = new Uint8Array(HEADER_BYTES);
    expect(() => new FrameDecoder(bad)).toThrow(/magic/);
  });
});

function randomBuildings(
  rng: ReturnType<typeof makeRng>,
  n: number,
): BuildingRecord[] {
  const out: BuildingRecord[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      remoteId: rng.nextInt(0x7fffffff),
      kind: rng.nextInt(8),
      cx: (rng.next() - 0.5) * 4096,
      cy: rng.next() * 200,
      cz: (rng.next() - 0.5) * 4096,
      sx: 1 + rng.next() * 40,
      sy: 2 + rng.next() * 60,
      sz: 1 + rng.next() * 40,
      heading: (rng.next() - 0.5) * Math.PI * 2,
      color: rng.nextInt(0xffffffff),
    };
  }
  return out;
}

function randomLanterns(
  rng: ReturnType<typeof makeRng>,
  n: number,
): LanternRecord[] {
  const out: LanternRecord[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      remoteId: rng.nextInt(0x7fffffff),
      x: (rng.next() - 0.5) * 4096,
      y: rng.next() * 60,
      z: (rng.next() - 0.5) * 4096,
    };
  }
  return out;
}

function randomProps(
  rng: ReturnType<typeof makeRng>,
  n: number,
): PropRecord[] {
  const out: PropRecord[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      remoteId: rng.nextInt(0x7fffffff),
      propKind: rng.nextInt(16),
      x: (rng.next() - 0.5) * 4096,
      y: rng.next() * 30,
      z: (rng.next() - 0.5) * 4096,
      heading: (rng.next() - 0.5) * Math.PI * 2,
    };
  }
  return out;
}

function randomMesh(
  rng: ReturnType<typeof makeRng>,
  nTriangles: number,
): MeshRecord {
  const nVerts = nTriangles * 3;
  const positions = new Float32Array(nVerts * 3);
  for (let v = 0; v < nVerts; v++) {
    // Vertices on a unit sphere — finite, bounded, but with non-trivial
    // sign/magnitude variation across all three axes.
    const u = rng.next() * 2 - 1;
    const phi = rng.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    positions[v * 3 + 0] = r * Math.cos(phi);
    positions[v * 3 + 1] = u;
    positions[v * 3 + 2] = r * Math.sin(phi);
  }
  const indices = new Uint32Array(nTriangles * 3);
  for (let t = 0; t < nTriangles; t++) {
    indices[t * 3 + 0] = t * 3 + 0;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  return {
    remoteId: rng.nextInt(0x7fffffff),
    layerKind: rng.nextInt(8),
    originX: (rng.next() - 0.5) * 1024,
    originY: rng.next() * 100,
    originZ: (rng.next() - 0.5) * 1024,
    color: rng.nextInt(0xffffffff),
    positions,
    indices,
  };
}

describe("FrameCodec tile sections", () => {
  it("reports correct tile record sizes", () => {
    expect(BUILDING_RECORD_BYTES).toBe(40);
    expect(LANTERN_RECORD_BYTES).toBe(16);
    expect(PROP_RECORD_BYTES).toBe(24);
    expect(TILE_MESH_HEADER_BYTES).toBe(32);
  });

  it("round-trips TILE_BEGIN / TILE_END / TILE_RELEASE coords", () => {
    const rng = makeRng(0xbeef0001);
    const enc = new FrameEncoder(1 << 12);
    enc.beginFrame(FRAME_KIND_KEYFRAME, 1, 1);
    const z = rng.nextInt(22);
    const x = rng.nextInt(1 << z || 1);
    const y = rng.nextInt(1 << z || 1);
    enc.writeTileBegin(z, x, y);
    enc.writeTileEnd();
    enc.writeTileRelease(z, x, y);
    const frame = enc.endFrame();

    const dec = new FrameDecoder(frame);
    const seen: number[] = [];
    let begin: { z: number; x: number; y: number } | null = null;
    let release: { z: number; x: number; y: number } | null = null;
    let endBytes = -1;
    dec.forEachSection((type, payload, bytes) => {
      seen.push(type);
      if (type === SECTION_TILE_BEGIN) begin = readTileBegin(payload);
      else if (type === SECTION_TILE_RELEASE)
        release = readTileRelease(payload);
      else if (type === SECTION_TILE_END) endBytes = bytes;
    });
    expect(seen).toEqual([
      SECTION_TILE_BEGIN,
      SECTION_TILE_END,
      SECTION_TILE_RELEASE,
    ]);
    expect(endBytes).toBe(0);
    expect(begin).toEqual({ z, x, y });
    expect(release).toEqual({ z, x, y });
  });

  it("round-trips TILE_BUILDINGS with random records", () => {
    const rng = makeRng(0xbeef0002);
    const count = rng.nextInt(201); // 0..200 inclusive
    const buildings = randomBuildings(rng, count);
    const enc = new FrameEncoder(1 << 16);
    enc.beginFrame(FRAME_KIND_KEYFRAME, 2, 2);
    enc.writeTileBuildings(buildings);
    const frame = enc.endFrame();

    const dec = new FrameDecoder(frame);
    let decoded: BuildingRecord[] | null = null;
    dec.forEachSection((type, payload) => {
      if (type === SECTION_TILE_BUILDINGS) decoded = readTileBuildings(payload);
    });
    expect(decoded).not.toBeNull();
    const got = decoded!;
    expect(got.length).toBe(count);
    for (let i = 0; i < count; i++) {
      const a = buildings[i];
      const b = got[i];
      expect(b.remoteId).toBe(a.remoteId);
      expect(b.kind).toBe(a.kind);
      expect(b.color).toBe(a.color);
      // Float32 round-trip is exact when compared against Math.fround.
      expect(b.cx).toBe(Math.fround(a.cx));
      expect(b.cy).toBe(Math.fround(a.cy));
      expect(b.cz).toBe(Math.fround(a.cz));
      expect(b.sx).toBe(Math.fround(a.sx));
      expect(b.sy).toBe(Math.fround(a.sy));
      expect(b.sz).toBe(Math.fround(a.sz));
      expect(b.heading).toBe(Math.fround(a.heading));
    }
  });

  it("round-trips TILE_MESH with random triangle soup", () => {
    const rng = makeRng(0xbeef0003);
    const nTriangles = 1 + rng.nextInt(1000);
    const mesh = randomMesh(rng, nTriangles);
    const expectedBytes =
      TILE_MESH_HEADER_BYTES +
      mesh.positions.length * 4 +
      mesh.indices.length * 4;
    // Frame buffer must cover header + section header + payload.
    const enc = new FrameEncoder(
      HEADER_BYTES + 6 + expectedBytes + 64,
    );
    enc.beginFrame(FRAME_KIND_KEYFRAME, 3, 3);
    enc.writeTileMesh(mesh);
    const frame = enc.endFrame();

    const dec = new FrameDecoder(frame);
    let decoded: MeshRecord | null = null;
    let payloadBytes = -1;
    dec.forEachSection((type, payload, bytes) => {
      if (type === SECTION_TILE_MESH) {
        payloadBytes = bytes;
        decoded = readTileMesh(payload);
      }
    });
    expect(decoded).not.toBeNull();
    expect(payloadBytes).toBe(expectedBytes);
    const got = decoded!;
    expect(got.remoteId).toBe(mesh.remoteId);
    expect(got.layerKind).toBe(mesh.layerKind);
    expect(got.color).toBe(mesh.color);
    expect(got.originX).toBe(Math.fround(mesh.originX));
    expect(got.originY).toBe(Math.fround(mesh.originY));
    expect(got.originZ).toBe(Math.fround(mesh.originZ));
    expect(got.positions.length).toBe(mesh.positions.length);
    expect(got.indices.length).toBe(mesh.indices.length);
    for (let i = 0; i < mesh.positions.length; i++) {
      // positions were already Float32Array — round-trip must be exact.
      expect(got.positions[i]).toBe(mesh.positions[i]);
    }
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(got.indices[i]).toBe(mesh.indices[i]);
    }
  });

  it("round-trips TILE_LANTERNS with random records", () => {
    const rng = makeRng(0xbeef0004);
    const count = rng.nextInt(201);
    const lanterns = randomLanterns(rng, count);
    const enc = new FrameEncoder(1 << 14);
    enc.beginFrame(FRAME_KIND_KEYFRAME, 4, 4);
    enc.writeTileLanterns(lanterns);
    const frame = enc.endFrame();

    const dec = new FrameDecoder(frame);
    let decoded: LanternRecord[] | null = null;
    dec.forEachSection((type, payload) => {
      if (type === SECTION_TILE_LANTERNS) decoded = readTileLanterns(payload);
    });
    expect(decoded).not.toBeNull();
    const got = decoded!;
    expect(got.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(got[i].remoteId).toBe(lanterns[i].remoteId);
      expect(got[i].x).toBe(Math.fround(lanterns[i].x));
      expect(got[i].y).toBe(Math.fround(lanterns[i].y));
      expect(got[i].z).toBe(Math.fround(lanterns[i].z));
    }
  });

  it("round-trips TILE_PROPS with random records", () => {
    const rng = makeRng(0xbeef0005);
    const count = rng.nextInt(201);
    const props = randomProps(rng, count);
    const enc = new FrameEncoder(1 << 14);
    enc.beginFrame(FRAME_KIND_KEYFRAME, 5, 5);
    enc.writeTileProps(props);
    const frame = enc.endFrame();

    const dec = new FrameDecoder(frame);
    let decoded: PropRecord[] | null = null;
    dec.forEachSection((type, payload) => {
      if (type === SECTION_TILE_PROPS) decoded = readTileProps(payload);
    });
    expect(decoded).not.toBeNull();
    const got = decoded!;
    expect(got.length).toBe(count);
    for (let i = 0; i < count; i++) {
      const a = props[i];
      const b = got[i];
      expect(b.remoteId).toBe(a.remoteId);
      expect(b.propKind).toBe(a.propKind);
      expect(b.x).toBe(Math.fround(a.x));
      expect(b.y).toBe(Math.fround(a.y));
      expect(b.z).toBe(Math.fround(a.z));
      expect(b.heading).toBe(Math.fround(a.heading));
    }
  });
});
