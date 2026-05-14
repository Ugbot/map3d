// Tile-driven street-light layer. Samples positions along the *road* layer's
// polylines every ~40 m and instances a lamp-post mesh at each. The head has
// a strong emissive that bloom amplifies at night.
//
// We don't cast actual light into the scene (WebGL forward rendering tops out
// at a handful of real lights). Bloom over emissive heads sells the night
// scene visually at no GPU cost beyond the existing post-processing pass.

import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { assert, assertFinite, assertU32, checkLoopBound } from "@map3d/data-core";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";
import { RoadClass } from "../../cache/classes";
import {
  assertLayerGeometry,
  assertOrigin,
  MAX_FEATURES_PER_TILE,
  MAX_VERTICES_PER_TILE,
} from "./util";

// Sparser, taller posts — the real lamps below carry the light, so we don't
// need a forest of meshes. Roughly 1 lamp every ~100 m of road, both sides.
const SAMPLE_INTERVAL_M = 100;
const POST_HEIGHT_M = 8;
const PER_TILE_CAP = 2000;

// Sets of road classes that get street lights. Service roads / unclassified
// stay dark — same as real life.
const LIT_CLASSES = new Set<number>([
  RoadClass.motorway,
  RoadClass.trunk,
  RoadClass.primary,
  RoadClass.secondary,
  RoadClass.tertiary,
  RoadClass.residential,
  RoadClass.unclassified,
  RoadClass.living_street,
]);

function lampGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.15, 0.2, POST_HEIGHT_M, 6);
  pole.translate(0, POST_HEIGHT_M / 2, 0);
  // Small overhead head — a flat horizontal lozenge so the bloom kernel reads
  // it as a point source from oblique angles too.
  const head = new THREE.BoxGeometry(1.4, 0.4, 0.6);
  head.translate(0, POST_HEIGHT_M + 0.2, 0);
  return mergeGeometries([pole, head], false) ?? pole;
}

interface Handle extends TileMeshHandle {
  mesh: THREE.InstancedMesh;
  /** Head-of-lamp world positions (one per instance) for real-light pickers. */
  positions: Float32Array;
}

export class StreetLightsLayer implements Layer {
  readonly name: LayerName = "streetlights";
  readonly root = new THREE.Group();
  readonly material: MeshStandardNodeMaterial;
  private headMaterial: MeshStandardNodeMaterial;
  private geo: THREE.BufferGeometry;
  private handles = new Map<string, Handle>();

  constructor() {
    this.root.name = "layer:streetlights";
    this.geo = lampGeometry();
    // One material covers both pole and head (single instanced mesh). We
    // emissive the whole thing — pole shows a subtle warm tint, head is the
    // bright bit that bloom catches.
    this.material = new MeshStandardNodeMaterial({
      color: 0x2a2622,
      emissive: 0xffd28a,
      emissiveIntensity: 0,
      roughness: 0.7,
      metalness: 0.5,
    });
    this.headMaterial = this.material;
  }

  load(tile: ParsedTile, _g: LayerGeometry, ctx: LayerContext): TileMeshHandle | null {
    assertU32(tile.z, "StreetLightsLayer.load: tile.z");
    assertU32(tile.x, "StreetLightsLayer.load: tile.x");
    assertU32(tile.y, "StreetLightsLayer.load: tile.y");
    assertOrigin(ctx.sceneOrigin, "StreetLightsLayer.load");
    // We don't use the LayerGeometry passed in — we read the *roads* layer
    // from the parsed tile instead. TileManager calls `load` once per layer
    // alias; for streetlights we explicitly piggy-back on roads data.
    const roads = tile.layers.roads;
    if (!roads || roads.kind !== "line") return null;
    assertLayerGeometry(roads, "StreetLightsLayer.load: roads");

    const positions = sampleAlongRoads(roads, ctx.sceneOrigin);
    if (positions.length === 0) return null;
    assert(positions.length % 3 === 0, "StreetLightsLayer.load: positions length not multiple of 3");
    const count = Math.min(PER_TILE_CAP, positions.length / 3);
    assertU32(count, "StreetLightsLayer.load: instance count");
    const mesh = new THREE.InstancedMesh(this.geo, this.material, count);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      checkLoopBound(i, PER_TILE_CAP + 1, "StreetLightsLayer.load: instance walk");
      m.makeTranslation(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.layer = "streetlights";
    mesh.userData.tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    this.root.add(mesh);
    // Lamp head world positions (use POST_HEIGHT_M for the bulb height).
    const headPositions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      checkLoopBound(i, PER_TILE_CAP + 1, "StreetLightsLayer.load: head walk");
      headPositions[i * 3 + 0] = positions[i * 3 + 0];
      headPositions[i * 3 + 1] = POST_HEIGHT_M + 0.2;
      headPositions[i * 3 + 2] = positions[i * 3 + 2];
    }

    const handle: Handle = {
      mesh,
      positions: headPositions,
      dispose: () => {
        this.root.remove(mesh);
        mesh.dispose();
        this.handles.delete(mesh.userData.tileKey as string);
      },
    };
    this.handles.set(mesh.userData.tileKey as string, handle);
    return handle;
  }

