/// <reference lib="webworker" />

import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import earcut from "earcut";
import { gunzipSync } from "fflate";
import {
  tileMetersBox,
  tileLocalToMeters,
  type MetersBox,
} from "../projection/mercator";
import type { BakedLineMesh, LayerGeometry, LayerName, ParsedTile } from "../cache/types";
import type { WorkerRequest, WorkerResponse } from "./pool";
import type { Schema } from "./schemas/types";
import { protomapsV4 } from "./schemas/protomapsV4";
import { openmaptiles } from "./schemas/openmaptiles";
import { bakeRibbonMesh, type RibbonConfig } from "./ribbonGen";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// ────────────────────────────────────────────────────────────────────────────
// Tile sources
// ────────────────────────────────────────────────────────────────────────────
interface TileSource {
  getTile(z: number, x: number, y: number): Promise<ArrayBuffer | undefined>;
}

class PMTilesSource implements TileSource {
  private p: PMTiles;
  constructor(url: string) {
    this.p = new PMTiles(url);
  }
  async getTile(z: number, x: number, y: number) {
    const r = await this.p.getZxy(z, x, y);
    return r?.data;
  }
}

class MVTSource implements TileSource {
  constructor(private readonly urlTemplate: string) {}
  async getTile(z: number, x: number, y: number) {
    const url = this.urlTemplate
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) return undefined;
      throw new Error(`tile fetch ${res.status} for ${z}/${x}/${y}`);
    }
    return res.arrayBuffer();
  }
}

let source: TileSource | null = null;
let schema: Schema = openmaptiles;
let sceneOrigin: { x: number; y: number } | null = null;
let ribbonConfigs: Partial<Record<LayerName, RibbonConfig>> = {};

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

interface Ring {
  flat: number[];
}

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
  const flat: number[] = [];
  const holes: number[] = [];
  const baseVertex = accum.positions.length / 2;
  for (let i = 0; i < rings.length; i++) {
    if (i > 0) holes.push(flat.length / 2);
    for (const p of rings[i]) {
      const m = tileLocalToMeters(box, extent, p.x, p.y);
      flat.push(m.x, m.y);
    }
  }
  if (flat.length < 6) return;
  const tri = earcut(flat, holes);
  if (tri.length === 0) return;
  for (let i = 0; i < flat.length; i++) accum.positions.push(flat[i]);
  for (let i = 0; i < tri.length; i++) accum.indices.push(baseVertex + tri[i]);
}

