// Pure MVT tile parser. Runs synchronously, no DOM, no worker globals — usable
// from a browser Worker (via tileWorker.entry.ts) or a Node.js process (the
// data-server). Decodes the pbf, classifies features through the provided
// Schema, projects into Web Mercator metres, and emits SoA buffers in the
// shape the renderer consumes.

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import earcut from "earcut";
import { gunzipSync } from "fflate";
import {
  assert,
  assertU32,
  assertFinite,
  assertInRange,
  checkLoopBound,
} from "../util/assert";
import {
  tileMetersBox,
  tileLocalToMeters,
  type MetersBox,
} from "../projection/mercator";
import type { LayerGeometry, LayerName, ParsedTile } from "./types";
import type { Schema } from "./schemas/types";
import { protomapsV4 } from "./schemas/protomapsV4";
import { openmaptiles } from "./schemas/openmaptiles";

// ────────────────────────────────────────────────────────────────────────────
// Tiger Style hard caps. These are sanity bounds on *untrusted tile bytes*;
// any real-world OMT / Protomaps tile sits orders of magnitude below them.
// If a real tile ever trips one, loosen here and document why.
// ────────────────────────────────────────────────────────────────────────────
const MAX_TILE_BYTES = 64 * 1024 * 1024; // 64 MiB compressed/uncompressed
const MAX_FEATURES_PER_LAYER = 200_000;
const MAX_VERTICES_PER_TILE = 1_000_000;
const MAX_RINGS_PER_FEATURE = 65_536;
const MAX_POINTS_PER_RING = 1_000_000;
const MAX_TILE_ZOOM = 24;

export type SchemaName = "openmaptiles" | "protomaps-v4";
export type SourceKind = "pmtiles" | "raw";

export interface ParseTileArgs {
  z: number;
  x: number;
  y: number;
  bytes: ArrayBuffer;
  version: number;
  schema: SchemaName;
  /** "pmtiles" or "raw" — informational only; both code paths decode the same
   *  pbf payload. Kept for symmetry with the worker RPC envelope. */
  sourceKind: SourceKind;
}

const LAYER_NAMES: LayerName[] = [
  "earth",
  "landcover",
  "landuse",
  "water",
  "waterway",
  "paths",
  "roads",
  "rail",
  "buildings",
  "pois",
];

// ────────────────────────────────────────────────────────────────────────────
// MVT parsing — SoA pack with multi-part line split.
// ────────────────────────────────────────────────────────────────────────────

function ringArea(flat: number[]): number {
  let a = 0;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    a += (flat[j] - flat[i]) * (flat[i + 1] + flat[j + 1]);
  }
  return a / 2;
}

interface FeatureAccum {
  positions: number[];
  indices: number[];
  featureStart: number[];
  featureIds: number[];
  featureClass: number[];
  featureHeight: number[];
  featureMinHeight: number[];
  attributes: Record<string, Record<string, string | number>>;
}

function newAccum(): FeatureAccum {
  return {
    positions: [],
    indices: [],
    featureStart: [0],
    featureIds: [],
    featureClass: [],
    featureHeight: [],
    featureMinHeight: [],
    attributes: {},
  };
}

function pushAttr(
  attrs: Record<string, Record<string, string | number>>,
  layer: LayerName,
  featureId: number,
  raw: Record<string, unknown>,
) {
  const filtered: Record<string, string | number> = {};
  let kept = 0;
  for (const k in raw) {
    const v = raw[k];
    if (typeof v === "string" || typeof v === "number") {
      filtered[k] = v;
      kept++;
    }
  }
  if (kept > 0) attrs[`${layer}:${featureId}`] = filtered;
}

