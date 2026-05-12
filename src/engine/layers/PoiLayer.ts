// Point layer for POIs (transit stops). Single InstancedMesh per tile,
// per-instance position from the SoA.

import * as THREE from "three";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";
import { makeGlowMaterial } from "./glowMaterial";

interface PoiHandle extends TileMeshHandle {
  mesh: THREE.InstancedMesh;
}

export class PoiLayer implements Layer {
  readonly name: LayerName = "pois";
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private geo: THREE.BufferGeometry;
  private handles = new Map<string, PoiHandle>();
  private baseEmissive = 1.0;

  constructor() {
    this.root.name = "layer:pois";
    this.geo = new THREE.CylinderGeometry(1.2, 1.2, 6, 8);
    this.geo.translate(0, 3, 0);
    this.material = makeGlowMaterial({
      baseColor: 0xffd166,
      emissive: 0xffaa33,
      emissiveIntensity: 1.0,
      metalness: 0.4,
      roughness: 0.3,
    });
  }

  load(tile: ParsedTile, g: LayerGeometry, ctx: LayerContext): TileMeshHandle | null {
    if (g.kind !== "point" || g.featureIds.length === 0) return null;
    const count = g.featureIds.length;
    // For points, featureStart[i] = vertex index of point i; one vert per point.
    const mesh = new THREE.InstancedMesh(this.geo, this.material, count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const v = g.featureStart[i];
      const x = g.positions[v * 2] - ctx.sceneOrigin.x;
      const z = -(g.positions[v * 2 + 1] - ctx.sceneOrigin.y);
      m.makeTranslation(x, 0, z);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.layer = "pois";
    mesh.userData.tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    this.root.add(mesh);
    const handle: PoiHandle = {
      mesh,
      dispose: () => {
        this.root.remove(mesh);
        mesh.dispose();
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
  update(_t: number, sunAltitude: number, glow: number): void {
    const night = Math.max(0, -sunAltitude);
    this.material.emissiveIntensity = this.baseEmissive + night * 2.0 * glow;
  }
}
