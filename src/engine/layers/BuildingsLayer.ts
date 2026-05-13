import * as THREE from "three";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";
import { extrudePolygons } from "./util";
import { makeGlowMaterial } from "./glowMaterial";

// Deterministic 0.8..1.4 hash for visual variation when render_height is 0.
function jitter(tileKey: string, featureId: number): number {
  let h = 2166136261;
  const s = `${tileKey}:${featureId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 0.8 + (h & 0xff) / 0xff * 0.6;
}

interface BHandle extends TileMeshHandle {
  mesh: THREE.Mesh;
  featureRanges: Uint32Array; // length featureCount+1, index ranges into the geometry index buffer
  featureIds: Uint32Array;
  globalIds: string[]; // index-aligned with featureIds, built from tile key
  selectedAttr: THREE.BufferAttribute; // per-vertex selection flag (0 or 1)
  vertexFeatureMap: Uint32Array; // per-vertex → feature index (for fast selection apply)
}

export class BuildingsLayer implements Layer {
  readonly name: LayerName = "buildings";
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private handles = new Map<string, BHandle>();
  private highlighted: string | null = null;

  constructor() {
    this.root.name = "layer:buildings";
    this.material = makeGlowMaterial({
      baseColor: 0xc3c8d0,
      emissive: 0x1a1f2a,
      emissiveIntensity: 0.04,
      roughness: 0.72,
      metalness: 0.12,
    });
  }

  load(tile: ParsedTile, g: LayerGeometry, ctx: LayerContext): TileMeshHandle | null {
    const tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    const extruded = extrudePolygons(g, ctx.sceneOrigin, (_cls, fi) => {
      // Fallback when render_height isn't present: 12 m × per-feature jitter.
      const fid = g.featureIds[fi];
      return 12 * jitter(tileKey, fid);
    });
    if (!extruded) return null;
    const { geometry, featureRanges, featureIds } = extruded;
    if (featureIds.length === 0) {
      geometry.dispose();
      return null;
    }

    // Per-vertex selection flag + per-vertex featureIndex (for selection lookup).
    const vertCount = (geometry.getAttribute("position") as THREE.BufferAttribute).count;
    const selected = new Float32Array(vertCount);
    const vertexFeatureMap = new Uint32Array(vertCount);
    geometry.setAttribute("selected", new THREE.BufferAttribute(selected, 1));

    // Build vertexFeatureMap by walking the index ranges. Vertices are owned by
    // exactly one feature in our extrusion output (per-feature local vertices).
    const indexAttr = geometry.getIndex()!;
    for (let fi = 0; fi < featureIds.length; fi++) {
      const start = featureRanges[fi];
      const end = featureRanges[fi + 1];
      for (let i = start; i < end; i++) {
        vertexFeatureMap[indexAttr.getX(i)] = fi;
      }
    }

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.userData.layer = "buildings";
    mesh.userData.tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);

    const globalIds = new Array<string>(featureIds.length);
    for (let i = 0; i < featureIds.length; i++) {
      globalIds[i] = `${tileKey}:${featureIds[i]}`;
    }

    const handle: BHandle = {
      mesh,
      featureRanges,
      featureIds,
      globalIds,
      selectedAttr: geometry.getAttribute("selected") as THREE.BufferAttribute,
      vertexFeatureMap,
      dispose: () => {
        this.root.remove(mesh);
        geometry.dispose();
      },
    };
    this.handles.set(tileKey, handle);
    return handle;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }
  setOpacity(v: number): void {
    this.material.opacity = v;
    this.material.transparent = v < 1;
    this.material.needsUpdate = true;
  }

  highlight(featureGlobalId: string | null): void {
    if (this.highlighted === featureGlobalId) return;
    // Clear previous
    if (this.highlighted) this.applyHighlight(this.highlighted, 0);
    this.highlighted = featureGlobalId;
    if (featureGlobalId) this.applyHighlight(featureGlobalId, 1);
  }

  private applyHighlight(globalId: string, value: number) {
    const sep = globalId.lastIndexOf(":");
    const tileKey = globalId.slice(0, sep);
    const h = this.handles.get(tileKey);
    if (!h) return;
    let fi = -1;
    for (let i = 0; i < h.globalIds.length; i++) {
      if (h.globalIds[i] === globalId) {
        fi = i;
        break;
      }
    }
    if (fi < 0) return;
    const arr = h.selectedAttr.array as Float32Array;
    // Walk vertexFeatureMap and set.
    for (let v = 0; v < arr.length; v++) {
      if (h.vertexFeatureMap[v] === fi) arr[v] = value;
    }
    h.selectedAttr.needsUpdate = true;
  }

  // Raycast hook used by the engine's selection picker.
  pickFeature(mesh: THREE.Mesh, faceIndex: number): string | null {
    const tileKey = mesh.userData.tileKey as string;
    const h = this.handles.get(tileKey);
    if (!h) return null;
    const indexAttr = mesh.geometry.getIndex()!;
    const indexPos = faceIndex * 3;
    // Find the feature whose range contains indexPos.
    let lo = 0;
    let hi = h.featureRanges.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (h.featureRanges[mid + 1] <= indexPos) lo = mid + 1;
      else hi = mid;
    }
    void indexAttr;
    return h.globalIds[lo] ?? null;
  }
}