  /** All lamp head positions across all loaded tiles. Engine uses this to
   *  drive a pool of real PointLights near the camera. */
  allHeadPositions(): Float32Array[] {
    const out: Float32Array[] = [];
    for (const h of this.handles.values()) out.push(h.positions);
    return out;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }
  setOpacity(v: number): void {
    this.material.opacity = v;
    this.material.transparent = v < 1;
  }

  update(_t: number, sunAltitude: number, glow: number): void {
    assertFinite(sunAltitude, "StreetLightsLayer.update: sunAltitude");
    assertFinite(glow, "StreetLightsLayer.update: glow");
    // The mesh itself only carries enough emissive to make the bulb visible
    // as a glow point; the actual lighting on surrounding geometry is done by
    // the real PointLight pool that follows the camera. Without this dial-
    // down everything went sodium-yellow at night.
    const night = Math.max(0, -sunAltitude);
    this.headMaterial.emissiveIntensity = night * 0.8 * (0.4 + glow * 0.6);
  }
}

// Sample (x, y, z) positions along every lit road in the tile at fixed
// arc-length intervals. Both sides of the road get a lamp (offset by half the
// road width on the perp normal). Output is a flat Float32Array (n*3).
function sampleAlongRoads(
  g: LayerGeometry,
  origin: { x: number; y: number },
): Float32Array {
  assertOrigin(origin, "sampleAlongRoads");
  const vertCountTotal = g.positions.length / 2;
  const out: number[] = [];
  const fc = g.featureIds.length;
  assert(fc <= MAX_FEATURES_PER_TILE, `sampleAlongRoads: feature count ${fc} exceeds cap`);
  for (let fi = 0; fi < fc; fi++) {
    checkLoopBound(fi, MAX_FEATURES_PER_TILE, "sampleAlongRoads: feature walk");
    const cls = g.featureClass[fi];
    if (!LIT_CLASSES.has(cls)) continue;
    const vStart = g.featureStart[fi];
    const vEnd = g.featureStart[fi + 1];
    assert(
      vStart <= vEnd && vEnd <= vertCountTotal,
      `sampleAlongRoads: bad featureStart range [${vStart},${vEnd}]`,
    );
    if (vEnd - vStart < 2) continue;
    // Build local XZ polyline (subtract origin, flip Y → -Z).
    const ptCount = vEnd - vStart;
    const pts = new Float32Array(ptCount * 2);
    for (let i = 0; i < ptCount; i++) {
      checkLoopBound(i, MAX_VERTICES_PER_TILE, "sampleAlongRoads: pt walk");
      pts[i * 2] = g.positions[(vStart + i) * 2] - origin.x;
      pts[i * 2 + 1] = -(g.positions[(vStart + i) * 2 + 1] - origin.y);
    }
    // Walk arc length and drop a pair at every SAMPLE_INTERVAL_M.
    let segDist = 0;
    let nextDrop = SAMPLE_INTERVAL_M * 0.5;
    for (let i = 1; i < ptCount; i++) {
      checkLoopBound(i, MAX_VERTICES_PER_TILE, "sampleAlongRoads: segment walk");
      const ax = pts[(i - 1) * 2];
      const az = pts[(i - 1) * 2 + 1];
      const bx = pts[i * 2];
      const bz = pts[i * 2 + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-3) continue;
      const tx = dx / segLen;
      const tz = dz / segLen;
      // Perp normal in XZ for the cross-street offset.
      const nx = -tz;
      const nz = tx;
      const offset = lampOffsetForClass(cls);
      let acc = 0;
      let dropIter = 0;
      while (acc + (nextDrop - segDist) <= segLen) {
        // Bound: ≤ PER_TILE_CAP lamps will be kept; allow some headroom
        // because the function emits both sides and we cap downstream.
        checkLoopBound(dropIter++, PER_TILE_CAP * 4, "sampleAlongRoads: drop walk");
        const along = nextDrop - segDist + acc;
        const cx = ax + tx * along;
        const cz = az + tz * along;
        // Two lamps per drop — one each side of the road.
        out.push(cx + nx * offset, 0, cz + nz * offset);
        out.push(cx - nx * offset, 0, cz - nz * offset);
        acc += SAMPLE_INTERVAL_M;
        nextDrop += SAMPLE_INTERVAL_M;
      }
      segDist += segLen;
    }
  }
  return new Float32Array(out);
}

// Offset from road centreline = half road width + small kerb pad.
function lampOffsetForClass(cls: number): number {
  // Mirror RoadWidthM but slightly outside so the lamp sits on the kerb.
  switch (cls) {
    case RoadClass.motorway: return 26;
    case RoadClass.trunk: return 22;
    case RoadClass.primary: return 18;
    case RoadClass.secondary: return 14;
    case RoadClass.tertiary: return 11;
    case RoadClass.residential: return 9;
    case RoadClass.living_street: return 7;
    case RoadClass.unclassified: return 8;
    default: return 6;
  }
}
