// OpenMapTiles vector tile schema (Tilezen / OpenFreeMap / MapTiler). Layers
// of interest:
//   building         (polygons; render_height, render_min_height)
//   landcover        (polygons; class, subclass — grass, wood, sand, ...)
//   landuse          (polygons; class — suburb, industrial, ...)
//   water            (polygons; class — ocean, lake, swimming_pool, ...)
//   waterway         (lines; class — river, stream, canal, ...)
//   transportation   (lines; class — motorway, primary, ..., rail, path, ...)
//   poi              (points; class — restaurant, hospital, ...)

import type { LayerName } from "../types";
import {
  RoadClass,
  RailClass,
  PathClass,
  LanduseClass,
  classifyLandcover,
  classifyWaterway,
  classifyPoiOMT,
  BuildingClass,
} from "../classes";
import type { Schema, SchemaFeatureProps } from "./types";

const ALIASES: Record<LayerName, readonly string[]> = {
  earth: [], // OMT has no global earth polygon; engine draws a synthetic plate per tile.
  landcover: ["landcover"],
  landuse: ["landuse"],
  water: ["water"],
  waterway: ["waterway"],
  paths: ["transportation"],
  roads: ["transportation"],
  rail: ["transportation"],
  buildings: ["building"],
  // Streetlights is a *derived* layer — it's synthesised on the main thread
  // from the roads SoA. No tile aliases needed.
  streetlights: [],
  pois: ["poi"],
  // Feed-driven layers — no tile aliases.
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

// OMT marks under-construction roads as `*_construction`. They're real roads
// for our purposes; treat them as their base class so we don't drop a big
// chunk of features in dense urban tiles.
function stripConstruction(cls: string): string {
  return cls.endsWith("_construction") ? cls.slice(0, -"_construction".length) : cls;
}

const ROAD_CAR_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "minor",
  "service",
  "tertiary_link",
  "secondary_link",
  "primary_link",
  "motorway_link",
  "trunk_link",
  "raceway",
]);
const RAIL_CLASSES = new Set(["rail", "transit"]);
const PATH_CLASSES = new Set(["path", "footway", "cycleway", "pedestrian", "steps", "track"]);

function omtRoadEnum(cls: string): number {
  switch (cls) {
    case "motorway":
    case "motorway_link":
      return RoadClass.motorway;
    case "trunk":
    case "trunk_link":
      return RoadClass.trunk;
    case "primary":
    case "primary_link":
      return RoadClass.primary;
    case "secondary":
    case "secondary_link":
      return RoadClass.secondary;
    case "tertiary":
    case "tertiary_link":
      return RoadClass.tertiary;
    case "minor":
      return RoadClass.residential;
    case "service":
    case "raceway":
      return RoadClass.service;
    default:
      return RoadClass.unclassified;
  }
}
function omtRailEnum(cls: string, subclass: string | undefined): number {
  if (cls === "transit") {
    if (subclass === "subway") return RailClass.subway;
    if (subclass === "tram") return RailClass.tram;
    if (subclass === "light_rail") return RailClass.light_rail;
    if (subclass === "monorail") return RailClass.monorail;
    return RailClass.rail;
  }
  return RailClass.rail;
}
function omtPathEnum(cls: string): number {
  switch (cls) {
    case "footway":
      return PathClass.footway;
    case "path":
    case "track":
      return PathClass.path;
    case "cycleway":
      return PathClass.cycleway;
    case "pedestrian":
      return PathClass.pedestrian;
    case "steps":
      return PathClass.steps;
    default:
      return PathClass.unknown;
  }
}
function omtLanduseEnum(cls: string): number {
  switch (cls) {
    case "residential":
    case "suburb":
    case "neighbourhood":
      return LanduseClass.residential;
    case "industrial":
      return LanduseClass.industrial;
    case "commercial":
      return LanduseClass.commercial;
    case "retail":
      return LanduseClass.retail;
    case "school":
    case "college":
    case "university":
      return LanduseClass.school;
    case "hospital":
      return LanduseClass.hospital;
    case "park":
    case "garden":
    case "nature_reserve":
    case "playground":
      return LanduseClass.park;
    case "cemetery":
      return LanduseClass.cemetery;
    case "stadium":
    case "pitch":
      return LanduseClass.pitch;
    default:
      return LanduseClass.unknown;
  }
}

export const openmaptiles: Schema = {
  aliases: ALIASES,
  expectedType: EXPECTED_TYPE,
  classify(target, sourceLayer, props) {
    switch (target) {
      case "earth":
        return null; // synthetic earth plate is added engine-side, not from tile.
      case "landcover": {
        if (sourceLayer !== "landcover") return null;
        return classifyLandcover(s(props, "class") ?? s(props, "subclass"));
      }
      case "landuse": {
        if (sourceLayer !== "landuse") return null;
        return omtLanduseEnum((s(props, "class") ?? "").toLowerCase());
      }
      case "water": {
        if (sourceLayer !== "water") return null;
        return 1;
      }
      case "waterway": {
        if (sourceLayer !== "waterway") return null;
        return classifyWaterway(s(props, "class"));
      }
      case "buildings": {
        if (sourceLayer !== "building") return null;
        return BuildingClass.unknown; // OMT doesn't carry subtype
      }
      case "roads": {
        if (sourceLayer !== "transportation") return null;
        const cls = stripConstruction((s(props, "class") ?? "").toLowerCase());
        if (!ROAD_CAR_CLASSES.has(cls)) return null;
        return omtRoadEnum(cls);
      }
      case "rail": {
        if (sourceLayer !== "transportation") return null;
        const cls = stripConstruction((s(props, "class") ?? "").toLowerCase());
        if (!RAIL_CLASSES.has(cls)) return null;
        return omtRailEnum(cls, s(props, "subclass"));
      }
      case "paths": {
        if (sourceLayer !== "transportation") return null;
        const cls = stripConstruction((s(props, "class") ?? "").toLowerCase());
        if (!PATH_CLASSES.has(cls)) return null;
        return omtPathEnum(cls);
      }
      case "pois": {
        if (sourceLayer !== "poi") return null;
        return classifyPoiOMT(s(props, "class"));
      }
    }
    return null;
  },
  heightFor(props) {
    return n(props, "render_height", n(props, "height", 0));
  },
  minHeightFor(props) {
    return n(props, "render_min_height", n(props, "min_height", 0));
  },
};
