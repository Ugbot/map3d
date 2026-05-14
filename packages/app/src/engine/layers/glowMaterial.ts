// Selection-aware material. WebGPU port — uses MeshStandardNodeMaterial so
// Three's WebGPU light-node registry binds correctly to DirectionalLight /
// HemisphereLight. The `selected` per-vertex highlight that used to ride on
// top of the shader via onBeforeCompile is deferred — Stage 2 reinstates it
// via a TSL node graph. Picking still functions; the visual ring is the only
// thing missing.

import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { assertFinite, assertInRange } from "@map3d/data-core";

export interface GlowMaterialOptions {
  baseColor: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  flatShading?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
  vertexColors?: boolean;
}

export function makeGlowMaterial(opts: GlowMaterialOptions): MeshStandardNodeMaterial {
  if (opts.emissiveIntensity !== undefined) {
    assertFinite(opts.emissiveIntensity, "makeGlowMaterial: emissiveIntensity");
  }
  if (opts.metalness !== undefined) assertInRange(opts.metalness, 0, 1, "makeGlowMaterial: metalness");
  if (opts.roughness !== undefined) assertInRange(opts.roughness, 0, 1, "makeGlowMaterial: roughness");
  if (opts.opacity !== undefined) assertInRange(opts.opacity, 0, 1, "makeGlowMaterial: opacity");
  const offset = opts.polygonOffsetFactor !== undefined || opts.polygonOffsetUnits !== undefined;
  return new MeshStandardNodeMaterial({
    color: opts.baseColor,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    metalness: opts.metalness ?? 0,
    roughness: opts.roughness ?? 0.85,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
    polygonOffset: offset,
    polygonOffsetFactor: opts.polygonOffsetFactor ?? 0,
    polygonOffsetUnits: opts.polygonOffsetUnits ?? 0,
    vertexColors: opts.vertexColors ?? false,
  });
}
