// Point layer for POIs. One InstancedMesh per tile, per-instance position and
// colour from the SoA. Cone geometry (small) — barely visible from altitude,
// readable when you zoom in. Emissive ramps from 0 (noon) to bright (night).
// Tiles outside ~3 km from the camera are hidden — POI density would otherwise
// drown the scene.

import * as THREE from "three";
import {
  assert,
  assertFinite,
  assertU32,
  checkLoopBound,
  PoiColor,
  type LayerGeometry,
  type LayerName,
  type ParsedTile,
} from "@map3d/data-core";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import { makeGlowMaterial } from "./glowMaterial";
import { assertOrigin, MAX_FEATURES_PER_TILE } from "./util";

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
    assertU32(tile.z, "PoiLayer.load: tile.z");
    assertU32(tile.x, "PoiLayer.load: tile.x");
    assertU32(tile.y, "PoiLayer.load: tile.y");
    assertOrigin(ctx.sceneOrigin, "PoiLayer.load");
    assert(g.positions.length % 2 === 0, "PoiLayer.load: positions not even");
    const count = g.featureIds.length;
    assert(
      count <= MAX_FEATURES_PER_TILE,
      `PoiLayer.load: count ${count} exceeds cap ${MAX_FEATURES_PER_TILE}`,
    );
    assert(
      g.featureStart.length >= count,
      "PoiLayer.load: featureStart shorter than featureIds",
    );
    const vertCountTotal = g.positions.length / 2;
    const mesh = new THREE.InstancedMesh(this.geo, this.material, count);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < count; i++) {
      checkLoopBound(i, MAX_FEATURES_PER_TILE, "PoiLayer.load: instance walk");
      const v = g.featureStart[i];
      assert(v < vertCountTotal, `PoiLayer.load: featureStart[${i}]=${v} OOB`);
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
  update(_t: number, _sunAltitude: number, _glow: number): void {
    // POIs no longer self-illuminate — they read by silhouette + the real
    // near-camera point lights cast by Engine.
    this.material.emissiveIntensity = 0;
  }

  cullByCamera(cameraX: number, cameraZ: number): void {
    assertFinite(cameraX, "PoiLayer.cullByCamera: cameraX");
    assertFinite(cameraZ, "PoiLayer.cullByCamera: cameraZ");
    for (const h of this.handles.values()) {
      const dx = h.centerX - cameraX;
      const dz = h.centerZ - cameraZ;
      h.mesh.visible = dx * dx + dz * dz < VISIBLE_DIST_SQ;
    }
  }
}
