// Minimal tile geometry shape that Simulation needs. The app's richer
// `ParsedTile` (cache/types.ts) is a structural superset of `SimTile`, so the
// app can pass its tiles directly without any conversion.

export interface SimLineGeometry {
  kind: "line";
  /** 2D Web Mercator absolute metres, x0,y0, x1,y1, ... */
  positions: Float32Array;
  /** featureStart[i] = first vertex index of feature i in positions. */
  featureStart: Uint32Array;
  featureIds: Uint32Array;
  featureClass: Uint8Array;
}

export interface SimTile {
  z: number;
  x: number;
  y: number;
  layers: {
    roads?: SimLineGeometry;
    rail?: SimLineGeometry;
    paths?: SimLineGeometry;
  } & Record<string, { kind: string } | undefined>;
}
