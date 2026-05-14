// Protomaps v4 vector tile schema. `kind` is a coarse bucket (e.g.
// "major_road", "rail", "path"); `kind_detail` is the original OSM tag.

import type { LayerName } from "../types";
import {
  classifyRoad,
  classifyRail,
  classifyPath,
  classifyLanduse,
  classifyLandcover,
  classifyWaterway,
  PoiClass,
  BuildingClass,
} from "../classes";
import type { Schema, SchemaFeatureProps } from "./types";

const ALIASES: Record<LayerName, readonly string[]> = {
  earth: ["earth"],
  landcover: ["landcover", "natural"],
  landuse: ["landuse"],
  water: ["water"],
  waterway: ["water"],
  paths: ["roads"],
  roads: ["roads"],
  rail: ["roads", "transit"],
  buildings: ["buildings"],
  streetlights: [],
  pois: ["pois"],
  aircraft: [],
  vessels: [],
};

const EXPECTED_TYPE: Record<LayerName, 1 | 2 | 3> = {
  earth: 3,
  landcover: 3,
  landuse: 3,
  water: 3,
  waterway: 2,
  paths: 2,
  roads: 2,
  rail: 2,
  buildings: 3,
  streetlights: 1,
  pois: 1,
  aircraft: 1,
  vessels: 1,
};

function s(p: SchemaFeatureProps, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" ? v : undefined;
}
function n(p: SchemaFeatureProps, k: string, dflt = 0): number {
  const v = p[k];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : dflt;
  }
  return dflt;
}

function isPathKind(k: string | undefined) {
  if (!k) return false;
  return ["footway", "path", "cycleway", "pedestrian", "steps"].includes(k);
}
function isRailKind(k: string | undefined) {
  if (!k) return false;
  return ["rail", "subway", "light_rail", "tram", "monorail"].includes(k);
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

export const protomapsV4: Schema = {
  aliases: ALIASES,
  expectedType: EXPECTED_TYPE,
  classify(target, sourceLayer, props) {
    const kind = s(props, "kind");
    const detail = s(props, "kind_detail") ?? kind;
    switch (target) {
      case "earth":
        if (sourceLayer !== "earth") return null;
        return 1;
      case "landcover":
        if (sourceLayer !== "natural") return null;
        return classifyLandcover(kind);
      case "landuse":
        if (sourceLayer !== "landuse") return null;
        return classifyLanduse(kind);
      case "water":
        if (sourceLayer !== "water") return null;
        return 1;
      case "waterway":
        if (sourceLayer !== "water") return null;
        return classifyWaterway(kind);
      case "buildings":
        if (sourceLayer !== "buildings") return null;
        return mapBuildingClass(detail);
      case "roads": {
        if (sourceLayer !== "roads") return null;
        const carBuckets = ["highway", "major_road", "medium_road", "minor_road", "other"];
        if (!kind || !carBuckets.includes(kind)) return null;
        const c = classifyRoad(detail ?? kind);
        if (c !== 0) return c;
        if (kind === "highway") return 1;
        if (kind === "major_road") return 3;
        if (kind === "medium_road") return 4;
        if (kind === "minor_road") return 6;
        return 8;
      }
      case "rail": {
        if (sourceLayer !== "roads" && sourceLayer !== "transit") return null;
        if (kind !== "rail" && !isRailKind(detail)) return null;
        return classifyRail(detail ?? "rail") || 1;
      }
      case "paths": {
        if (sourceLayer !== "roads") return null;
        if (kind !== "path" && !isPathKind(detail)) return null;
        return classifyPath(detail ?? "path") || 1;
      }
      case "pois": {
        if (sourceLayer !== "pois") return null;
        return PoiClass.unknown; // Protomaps v4 POIs lack the rich classification — bucket as unknown.
      }
    }
    return null;
  },
  heightFor(props) {
    return n(props, "height", 0);
  },
  minHeightFor(props) {
    return n(props, "min_height", 0);
  },
};
