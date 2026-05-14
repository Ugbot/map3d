// Public surface of the tile module. Both the browser app and the Node
// data-server import from here; nothing inside `tile/` is meant to be reached
// directly by consumers.

export {
  parseTile,
  approximateByteSize,
  type ParseTileArgs,
  type SchemaName,
  type SourceKind,
} from "./worker";
export {
  bakeRibbonMesh,
  type RibbonConfig,
  type BakedMesh,
} from "./ribbonGen";
export {
  IDBTileStore,
  tileCache,
  makeVersion,
} from "./cache";
export type {
  LayerName,
  GeometryKind,
  LayerGeometry,
  BakedLineMesh,
  ParsedTile,
  RawTile,
  TileStore,
} from "./types";
export type { Schema, SchemaFeatureProps } from "./schemas/types";
export { openmaptiles } from "./schemas/openmaptiles";
export { protomapsV4 } from "./schemas/protomapsV4";
export {
  RoadClass,
  RoadWidthM,
  RoadColor,
  RailClass,
  RailWidthM,
  RailColor,
  PathClass,
  PathColor,
  PathWidthM,
  BuildingClass,
  LanduseClass,
  PoiClass,
  PoiColor,
  WaterwayClass,
  WaterwayWidthM,
  LandcoverClass,
  LandcoverColor,
  classifyPoiOMT,
  classifyWaterway,
  classifyLandcover,
  classifyRoad,
  classifyRail,
  classifyPath,
  classifyLanduse,
  vesselTypeColor,
  earthBaseColorForLat,
  type RoadClassValue,
  type PoiClassValue,
} from "./classes";
export { WorkerPool, type WorkerRequest, type WorkerResponse } from "./pool";
