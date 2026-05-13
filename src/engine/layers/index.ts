import { BuildingsLayer } from "./BuildingsLayer";
import { LineLayer } from "./LineLayer";
import { PolygonLayer } from "./PolygonLayer";
import { PoiLayer } from "./PoiLayer";
import { LandcoverLayer } from "./LandcoverLayer";
import { StreetLightsLayer } from "./StreetLightsLayer";
import { AircraftLayer } from "./feeds/AircraftLayer";
import { VesselLayer } from "./feeds/VesselLayer";
import {
  RoadWidthM,
  RailWidthM,
  PathWidthM,
  WaterwayWidthM,
} from "../../cache/classes";
import {
  roadTexture,
  ROAD_TEXTURE_LENGTH_M,
  ROAD_SIDE_UV,
  railTexture,
  RAIL_TEXTURE_LENGTH_M,
  RAIL_SIDE_UV,
} from "./roadTextures";
import type { RibbonConfig } from "../../workers/ribbonGen";
import type { Layer } from "../Layer";
import type { LayerName } from "../../cache/types";

// Physical Y stack — 0.5 m steps, big enough that the depth buffer can
// resolve them even at very oblique camera angles. Polygon offset is gone;
// real geometry separation is more reliable.
const Y_EARTH = 0;
const Y_LANDCOVER = 0.5;
const Y_LANDUSE = 1.0;
const Y_WATER = 1.5;
const Y_WATERWAY = 2.0;
const Y_PATHS = 2.5;
const Y_ROADS = 3.0;
const Y_RAIL = 4.0;

export function createAllLayers(_centerLat: number): Record<LayerName, Layer> {
  return {
    earth: new PolygonLayer({
      // Neutral dark warm-grey so light grey roads always pop. The biome
      // tinting was pretty but fought with road contrast.
      name: "earth",
      baseColor: 0x2c2826,
      opacity: 1,
      yLift: Y_EARTH,
    }),
    landcover: new LandcoverLayer(Y_LANDCOVER),
    landuse: new PolygonLayer({
      name: "landuse",
      // Muted urban green-grey. Opaque — transparent stacking was the
      // direct cause of the horizon-line flicker.
      baseColor: 0x44503a,
      emissive: 0x0a0e08,
      emissiveIntensity: 0.02,
      opacity: 1,
      yLift: Y_LANDUSE,
    }),
    water: new PolygonLayer({
      name: "water",
      baseColor: 0x1e3a5f,
      emissive: 0x0a1a30,
      emissiveIntensity: 0.08,
      yLift: Y_WATER,
    }),
    waterway: new LineLayer({
      name: "waterway",
      baseColor: 0x3877be,
      emissive: 0x123a5e,
      emissiveIntensity: 0.05,
      yLift: Y_WATERWAY,
      thickness: 0.5,
      width: (c) => WaterwayWidthM[c] ?? WaterwayWidthM[0],
      glowAtNight: false,
    }),
    paths: new LineLayer({
      name: "paths",
      baseColor: 0xa89880,
      emissive: 0xfff2dc,
      emissiveIntensity: 0.1,
      yLift: Y_PATHS,
      thickness: 0.6,
      width: (c) => PathWidthM[c] ?? PathWidthM[0],
    }),
    roads: new LineLayer({
      name: "roads",
      // White base so the procedural texture carries the look. No emissive —
      // the texture is enough; roads should look like asphalt at night too,
      // not glow. Use bloom on the *agents* to sell night vibes.
      baseColor: 0xffffff,
      emissive: 0x000000,
      emissiveIntensity: 0,
      glowAtNight: false,
      yLift: Y_ROADS,
      thickness: 1.2,
      width: (c) => RoadWidthM[c] ?? RoadWidthM[0],
      texture: roadTexture(),
      textureLengthM: ROAD_TEXTURE_LENGTH_M,
      textureSideUV: ROAD_SIDE_UV,
    }),
    rail: new LineLayer({
      name: "rail",
      baseColor: 0xffffff,
      emissive: 0xb070ff,
      emissiveIntensity: 0.1,
      yLift: Y_RAIL,
      thickness: 1.6,
      width: (c) => RailWidthM[c] ?? RailWidthM[0],
      texture: railTexture(),
      textureLengthM: RAIL_TEXTURE_LENGTH_M,
      textureSideUV: RAIL_SIDE_UV,
    }),
    buildings: new BuildingsLayer(),
    streetlights: new StreetLightsLayer(),
    pois: new PoiLayer(),
    aircraft: new AircraftLayer(),
    vessels: new VesselLayer(),
  };
}

/**
 * Layers that derive their geometry from another layer's tile data rather
 * than having their own worker output. TileManager routes the right source
 * data to their `load()`.
 */
export const DERIVED_SOURCES: Partial<Record<LayerName, LayerName>> = {
  streetlights: "roads",
};

/**
 * Ribbon-bake configs for the worker. Mirrors the LineLayer settings above —
 * keep them in sync if you tune widths/thicknesses/textures.
 */
export function ribbonConfigsForWorker(): Partial<Record<LayerName, RibbonConfig>> {
  return {
    waterway: {
      thickness: 0.5,
      widthByClass: { ...WaterwayWidthM },
    },
    paths: {
      thickness: 0.6,
      widthByClass: { ...PathWidthM },
    },
    roads: {
      thickness: 1.2,
      widthByClass: { ...RoadWidthM },
      textureLengthM: ROAD_TEXTURE_LENGTH_M,
      textureSideUV: ROAD_SIDE_UV,
    },
    rail: {
      thickness: 1.6,
      widthByClass: { ...RailWidthM },
      textureLengthM: RAIL_TEXTURE_LENGTH_M,
      textureSideUV: RAIL_SIDE_UV,
    },
  };
}
