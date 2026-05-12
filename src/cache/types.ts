// Shared SoA types for tile geometry. Engineered for transferable buffers
// (worker -> main) and IndexedDB persistence (structured-clone friendly).
//
// Composability note: these are the *only* shapes the renderer consumes.
// A remote backend can produce identical buffers and hand them to the engine
// over the wire without touching the renderer.

export type LayerName =
  | "buildings"
  | "roads"
  | "rail"
  | "water"
  | "landuse"
  | "paths"
  | "pois";

export type GeometryKind = "polygon" | "line" | "point";

export interface LayerGeometry {
  kind: GeometryKind;
  // 2D Web Mercator absolute meters: x0,y0, x1,y1, ...
  positions: Float32Array;
  // Triangle indices into positions (polygon only).
  indices?: Uint32Array;
  // For polygons: featureStart[i] = first *index* of feature i in indices.
  // For lines/points: featureStart[i] = first *vertex* of feature i in positions.
  // Sentinel last entry = total count. Length = featureCount + 1.
  featureStart: Uint32Array;
  // Tile-local feature id (stable within tile/version).
  featureIds: Uint32Array;
  // Numeric class enum (per-layer meaning — see classes.ts).
  featureClass: Uint8Array;
  // Buildings: extrusion height in metres; 0 elsewhere.
  featureHeight: Float32Array;
  // Buildings: base offset (min_height) in metres; 0 elsewhere.
  featureMinHeight: Float32Array;
}

export interface ParsedTile {
  z: number;
  x: number;
  y: number;
  // Version of the layer schema / source data; bump to invalidate caches.
  version: number;
  // Per-layer SoA buffers. Absent layer = nothing to draw for it in this tile.
  layers: Partial<Record<LayerName, LayerGeometry>>;
  // Per-feature attribute records, keyed by `${layerName}:${featureId}`.
  // Kept sparse — most features have no popup-worthy data.
  attributes: Record<string, Record<string, string | number>>;
  // Bytes consumed (approximate, for cache budgeting).
  byteSize: number;
}

export interface RawTile {
  z: number;
  x: number;
  y: number;
  version: number;
  bytes: ArrayBuffer;
}

// Storage abstraction. Both an IndexedDB impl and a remote-fetch impl can
// satisfy this — that's the composability hook for moving to a backend.
export interface TileStore {
  getRaw(z: number, x: number, y: number, version: number): Promise<RawTile | undefined>;
  putRaw(tile: RawTile): Promise<void>;
  getParsed(z: number, x: number, y: number, version: number): Promise<ParsedTile | undefined>;
  putParsed(tile: ParsedTile): Promise<void>;
  evictTo(byteBudget: number): Promise<void>;
  clear(): Promise<void>;
}
