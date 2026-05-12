// Tile fetch + parse worker.
//
// Responsibilities:
//   1. Range-read tiles from a PMTiles archive (composable: any TileSource
//      satisfying `getTile(z,x,y)` works — see TileSource below).
//   2. Decode MVT to per-layer SoA buffers in Web Mercator metres.
//   3. Triangulate polygons via earcut so re-loading from cache requires zero
//      CPU on the main thread.
//   4. Post the ParsedTile back as transferable typed arrays.

/// <reference lib="webworker" />

import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import earcut from "earcut";
import {
  tileMetersBox,
  tileLocalToMeters,
  type MetersBox,
} from "../projection/mercator";
import type { LayerGeometry, LayerName, ParsedTile } from "../cache/types";
import {
  classifyRoad,
  classifyRail,
  classifyPath,
  classifyLanduse,
  BuildingClass,
  PoiClass,
} from "../cache/classes";
import type { WorkerRequest, WorkerResponse } from "./pool";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// ────────────────────────────────────────────────────────────────────────────
// Tile source abstraction. A backend service can implement the same interface.
// ────────────────────────────────────────────────────────────────────────────
interface TileSource {
  getTile(z: number, x: number, y: number): Promise<ArrayBuffer | undefined>;
}

class PMTilesSource implements TileSource {
  private p: PMTiles;
  constructor(url: string) {
    this.p = new PMTiles(url);
  }
  async getTile(z: number, x: number, y: number): Promise<ArrayBuffer | undefined> {
    const r = await this.p.getZxy(z, x, y);
    return r?.data;
  }
}

let source: TileSource | null = null;
const VERSION = 1;
const TILE_BUDGET_LAYERS: LayerName[] = [
  "buildings",
  "roads",
  "rail",
  "water",
  "landuse",
  "paths",
  "pois",
];

// Names Protomaps basemaps v3/v4 uses. We accept the union and pick first hit.
const PROTOMAPS_LAYER_ALIASES: Record<LayerName, string[]> = {
  buildings: ["buildings"],
  roads: ["roads"],
  rail: ["roads"], // rail is in the roads layer with kind=rail* in Protomaps
  water: ["water"],
  landuse: ["landuse", "natural"],
  paths: ["roads"], // paths/footways also in roads with kind=path
  pois: ["pois", "places"],
};

// ────────────────────────────────────────────────────────────────────────────
// MVT parsing
// ────────────────────────────────────────────────────────────────────────────

interface Ring {
  flat: number[]; // x0,y0,x1,y1,... in tile-local coords
}

// Signed area; positive = CCW under MVT's y-down → outer ring, negative = hole.
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

function parseTile(z: number, x: number, y: number, bytes: ArrayBuffer): ParsedTile {
  const box = tileMetersBox(z, x, y);
  const vt = new VectorTile(new Pbf(bytes));
  const out: ParsedTile = {
    z,
    x,
    y,
    version: VERSION,
    layers: {},
    attributes: {},
    byteSize: 0,
  };

  for (const targetLayer of TILE_BUDGET_LAYERS) {
    const accum = newAccum();
    let nextFeatureId = 0;
    let geomKind: "polygon" | "line" | "point" | null = null;

    for (const alias of PROTOMAPS_LAYER_ALIASES[targetLayer]) {
      const lyr = vt.layers[alias];
      if (!lyr) continue;
      const extent = lyr.extent ?? 4096;

      for (let i = 0; i < lyr.length; i++) {
        const f = lyr.feature(i);
        const props = f.properties as Record<string, unknown>;
        const cls = classifyForLayer(targetLayer, alias, props);
        if (cls === null) continue;
        const startBefore =
          f.type === 3 ? accum.indices.length : accum.positions.length / 2;
        const rings = f.loadGeometry();

        if (f.type === 3) {
          geomKind = "polygon";
          // rings is a flat list of rings; ring with positive signed-area
          // (under MVT's y-down) starts a new polygon, negative rings are holes.
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
        } else if (f.type === 2) {
          geomKind = "line";
          for (const line of rings)
            for (const p of line) {
              const m = tileLocalToMeters(box, extent, p.x, p.y);
              accum.positions.push(m.x, m.y);
            }
        } else if (f.type === 1) {
          geomKind = "point";
          for (const pts of rings)
            for (const p of pts) {
              const m = tileLocalToMeters(box, extent, p.x, p.y);
              accum.positions.push(m.x, m.y);
            }
        } else {
          continue;
        }

        const endAfter =
          f.type === 3 ? accum.indices.length : accum.positions.length / 2;
        if (endAfter === startBefore) continue; // degenerate

        const fid = nextFeatureId++;
        accum.featureIds.push(fid);
        accum.featureClass.push(cls);
        accum.featureHeight.push(numericProp(props, "height", 0));
        accum.featureMinHeight.push(numericProp(props, "min_height", 0));
        pushAttr(accum.attributes, targetLayer, fid, props);
        accum.featureStart.push(endAfter); // sentinel for *this* feature's end / next's start
      }
    }

    if (geomKind && accum.featureIds.length > 0) {
      // featureStart = [0, end0, end1, ..., endN] of length featureCount+1.
      out.layers[targetLayer] = freezeGeometryAlreadyClosed(geomKind, accum);
      for (const k in accum.attributes) out.attributes[k] = accum.attributes[k];
    }
  }

  out.byteSize = approximateByteSize(out);
  return out;
}

