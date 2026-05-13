// Common Layer contract. Anything that produces meshes for a (z,x,y) tile
// implements this. The engine never touches Three.js internals of a layer —
// it only adds/removes the layer's root Object3D from the scene and toggles
// .visible / opacity. That's what keeps layers composable and lets you
// substitute remote-rendered layers in later.

import type { Group, Material } from "three";
import type { LayerGeometry, LayerName, ParsedTile } from "../cache/types";

export interface LayerContext {
  // Origin (in mercator metres) the engine has chosen for scene-local coords.
  // Subtract from positions to keep float32 precision usable near the camera.
  sceneOrigin: { x: number; y: number };
  // Selection hook — call this when a feature is clicked (raycast hit).
  onSelect: (layer: LayerName, featureGlobalId: string) => void;
}

export interface TileMeshHandle {
  // Anything you need on eviction. Engine calls dispose() then removes the
  // handle's `object` from the layer root.
  dispose(): void;
}

export interface Layer {
  readonly name: LayerName;
  readonly root: Group;
  readonly material: Material | Material[];
  // Build whatever meshes this layer wants from the SoA buffers and attach
  // them to root. Return a handle the engine stores against (tileKey,layer).
  load(tile: ParsedTile, geometry: LayerGeometry, ctx: LayerContext): TileMeshHandle | null;
  // Per-frame hook (animations, hover, time-of-day).
  update?(timeSec: number, sunAltitude: number, glow: number): void;
  // Highlight a single feature (or null to clear). Optional.
  highlight?(featureGlobalId: string | null): void;
  setVisible(v: boolean): void;
  setOpacity(v: number): void;
}
