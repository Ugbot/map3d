// Biome-tinted polygon layer. One Mesh per tile; per-vertex colour selected
// from the LandcoverColor palette by the feature's class.

import * as THREE from "three";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";
import { makeGlowMaterial } from "./glowMaterial";
import { LandcoverColor } from "../../cache/classes";

interface Handle extends TileMeshHandle {
  mesh: THREE.Mesh;
}

export class LandcoverLayer implements Layer {
  readonly name: LayerName = "landcover";
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private handles = new Map<string, Handle>();

  constructor(yLift = 0) {
    this.root.name = "layer:landcover";
    this.root.position.y = yLift;
    this.material = makeGlowMaterial({
      baseColor: 0xffffff,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffsetFactor: 6,
      polygonOffsetUnits: 6,
      vertexColors: true,
    });
  }

  load(tile: ParsedTile, g: LayerGeometry, ctx: LayerContext): TileMeshHandle | null {
    if (g.kind !== "polygon" || !g.indices || g.featureIds.length === 0) return null;
    const vertCount = g.positions.length / 2;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      positions[i * 3 + 0] = g.positions[i * 2] - ctx.sceneOrigin.x;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = -(g.positions[i * 2 + 1] - ctx.sceneOrigin.y);
    }
    // Walk featureStart ranges and stamp the per-feature colour onto each of
    // the vertices that feature's triangles touch.
    const cTmp = new THREE.Color();
    for (let fi = 0; fi < g.featureIds.length; fi++) {
      const cls = g.featureClass[fi];
      const hex = LandcoverColor[cls] ?? LandcoverColor[0];
      cTmp.setHex(hex);
      const idxStart = g.featureStart[fi];
      const idxEnd = g.featureStart[fi + 1];
      for (let i = idxStart; i < idxEnd; i++) {
        const v = g.indices[i];
        colors[v * 3 + 0] = cTmp.r;
        colors[v * 3 + 1] = cTmp.g;
        colors[v * 3 + 2] = cTmp.b;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.setIndex(new THREE.BufferAttribute(g.indices, 1));
    geom.computeVertexNormals();

    const mesh = new THREE.Mesh(geom, this.material);
    mesh.userData.layer = "landcover";
    mesh.userData.tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    const handle: Handle = {
      mesh,
      dispose: () => {
        this.root.remove(mesh);
        geom.dispose();
      },
    };
    this.handles.set(`${tile.z}/${tile.x}/${tile.y}`, handle);
    return handle;
  }
  setVisible(v: boolean): void {
    this.root.visible = v;
  }
  setOpacity(v: number): void {
    this.material.opacity = v;
    this.material.transparent = v < 1;
  }
}