function freezeGeometryAlreadyClosed(
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

function classifyForLayer(
  target: LayerName,
  sourceLayer: string,
  props: Record<string, unknown>,
): number | null {
  const kind = stringProp(props, "kind");
  switch (target) {
    case "buildings":
      if (sourceLayer !== "buildings") return null;
      return mapBuildingClass(kind);
    case "water":
      if (sourceLayer !== "water") return null;
      return 1;
    case "landuse":
      if (sourceLayer !== "landuse" && sourceLayer !== "natural") return null;
      return classifyLanduse(kind);
    case "roads": {
      if (sourceLayer !== "roads") return null;
      const c = classifyRoad(kind);
      if (c === 0 && !isCarRoadKind(kind)) return null;
      return c;
    }
    case "rail": {
      if (sourceLayer !== "roads") return null;
      if (!isRailKind(kind)) return null;
      return classifyRail(kind);
    }
    case "paths": {
      if (sourceLayer !== "roads") return null;
      if (!isPathKind(kind)) return null;
      return classifyPath(kind);
    }
    case "pois": {
      if (sourceLayer !== "pois" && sourceLayer !== "places") return null;
      return mapPoiClass(kind);
    }
  }
  return null;
}

function isCarRoadKind(k: string | undefined) {
  if (!k) return false;
  return [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "service",
    "unclassified",
    "living_street",
  ].includes(k);
}
function isRailKind(k: string | undefined) {
  if (!k) return false;
  return ["rail", "subway", "light_rail", "tram", "monorail"].includes(k);
}
function isPathKind(k: string | undefined) {
  if (!k) return false;
  return ["footway", "path", "cycleway", "pedestrian", "steps"].includes(k);
}

function mapBuildingClass(kind: string | undefined): number {
  if (!kind) return BuildingClass.unknown;
  const k = kind.toLowerCase();
  if (k.includes("residential") || k === "apartments" || k === "house") return BuildingClass.residential;
  if (k.includes("commercial") || k === "office" || k === "retail") return BuildingClass.commercial;
  if (k.includes("industrial") || k === "warehouse") return BuildingClass.industrial;
  if (k === "church" || k === "mosque" || k === "temple" || k === "synagogue") return BuildingClass.religious;
  if (k === "civic" || k === "government" || k === "public") return BuildingClass.civic;
  if (k === "train_station" || k === "station") return BuildingClass.transit;
  return BuildingClass.unknown;
}

function mapPoiClass(kind: string | undefined): number {
  if (!kind) return PoiClass.unknown;
  const k = kind.toLowerCase();
  if (k === "bus_stop") return PoiClass.bus_stop;
  if (k === "station" || k === "railway_station") return PoiClass.station;
  if (k === "subway_entrance") return PoiClass.subway_entrance;
  if (k === "tram_stop") return PoiClass.tram_stop;
  return PoiClass.unknown;
}

function stringProp(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" ? v : undefined;
}
function numericProp(p: Record<string, unknown>, k: string, dflt: number): number {
  const v = p[k];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : dflt;
  }
  return dflt;
}

function triangulateAndAppend(
  accum: FeatureAccum,
  rings: { x: number; y: number }[][],
  box: MetersBox,
  extent: number,
) {
  // Flatten rings to one positions array + holes index array for earcut.
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
  if (flat.length < 6) return; // not enough for a triangle
  const tri = earcut(flat, holes);
  if (tri.length === 0) return;
  for (let i = 0; i < flat.length; i++) accum.positions.push(flat[i]);
  for (let i = 0; i < tri.length; i++) accum.indices.push(baseVertex + tri[i]);
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
  // Rough estimate for attributes.
  n += JSON.stringify(t.attributes).length * 2;
  return n;
}

// ────────────────────────────────────────────────────────────────────────────
// Transfer list assembly (all SoA buffers).
// ────────────────────────────────────────────────────────────────────────────
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
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// RPC dispatcher
// ────────────────────────────────────────────────────────────────────────────
ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = e.data;
  try {
    if (type === "init") {
      const { url } = payload as { url: string };
      source = new PMTilesSource(url);
      reply(id, true, { ok: true });
    } else if (type === "fetchTile") {
      if (!source) throw new Error("worker not initialised — call init first");
      const { z, x, y } = payload as { z: number; x: number; y: number };
      const bytes = await source.getTile(z, x, y);
      if (!bytes) {
        reply(id, true, { missing: true, z, x, y });
        return;
      }
      const parsed = parseTile(z, x, y, bytes);
      reply(id, true, { tile: parsed, missing: false }, transferablesOf(parsed));
    } else {
      throw new Error(`unknown message type: ${type}`);
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

