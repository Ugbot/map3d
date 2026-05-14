// Minimal tile geometry shape that Simulation needs. The app's richer
// `ParsedTile` (cache/types.ts) is a structural superset of `SimMaybeLine`,
// so the app can pass its tiles directly without any conversion. Simulation
// filters at runtime on `kind === "line"` before reading the buffers.

export interface SimMaybeLine {
  kind: string;
  /** 2D Web Mercator absolute metres, x0,y0, x1,y1, ... */
  positions: Float32Array;
  /** featureStart[i] = first vertex index of feature i in positions. */
  featureStart: Uint32Array;
  featureIds: Uint32Array;
  featureClass: Uint8Array;
}

/** Narrowed line view returned after the runtime `kind === "line"` check. */
export interface SimLineGeometry extends SimMaybeLine {
  kind: "line";
}

export interface SimTile {
  z: number;
  x: number;
  y: number;
  layers: {
    roads?: SimMaybeLine;
    rail?: SimMaybeLine;
    paths?: SimMaybeLine;
  };
}