function parseTile(z: number, x: number, y: number, bytes: ArrayBuffer): ParsedTile {
  const box = tileMetersBox(z, x, y);
  // OpenFreeMap serves gzip; the browser usually decompresses, but bare bytes
  // (range reads from PMTiles or proxies that pass-through gzip) can land here
  // still compressed. Sniff and inflate if needed.
  let buf: ArrayBuffer = bytes;
  const view = new Uint8Array(bytes);
  if (view.length > 2 && view[0] === 0x1f && view[1] === 0x8b) {
    const out = gunzipSync(view);
    buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }
  const vt = new VectorTile(new Pbf(buf));
  const out: ParsedTile = {
    z,
    x,
    y,
    version: 1,
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

      for (let i = 0; i < lyr.length; i++) {
        const f = lyr.feature(i);
        if (f.type !== expectedType) continue;
        const props = f.properties as Record<string, unknown>;
        const cls = schema.classify(targetLayer, alias, props);
        if (cls === null) continue;
        const rings = f.loadGeometry();

        if (f.type === 3) {
          // POLYGONS — earcut each closed sub-polygon. One MVT feature can have
          // multiple polygons (outer ring with negative-area holes follows it).
          const startBefore = accum.indices.length;
          let i2 = 0;
          while (i2 < rings.length) {
            const outer = rings[i2++];
            const polyRings: { x: number; y: number }[][] = [outer];
            while (i2 < rings.length) {
              const r = rings[i2];
              const flat: number[] = [];
              for (const p of r) flat.push(p.x, p.y);
              if (ringArea(flat) >= 0) break;
              polyRings.push(r);
              i2++;
            }
            triangulateAndAppend(accum, polyRings, box, extent);
          }
          if (accum.indices.length === startBefore) continue;
          const fid = nextFeatureId++;
          accum.featureIds.push(fid);
          accum.featureClass.push(cls);
          accum.featureHeight.push(schema.heightFor(props));
          accum.featureMinHeight.push(schema.minHeightFor(props));
          pushAttr(accum.attributes, targetLayer, fid, props);
          accum.featureStart.push(accum.indices.length);
        } else if (f.type === 2) {
          // LINES — emit each MVT geometry "part" (one polyline) as its own
          // feature, so disconnected segments aren't dragged into one ribbon.
          for (const line of rings) {
            if (line.length < 2) continue;
            const before = accum.positions.length / 2;
            for (const p of line) {
              const m = tileLocalToMeters(box, extent, p.x, p.y);
              accum.positions.push(m.x, m.y);
            }
            const fid = nextFeatureId++;
            accum.featureIds.push(fid);
            accum.featureClass.push(cls);
            accum.featureHeight.push(0);
            accum.featureMinHeight.push(0);
            pushAttr(accum.attributes, targetLayer, fid, props);
            accum.featureStart.push(accum.positions.length / 2);
            void before;
          }
        } else if (f.type === 1) {
          // POINTS — one MVT feature can have multiple points; emit each as
          // its own feature so InstancedMesh slots stay 1:1 with featureIds.
          for (const pts of rings) {
            for (const p of pts) {
              const m = tileLocalToMeters(box, extent, p.x, p.y);
              accum.positions.push(m.x, m.y);
              const fid = nextFeatureId++;
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

  // Bake the 3D ribbon meshes here (off the main thread) for any line layer
  // with a registered config. The main thread just uploads the buffers.
  if (sceneOrigin) {
    const baked: Partial<Record<LayerName, BakedLineMesh>> = {};
    for (const ln in ribbonConfigs) {
      const cfg = ribbonConfigs[ln as LayerName];
      const g = out.layers[ln as LayerName];
      if (!cfg || !g || g.kind !== "line") continue;
      const m = bakeRibbonMesh(g, sceneOrigin, cfg);
      if (m) baked[ln as LayerName] = m;
    }
    if (Object.keys(baked).length > 0) out.bakedLines = baked;
  }

  out.byteSize = approximateByteSize(out);
  return out;
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

function approximateByteSize(t: ParsedTile): number {
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

function transferablesOf(t: ParsedTile): Transferable[] {
  const out: Transferable[] = [];
  for (const k in t.layers) {
    const g = t.layers[k as LayerName]!;
    out.push(g.positions.buffer);
    if (g.indices) out.push(g.indices.buffer);
    out.push(g.featureStart.buffer);
    out.push(g.featureIds.buffer);
    out.push(g.featureClass.buffer);
    out.push(g.featureHeight.buffer);
    out.push(g.featureMinHeight.buffer);
  }
  if (t.bakedLines) {
    for (const k in t.bakedLines) {
      const m = t.bakedLines[k as LayerName];
      if (!m) continue;
      out.push(m.positions.buffer);
      out.push(m.indices.buffer);
      if (m.uvs) out.push(m.uvs.buffer);
      out.push(m.featureRanges.buffer);
      out.push(m.featureIds.buffer);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// RPC
// ────────────────────────────────────────────────────────────────────────────

interface InitPayload {
  source: { kind: "pmtiles"; url: string } | { kind: "mvt"; urlTemplate: string };
  schema: "openmaptiles" | "protomaps-v4";
  cacheVersion: number;
  sceneOrigin?: { x: number; y: number };
  ribbonConfigs?: Partial<Record<LayerName, RibbonConfig>>;
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = e.data;
  try {
    if (type === "init") {
      const p = payload as InitPayload;
      source =
        p.source.kind === "pmtiles" ? new PMTilesSource(p.source.url) : new MVTSource(p.source.urlTemplate);
      schema = p.schema === "openmaptiles" ? openmaptiles : protomapsV4;
      if (p.sceneOrigin) sceneOrigin = p.sceneOrigin;
      if (p.ribbonConfigs) ribbonConfigs = p.ribbonConfigs;
      reply(id, true, { ok: true });
    } else if (type === "fetchTile") {
      if (!source) throw new Error("worker not initialised");
      const { z, x, y } = payload as { z: number; x: number; y: number };
      const bytes = await source.getTile(z, x, y);
      if (!bytes) {
        reply(id, true, { missing: true, z, x, y });
        return;
      }
      const parsed = parseTile(z, x, y, bytes);
      reply(id, true, { tile: parsed, missing: false }, transferablesOf(parsed));
    } else {
      throw new Error(`unknown message: ${type}`);
    }
  } catch (err) {
    reply(id, false, undefined, [], err instanceof Error ? err.message : String(err));
  }
};

function reply(
  id: number,
  ok: boolean,
  result?: unknown,
  transfer: Transferable[] = [],
  error?: string,
) {
  const msg: WorkerResponse = { id, ok, result, error };
  ctx.postMessage(msg, transfer);
}
