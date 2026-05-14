// Shared base for live-feed layers (aircraft, vessels).
//
// Reads entity state directly from the data-core bitECS world each frame —
// no local state map, no dead-reckoning. Trails are owned here (rendering
// concern, not data) as per-eid ring buffers.

import * as THREE from "three";
import { MeshStandardNodeMaterial, LineBasicNodeMaterial } from "three/webgpu";
import type { Layer, LayerContext, TileMeshHandle } from "../../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "@map3d/data-core";
import {
  FLAG_IS_FEED,
  FLAG_ON_GROUND,
  query,
  type Map3dWorld,
} from "@map3d/data-core";

export interface FeedLayerOpts {
  name: LayerName;
  /** Kind code in the world (KIND_FEED_AIRCRAFT / KIND_FEED_VESSEL). */
  kindCode: number;
  capacity: number;
  agentGeometry: THREE.BufferGeometry;
  agentMaterial: MeshStandardNodeMaterial;
  trailMaxSamples: number;
  trailSampleS: number;
  trailColor: THREE.Color;
  /** Override Y for entity scene position (e.g. fixed water height for vessels).
   *  Returning null = use world's Position.y unchanged. */
  yOverride: ((worldY: number) => number) | null;
  /** Hide an entity when on-ground flag set (aircraft only). */
  hideOnGround: boolean;
}

interface Trail {
  /** Ring of (sx, sy, sz, ts) floats. */
  ring: Float32Array;
  count: number;
  head: number;
  lastSampleS: number;
  /** Last seen position so we can stitch the live segment. */
  lastX: number;
  lastY: number;
  lastZ: number;
}

export class FeedLayerBase implements Layer {
  readonly root = new THREE.Group();
  readonly material: MeshStandardNodeMaterial;
  readonly name: LayerName;

  private opts: FeedLayerOpts;
  private mesh: THREE.InstancedMesh;
  private trailMesh: THREE.LineSegments;
  private trailPos: Float32Array;
  private trailCol: Float32Array;
  private trailGeom: THREE.BufferGeometry;
  private trails = new Map<number, Trail>();
  private world: Map3dWorld | null = null;
  /** Re-used per-frame to detect entities that disappeared. */
  private seenEids = new Set<number>();
  private dummy = new THREE.Object3D();
  private activeCount = 0;
  private lastTrailRebuildMs = 0;
  private static readonly TRAIL_REBUILD_MS = 200;