function freezeGeometry(
  kind: "polygon" | "line" | "point",
  a: FeatureAccum,
): LayerGeometry {
  // Tiger Style: verify SoA sentinel invariants before we hand bytes to the
  // main thread. featureStart has one extra terminating entry past the count.
  const featureCount = a.featureIds.length;
  assertU32(featureCount, "featureCount");
  assert(featureCount <= MAX_FEATURES_PER_LAYER, "feature cap");
  assert(a.featureStart.length === featureCount + 1, "featureStart length");
  assert(a.featureClass.length === featureCount, "featureClass length");
  assert(a.featureHeight.length === featureCount, "featureHeight length");
  assert(a.featureMinHeight.length === featureCount, "featureMinHeight length");
  assert(a.positions.length % 2 === 0, "positions xy pairs");
  const vertexCount = a.positions.length / 2;
  assertU32(vertexCount, "vertexCount");
  assert(vertexCount <= MAX_VERTICES_PER_TILE, "vertex cap");
  // Sentinel monotonicity + bounds.
  const sentinelMax = kind === "polygon" ? a.indices.length : vertexCount;
  let prev = 0;
  for (let i = 0; i < a.featureStart.length; i++) {
    checkLoopBound(i, MAX_FEATURES_PER_LAYER + 2, "featureStart");
    const s = a.featureStart[i];
    assertU32(s, "featureStart[i]");
    assert(s >= prev, "featureStart monotonic");
    assert(s <= sentinelMax, "featureStart in range");
    prev = s;
  }
  if (kind === "polygon") {
    assert(a.indices.length % 3 === 0, "polygon indices%3");
    for (let i = 0; i < a.indices.length; i++) {
      // Cheap spot-check: every index must point at a real vertex.
      assert(a.indices[i] < vertexCount, "polygon index<vertexCount");
    }
  }
  return {
    kind,
    positions: new Float32Array(a.positions),
    indices: a.indices.length ? new Uint32Array(a.indices) : undefined,
    featureStart: new Uint32Array(a.featureStart),
    featureIds: new Uint32Array(a.featureIds),
    featureClass: new Uint8Array(a.featureClass),
    featureHeight: new Float32Array(a.featureHeight),
    featureMinHeight: new Float32Array(a.featureMinHeight),
  };
}

function triangulateAndAppend(
  accum: FeatureAccum,
  rings: { x: number; y: number }[][],
  box: MetersBox,
  extent: number,
) {
  assertU32(extent, "extent");
  assert(extent > 0, "extent positive");
  assert(rings.length <= MAX_RINGS_PER_FEATURE, "rings/feature cap");
  const flat: number[] = [];
  const holes: number[] = [];
  const baseVertex = accum.positions.length / 2;
  assertU32(baseVertex, "baseVertex");
  for (let i = 0; i < rings.length; i++) {
    checkLoopBound(i, MAX_RINGS_PER_FEATURE, "rings");
    if (i > 0) holes.push(flat.length / 2);
    const ring = rings[i];
    assert(ring.length <= MAX_POINTS_PER_RING, "ring point cap");
    for (let pi = 0; pi < ring.length; pi++) {
      checkLoopBound(pi, MAX_POINTS_PER_RING, "ring points");
      const p = ring[pi];
      const m = tileLocalToMeters(box, extent, p.x, p.y);
      assertFinite(m.x, "ring mx");
      assertFinite(m.y, "ring my");
      flat.push(m.x, m.y);
    }
  }
  if (flat.length < 6) return;
  const tri = earcut(flat, holes);
  if (tri.length === 0) return;
  assert(tri.length % 3 === 0, "earcut tri%3");
  for (let i = 0; i < flat.length; i++) accum.positions.push(flat[i]);
  for (let i = 0; i < tri.length; i++) accum.indices.push(baseVertex + tri[i]);
}

