import { describe, expect, it } from "vitest";
import {
  AGENT_RECORD_BYTES,
  ENV_PAYLOAD_BYTES,
  FEED_FLAG_ON_GROUND,
  FEED_KIND_AIRCRAFT,
  FEED_KIND_VESSEL,
  FEED_RECORD_BYTES,
  FRAME_KIND_KEYFRAME,
  FrameDecoder,
  FrameEncoder,
  HEADER_BYTES,
  SECTION_AGENTS,
  SECTION_ENV,
  SECTION_FEEDS,
  readAgentSection,
  readEnvSection,
  readFeedSection,
  type FeedSectionRecord,
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