  constructor(opts: FeedLayerOpts) {
    this.opts = opts;
    this.name = opts.name;
    this.root.name = `layer:${opts.name}`;
    this.material = opts.agentMaterial;
    this.mesh = new THREE.InstancedMesh(opts.agentGeometry, opts.agentMaterial, opts.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.userData.layer = opts.name;
    this.root.add(this.mesh);

    const segCount = opts.capacity * (opts.trailMaxSamples - 1 + 1);
    const vertCount = segCount * 2;
    this.trailPos = new Float32Array(vertCount * 3);
    this.trailCol = new Float32Array(vertCount * 4);
    this.trailGeom = new THREE.BufferGeometry();
    this.trailGeom.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3));
    this.trailGeom.setAttribute("color", new THREE.BufferAttribute(this.trailCol, 4));
    this.trailGeom.setDrawRange(0, 0);
    const trailMat = new LineBasicNodeMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.trailMesh = new THREE.LineSegments(this.trailGeom, trailMat);
    this.trailMesh.frustumCulled = false;
    this.root.add(this.trailMesh);
  }

  setWorld(world: Map3dWorld) {
    this.world = world;
  }

  load(_tile: ParsedTile, _g: LayerGeometry, _ctx: LayerContext): TileMeshHandle | null {
    return null;
  }
  setVisible(v: boolean): void {
    this.root.visible = v;
  }
  setOpacity(v: number): void {
    this.material.opacity = v;
    this.material.transparent = v < 1;
  }

  update(_t: number, sunAltitude: number, glow: number): void {
    if (!this.world) return;
    const c = this.world.components;
    const Position = c.Position;
    const Heading = c.Heading;
    const Kind = c.Kind;
    const Flags = c.Flags;

    const nowMs = Date.now();
    const nowS = nowMs / 1000;
    const targetKind = this.opts.kindCode;
    const cap = this.opts.capacity;
    const seen = this.seenEids;
    seen.clear();
    let active = 0;

    for (const eid of query(this.world, [Position, Heading, Kind, Flags])) {
      if ((Flags.bits[eid] & FLAG_IS_FEED) === 0) continue;
      if (Kind.value[eid] !== targetKind) continue;
      if (this.opts.hideOnGround && (Flags.bits[eid] & FLAG_ON_GROUND) !== 0) continue;
      if (active >= cap) break;
      seen.add(eid);

      const sx = Position.x[eid];
      const rawY = Position.y[eid];
      const sy = this.opts.yOverride ? this.opts.yOverride(rawY) : rawY;
      const sz = Position.z[eid];
      const heading = Heading.angle[eid];

      let trail = this.trails.get(eid);
      if (!trail) {
        trail = {
          ring: new Float32Array(this.opts.trailMaxSamples * 4),
          count: 0,
          head: 0,
          lastSampleS: -Infinity,
          lastX: sx,
          lastY: sy,
          lastZ: sz,
        };
        this.trails.set(eid, trail);
      }
      trail.lastX = sx;
      trail.lastY = sy;
      trail.lastZ = sz;
      if (nowS - trail.lastSampleS >= this.opts.trailSampleS) {
        trail.lastSampleS = nowS;
        const off = trail.head * 4;
        trail.ring[off + 0] = sx;
        trail.ring[off + 1] = sy;
        trail.ring[off + 2] = sz;
        trail.ring[off + 3] = nowS;
        trail.head = (trail.head + 1) % this.opts.trailMaxSamples;
        if (trail.count < this.opts.trailMaxSamples) trail.count++;
      }

      this.dummy.position.set(sx, sy, sz);
      this.dummy.rotation.set(0, heading, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(active, this.dummy.matrix);
      active++;
    }
    this.mesh.count = active;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.activeCount = active;

    // Drop trails for entities that disappeared from the world.
    if (this.trails.size > seen.size) {
      for (const eid of this.trails.keys()) {
        if (!seen.has(eid)) this.trails.delete(eid);
      }
    }

    if (nowMs - this.lastTrailRebuildMs >= FeedLayerBase.TRAIL_REBUILD_MS) {
      this.lastTrailRebuildMs = nowMs;
      this.rebuildTrails(nowS);
    }

    const night = Math.max(0, -sunAltitude);
    this.material.emissiveIntensity = 0.1 + night * 1.4 * glow;
  }

  private rebuildTrails(nowS: number) {
    const maxAge = this.opts.trailMaxSamples * this.opts.trailSampleS;
    const c = this.opts.trailColor;
    const N = this.opts.trailMaxSamples;
    const posCap = this.trailPos.length / 3;
    let v = 0;
    for (const trail of this.trails.values()) {
      if (trail.count < 2) {
        // Still draw a single segment to the live position if we have one sample.
        if (trail.count === 1 && v + 2 <= posCap) {
          const startIdx = (trail.head - 1 + N) % N;
          const off = startIdx * 4;
          const fA = Math.max(0, 1 - (nowS - trail.ring[off + 3]) / maxAge);
          this.trailPos[v * 3 + 0] = trail.ring[off + 0];
          this.trailPos[v * 3 + 1] = trail.ring[off + 1];
          this.trailPos[v * 3 + 2] = trail.ring[off + 2];
          this.trailPos[v * 3 + 3] = trail.lastX;
          this.trailPos[v * 3 + 4] = trail.lastY;
          this.trailPos[v * 3 + 5] = trail.lastZ;
          this.trailCol[v * 4 + 0] = c.r;
          this.trailCol[v * 4 + 1] = c.g;
          this.trailCol[v * 4 + 2] = c.b;
          this.trailCol[v * 4 + 3] = fA * fA;
          this.trailCol[v * 4 + 4] = c.r;
          this.trailCol[v * 4 + 5] = c.g;
          this.trailCol[v * 4 + 6] = c.b;
          this.trailCol[v * 4 + 7] = 1;
          v += 2;
        }
        continue;
      }
      const startIdx = (trail.head - trail.count + N) % N;
      for (let i = 0; i < trail.count - 1; i++) {
        if (v + 2 > posCap) break;
        const a = (startIdx + i) % N;
        const b = (startIdx + i + 1) % N;
        const aOff = a * 4;
        const bOff = b * 4;
        const fA = Math.max(0, 1 - (nowS - trail.ring[aOff + 3]) / maxAge);
        const fB = Math.max(0, 1 - (nowS - trail.ring[bOff + 3]) / maxAge);
        this.trailPos[v * 3 + 0] = trail.ring[aOff + 0];
        this.trailPos[v * 3 + 1] = trail.ring[aOff + 1];
        this.trailPos[v * 3 + 2] = trail.ring[aOff + 2];
        this.trailPos[v * 3 + 3] = trail.ring[bOff + 0];
        this.trailPos[v * 3 + 4] = trail.ring[bOff + 1];
        this.trailPos[v * 3 + 5] = trail.ring[bOff + 2];
        this.trailCol[v * 4 + 0] = c.r;
        this.trailCol[v * 4 + 1] = c.g;
        this.trailCol[v * 4 + 2] = c.b;
        this.trailCol[v * 4 + 3] = fA * fA;
        this.trailCol[v * 4 + 4] = c.r;
        this.trailCol[v * 4 + 5] = c.g;
        this.trailCol[v * 4 + 6] = c.b;
        this.trailCol[v * 4 + 7] = fB * fB;
        v += 2;
      }
      // Live segment to the entity's current position.
      if (v + 2 <= posCap) {
        const lastIdx = (trail.head - 1 + N) % N;
        const lOff = lastIdx * 4;
        const fL = Math.max(0, 1 - (nowS - trail.ring[lOff + 3]) / maxAge);
        this.trailPos[v * 3 + 0] = trail.ring[lOff + 0];
        this.trailPos[v * 3 + 1] = trail.ring[lOff + 1];
        this.trailPos[v * 3 + 2] = trail.ring[lOff + 2];
        this.trailPos[v * 3 + 3] = trail.lastX;
        this.trailPos[v * 3 + 4] = trail.lastY;
        this.trailPos[v * 3 + 5] = trail.lastZ;
        this.trailCol[v * 4 + 0] = c.r;
        this.trailCol[v * 4 + 1] = c.g;
        this.trailCol[v * 4 + 2] = c.b;
        this.trailCol[v * 4 + 3] = fL * fL;
        this.trailCol[v * 4 + 4] = c.r;
        this.trailCol[v * 4 + 5] = c.g;
        this.trailCol[v * 4 + 6] = c.b;
        this.trailCol[v * 4 + 7] = 1;
        v += 2;
      }
    }
    this.trailGeom.setDrawRange(0, v);
    (this.trailGeom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  countActive(): number {
    return this.activeCount;
  }
}
