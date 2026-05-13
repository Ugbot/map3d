// Point layer for POIs. One InstancedMesh per tile, per-instance position and
// colour from the SoA. Cone geometry (small) — barely visible from altitude,
// readable when you zoom in. Emissive ramps from 0 (noon) to bright (night).
// Tiles outside ~3 km from the camera are hidden — POI density would otherwise
// drown the scene.

import * as THREE from "three";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";
import { makeGlowMaterial } from "./glowMaterial";
import { PoiColor } from "../../cache/classes";

interface PoiHandle extends TileMeshHandle {
  mesh: THREE.InstancedMesh;
  centerX: number;
  centerZ: number;
}

const MAX_VISIBLE_DIST = 3000; // metres
const VISIBLE_DIST_SQ = MAX_VISIBLE_DIST * MAX_VISIBLE_DIST;

export class PoiLayer implements Layer {
  readonly name: LayerName = "pois";
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private geo: THREE.BufferGeometry;
  private handles = new Map<string, PoiHandle>();

  constructor() {
    this.root.name = "layer:pois";
    this.geo = new THREE.ConeGeometry(0.6, 1.5, 8);
    this.geo.translate(0, 0.75, 0);
    this.material = makeGlowMaterial({
      baseColor: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      metalness: 0.3,
      roughness: 0.4,
      vertexColors: true,
    });
    // InstancedMesh per-instance color requires this side-channel attribute.
  }

  load(tile: ParsedTile, g: LayerGeometry, ctx: LayerContext): TileMeshHandle | null {
    if (g.kind !== "point" || g.featureIds.length === 0) return null;
    const count = g.featureIds.length;
    const mesh = new THREE.InstancedMesh(this.geo, this.material, count);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < count; i++) {
      const v = g.featureStart[i];
      const x = g.positions[v * 2] - ctx.sceneOrigin.x;
      const z = -(g.positions[v * 2 + 1] - ctx.sceneOrigin.y);
      m.makeTranslation(x, 0, z);
      mesh.setMatrixAt(i, m);
      const hex = PoiColor[g.featureClass[i]] ?? PoiColor[0];
      c.setHex(hex);
      mesh.setColorAt(i, c);
      sumX += x;
      sumZ += z;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.layer = "pois";
    mesh.userData.tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    mesh.castShadow = true;
    this.root.add(mesh);
    const handle: PoiHandle = {
      mesh,
      centerX: sumX / count,
      centerZ: sumZ / count,
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

  // Engine calls update each frame. We use it for night-glow ramp + culling
  // distant tiles (POI density is the visual noise complaint).
  update(_t: number, sunAltitude: number, glow: number): void {
    const night = Math.max(0, -sunAltitude);
    this.material.emissiveIntensity = night * 0.9 * glow;
  }

  cullByCamera(cameraX: number, cameraZ: number): void {
    for (const h of this.handles.values()) {
      const dx = h.centerX - cameraX;
      const dz = h.centerZ - cameraZ;
      h.mesh.visible = dx * dx + dz * dz < VISIBLE_DIST_SQ;
    }
  }
}
