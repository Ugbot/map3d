import { BuildingsLayer } from "./BuildingsLayer";
import { LineLayer } from "./LineLayer";
import { PolygonLayer } from "./PolygonLayer";
import { PoiLayer } from "./PoiLayer";
import { RoadWidthM, RailWidthM, PathWidthM } from "../../cache/classes";
import type { Layer } from "../Layer";
import type { LayerName } from "../../cache/types";

export function createAllLayers(): Record<LayerName, Layer> {
  return {
    landuse: new PolygonLayer({
      name: "landuse",
      baseColor: 0x2e4a2a,
      emissive: 0x0a1408,
      emissiveIntensity: 0.02,
      yLift: 0.02,
      opacity: 0.85,
    }),
    water: new PolygonLayer({
      name: "water",
      baseColor: 0x1e3a5f,
      emissive: 0x0a1a30,
      emissiveIntensity: 0.1,
      yLift: 0.05,
    }),
    paths: new LineLayer({
      name: "paths",
      baseColor: 0x6b6660,
      emissive: 0xffd49a,
      emissiveIntensity: 0.0,
      yLift: 0.08,
      width: (c) => PathWidthM[c] ?? PathWidthM[0],
    }),
    roads: new LineLayer({
      name: "roads",
      baseColor: 0x2a2d33,
      emissive: 0xffc66b,
      emissiveIntensity: 0.05,
      yLift: 0.12,
      width: (c) => RoadWidthM[c] ?? RoadWidthM[0],
    }),
    rail: new LineLayer({
      name: "rail",
      baseColor: 0x4a3a5c,
      emissive: 0xc18bff,
      emissiveIntensity: 0.2,
      yLift: 0.18,
      width: (c) => RailWidthM[c] ?? RailWidthM[0],
    }),
    buildings: new BuildingsLayer(),
    pois: new PoiLayer(),
  };
}