function synthEarthQuad(box: MetersBox): LayerGeometry {
  // Four corners CCW (under our north→-Z scene), one triangle pair.
  const positions = new Float32Array([
    box.minX, box.minY,
    box.maxX, box.minY,
    box.maxX, box.maxY,
    box.minX, box.maxY,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return {
    kind: "polygon",
    positions,
    indices,
    featureStart: new Uint32Array([0, 6]),
    featureIds: new Uint32Array([0]),
    featureClass: new Uint8Array([1]),
    featureHeight: new Float32Array([0]),
    featureMinHeight: new Float32Array([0]),
  };
}

export function approximateByteSize(t: ParsedTile): number {
  let n = 0;
  for (const k in t.layers) {
    const g = t.layers[k as LayerName]!;
    n += g.positions.byteLength;
    n += g.indices?.byteLength ?? 0;
    n += g.featureStart.byteLength;
    n += g.featureIds.byteLength;
    n += g.featureClass.byteLength;
    n += g.featureHeight.byteLength;
    n += g.featureMinHeight.byteLength;
  }
  n += JSON.stringify(t.attributes).length * 2;
  return n;
}

/**
 * Decode an MVT tile payload into our SoA ParsedTile. Pure and synchronous —
 * safe to call from a Web Worker, Node service, or unit test. Every argument
 * is treated as untrusted (numeric ranges asserted; oversized buffers rejected).
 */
export function parseTile(args: ParseTileArgs): ParsedTile {
  // Tiger Style: validate every field on the entry. Untrusted RPC payload.
  assert(args !== null && typeof args === "object", "parseTile args");
  const { z, x, y, bytes, version, schema: schemaName, sourceKind } = args;
  assertU32(z, "z");
  assertU32(x, "x");
  assertU32(y, "y");
  assertU32(version, "version");
  assertInRange(z, 0, MAX_TILE_ZOOM, "z range");
  const tilesPerAxis = 1 << z;
  assertInRange(x, 0, tilesPerAxis - 1, "x range");
  assertInRange(y, 0, tilesPerAxis - 1, "y range");
  assert(bytes instanceof ArrayBuffer, "bytes ArrayBuffer");
  assert(bytes.byteLength > 0, "tile bytes nonempty");
  assert(bytes.byteLength <= MAX_TILE_BYTES, "tile bytes cap");
  assert(
    schemaName === "openmaptiles" || schemaName === "protomaps-v4",
    "schema name",
  );
  assert(sourceKind === "pmtiles" || sourceKind === "raw", "sourceKind");

  const schema: Schema = schemaName === "openmaptiles" ? openmaptiles : protomapsV4;
  const box = tileMetersBox(z, x, y);
  // OpenFreeMap serves gzip; the browser usually decompresses, but bare bytes
  // (range reads from PMTiles or proxies that pass-through gzip) can land here
  // still compressed. Sniff and inflate if needed.
  let buf: ArrayBuffer = bytes;
  const view = new Uint8Array(bytes);
  if (view.length > 2 && view[0] === 0x1f && view[1] === 0x8b) {
    const out = gunzipSync(view);
    assert(out.byteLength <= MAX_TILE_BYTES, "inflated tile bytes cap");
    buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }
  const vt = new VectorTile(new Pbf(buf));
  const out: ParsedTile = {
    z,
    x,
    y,
    version,
    layers: {},
    attributes: {},
    byteSize: 0,
  };

  for (const targetLayer of LAYER_NAMES) {
    const expectedType = schema.expectedType[targetLayer];
    const aliases = schema.aliases[targetLayer];
    if (!aliases || aliases.length === 0) continue;
    const accum = newAccum();
    let nextFeatureId = 0;

    for (const alias of aliases) {
      const lyr = vt.layers[alias];
      if (!lyr) continue;
      const extent = lyr.extent ?? 4096;
      assertU32(extent, "lyr.extent");
      assert(extent > 0 && extent <= 1 << 16, "extent sane");
      assert(lyr.length <= MAX_FEATURES_PER_LAYER, "lyr.length cap");

      for (let i = 0; i < lyr.length; i++) {
        checkLoopBound(i, MAX_FEATURES_PER_LAYER, "lyr.feature");
        const f = lyr.feature(i);
        if (f.type !== expectedType) continue;
        const props = f.properties as Record<string, unknown>;
        const cls = schema.classify(targetLayer, alias, props);
        if (cls === null) continue;
        const rings = f.loadGeometry();
        assert(rings.length <= MAX_RINGS_PER_FEATURE, "rings cap");

        if (f.type === 3) {
          // POLYGONS — earcut each closed sub-polygon. One MVT feature can have
          // multiple polygons (outer ring with negative-area holes follows it).
          const startBefore = accum.indices.length;
          let i2 = 0;
          let guard = 0;
          while (i2 < rings.length) {
            checkLoopBound(guard++, MAX_RINGS_PER_FEATURE, "poly outer scan");
            const outer = rings[i2++];
            const polyRings: { x: number; y: number }[][] = [outer];
            while (i2 < rings.length) {
              checkLoopBound(i2, MAX_RINGS_PER_FEATURE, "poly hole scan");
              const r = rings[i2];
              const flat: number[] = [];
              assert(r.length <= MAX_POINTS_PER_RING, "hole ring point cap");
              for (let pi = 0; pi < r.length; pi++) {
                checkLoopBound(pi, MAX_POINTS_PER_RING, "hole ring pts");
                flat.push(r[pi].x, r[pi].y);
              }
              if (ringArea(flat) >= 0) break;
              polyRings.push(r);
              i2++;
            }
            triangulateAndAppend(accum, polyRings, box, extent);
          }
          if (accum.indices.length === startBefore) continue;
          const fid = nextFeatureId++;
          assertU32(fid, "poly fid");
          assert(nextFeatureId <= MAX_FEATURES_PER_LAYER, "poly featureCount cap");
          accum.featureIds.push(fid);
          accum.featureClass.push(cls);
          const hh = schema.heightFor(props);
          const mh = schema.minHeightFor(props);
          assertFinite(hh, "feature height");
          assertFinite(mh, "feature min height");
          accum.featureHeight.push(hh);
          accum.featureMinHeight.push(mh);
          pushAttr(accum.attributes, targetLayer, fid, props);
          accum.featureStart.push(accum.indices.length);
        } else if (f.type === 2) {
          // LINES — emit each MVT geometry "part" (one polyline) as its own
          // feature, so disconnected segments aren't dragged into one ribbon.
          for (let li = 0; li < rings.length; li++) {
            checkLoopBound(li, MAX_RINGS_PER_FEATURE, "line parts");
            const line = rings[li];
            if (line.length < 2) continue;
            assert(line.length <= MAX_POINTS_PER_RING, "line point cap");
            for (let pi = 0; pi < line.length; pi++) {
              checkLoopBound(pi, MAX_POINTS_PER_RING, "line points");
              const p = line[pi];
              const m = tileLocalToMeters(box, extent, p.x, p.y);
              assertFinite(m.x, "line mx");
              assertFinite(m.y, "line my");
              accum.positions.push(m.x, m.y);
            }
            const fid = nextFeatureId++;
            assertU32(fid, "line fid");
            accum.featureIds.push(fid);
            accum.featureClass.push(cls);
            accum.featureHeight.push(0);
            accum.featureMinHeight.push(0);
            pushAttr(accum.attributes, targetLayer, fid, props);
            accum.featureStart.push(accum.positions.length / 2);
          }
        } else if (f.type === 1) {
          // POINTS — one MVT feature can have multiple points; emit each as
          // its own feature so InstancedMesh slots stay 1:1 with featureIds.
          for (let pgi = 0; pgi < rings.length; pgi++) {
            checkLoopBound(pgi, MAX_RINGS_PER_FEATURE, "point groups");
            const pts = rings[pgi];
            assert(pts.length <= MAX_POINTS_PER_RING, "point group cap");
            for (let pi = 0; pi < pts.length; pi++) {
              checkLoopBound(pi, MAX_POINTS_PER_RING, "point group points");
              const p = pts[pi];
              const m = tileLocalToMeters(box, extent, p.x, p.y);
              assertFinite(m.x, "point mx");
              assertFinite(m.y, "point my");
              accum.positions.push(m.x, m.y);
              const fid = nextFeatureId++;
              assertU32(fid, "point fid");
              accum.featureIds.push(fid);
              accum.featureClass.push(cls);
              accum.featureHeight.push(0);
              accum.featureMinHeight.push(0);
              pushAttr(accum.attributes, targetLayer, fid, props);
              accum.featureStart.push(accum.positions.length / 2);
            }
          }
        }
      }
    }

    if (accum.featureIds.length > 0) {
      const geomKind = expectedType === 3 ? "polygon" : expectedType === 2 ? "line" : "point";
      out.layers[targetLayer] = freezeGeometry(geomKind, accum);
      for (const k in accum.attributes) out.attributes[k] = accum.attributes[k];
    }
  }

  // Synthesize an earth quad if no earth features came through (OMT has no
  // earth layer; we need a base plate so empty tiles aren't a void).
  if (!out.layers.earth) {
    out.layers.earth = synthEarthQuad(box);
  }

  out.byteSize = approximateByteSize(out);
  return out;
}
