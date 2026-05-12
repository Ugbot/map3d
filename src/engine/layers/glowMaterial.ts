// Selection-aware material. A per-vertex feature attribute carries a "selected"
// flag (0 or 1). Selected fragments add an emissive glow on top of the base
// colour, regardless of time-of-day.

import * as THREE from "three";

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
}

export function makeGlowMaterial(opts: GlowMaterialOptions): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: opts.baseColor,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    metalness: opts.metalness ?? 0,
    roughness: opts.roughness ?? 0.85,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
  });
  // Inject a `selected` vertex attribute that boosts emissive on hover/select.
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float selected;
varying float vSelected;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vSelected = selected;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying float vSelected;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(1.2, 0.9, 0.4) * vSelected;`,
      );
  };
  return m;
}
