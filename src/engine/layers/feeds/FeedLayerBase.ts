// Shared base for live-feed layers (aircraft, vessels).
//
// Owns:
//   - InstancedMesh of the agent shape, capacity slots reused as entities come
//     and go.
//   - A shared LineSegments mesh for trails: one big BufferGeometry per kind
//     with pre-allocated position + RGBA colour attributes, draw range updated
//     each frame.
//
// Per-frame `update` does dead reckoning on (heading, speed, vertical_rate)
// since the last source observation, then samples the position into the
// per-entity ring buffer (gated to one sample per `trailSampleS`).

import * as THREE from "three";
import type { Layer, LayerContext, TileMeshHandle } from "../../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../../cache/types";
import type { FeedEntity } from "../../../feeds/types";
import { lonLatToMeters } from "../../../projection/mercator";

const EARTH_R = 6378137;

export interface FeedLayerOpts {
  name: LayerName;
  capacity: number;
  agentGeometry: THREE.BufferGeometry;
  agentMaterial: THREE.MeshStandardMaterial;
  /** Trail tuning. */
  trailMaxSamples: number;
  trailSampleS: number;
  trailColor: THREE.Color;
  /** How long without a fresh update before we age out the entity. */
  inactiveAfterS: number;
  /** Hook to map FeedEntity → display Y in metres (e.g. altitude for planes,
   *  fixed water height for vessels). */
  yForEntity: (e: FeedEntity) => number;
  /** Should this entity render at all (e.g. hide on-ground aircraft). */
  shouldRender: (e: FeedEntity) => boolean;
}

interface State {
  id: string;
  lon: number;
  lat: number;
  altM: number;
  headingDeg: number;
  speedMs: number;
  verticalMs: number;
  obsTs: number;
  ts: number;
  /** Last frame's dead-reckoned scene-local coords. */
  sx: number;
  sy: number;
  sz: number;
  slot: number;
  /** Ring buffer: positions × maxTrail, each (sx, sy, sz, ts). */
  trail: Float32Array;
  trailCount: number;
  trailHead: number;
  lastSampleS: number;
}

export class FeedLayerBase implements Layer {
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly name: LayerName;

  private opts: FeedLayerOpts;
  private mesh: THREE.InstancedMesh;
  private trailMesh: THREE.LineSegments;
  private trailPos: Float32Array;
  private trailCol: Float32Array;
  private trailGeom: THREE.BufferGeometry;
  private states = new Map<string, State>();
  private freeSlots: number[];
  private sceneOrigin: { x: number; y: number } = { x: 0, y: 0 };
  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();
  // Throttle trail mesh rebuild to ~5 Hz; rebuilding 60×/s was a chunk of
  // main-thread CPU for no visible benefit.
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

    // Trail geometry: capacity × (maxTrail - 1) segments × 2 verts × 3 floats.
    const segCount = opts.capacity * (opts.trailMaxSamples - 1);
    const vertCount = segCount * 2;
    this.trailPos = new Float32Array(vertCount * 3);
    this.trailCol = new Float32Array(vertCount * 4);
    this.trailGeom = new THREE.BufferGeometry();
    this.trailGeom.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3));
    this.trailGeom.setAttribute("color", new THREE.BufferAttribute(this.trailCol, 4));
    this.trailGeom.setDrawRange(0, 0);
    const trailMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.trailMesh = new THREE.LineSegments(this.trailGeom, trailMat);
    this.trailMesh.frustumCulled = false;
    this.root.add(this.trailMesh);

    this.freeSlots = new Array(opts.capacity);
    for (let i = 0; i < opts.capacity; i++) this.freeSlots[i] = opts.capacity - 1 - i;
  }

  setSceneOrigin(o: { x: number; y: number }) {
    this.sceneOrigin = o;
  }

  /** Push a fresh observation. */
  pushUpdate(e: FeedEntity) {
    if (!this.opts.shouldRender(e)) {
      this.remove(e.id);
      return;
    }
    let s = this.states.get(e.id);
    if (!s) {
      const slot = this.freeSlots.pop();
      if (slot === undefined) return; // capacity hit
      s = {
        id: e.id,
        lon: e.lon,
        lat: e.lat,
        altM: e.altM ?? 0,
        headingDeg: e.headingDeg,
        speedMs: e.speedMs,
        verticalMs: e.verticalMs ?? 0,
        obsTs: e.ts,
        ts: e.ts,
        sx: 0,
        sy: 0,
        sz: 0,
        slot,
        trail: new Float32Array(this.opts.trailMaxSamples * 4),
        trailCount: 0,
        trailHead: 0,
        lastSampleS: -Infinity,
      };
      this.states.set(e.id, s);
    } else {
      s.lon = e.lon;
      s.lat = e.lat;
      s.altM = e.altM ?? 0;
      s.headingDeg = e.headingDeg;
      s.speedMs = e.speedMs;
      s.verticalMs = e.verticalMs ?? 0;
      s.obsTs = e.ts;
      s.ts = e.ts;
    }
  }

  /** Remove an entity. */
  remove(id: string) {
    const s = this.states.get(id);
    if (!s) return;
    this.freeSlots.push(s.slot);
    this.states.delete(id);
  }

  // ── Layer interface ──
  load(_tile: ParsedTile, _g: LayerGeometry, _ctx: LayerContext): TileMeshHandle | null {
    return null; // feed-driven, not tile-driven
  }
  setVisible(v: boolean): void {
    this.root.visible = v;
  }
  setOpacity(v: number): void {
    this.material.opacity = v;
    this.material.transparent = v < 1;
  }

  update(_t: number, sunAltitude: number, glow: number): void {
    const wallNow = Date.now();
    const nowS = wallNow / 1000;
    const aged: string[] = [];
    let active = 0;

    for (const s of this.states.values()) {
      const age = (wallNow - s.obsTs) / 1000;
      if (age > this.opts.inactiveAfterS) {
        aged.push(s.id);
        continue;
      }
      // Dead reckon since last observation.
      const headingRad = (s.headingDeg * Math.PI) / 180;
      const dLat = (s.speedMs * age * Math.cos(headingRad)) / EARTH_R;
      const dLon =
        (s.speedMs * age * Math.sin(headingRad)) /
        (EARTH_R * Math.max(0.05, Math.cos((s.lat * Math.PI) / 180)));
      const lat = s.lat + (dLat * 180) / Math.PI;
      const lon = s.lon + (dLon * 180) / Math.PI;
      const altM = Math.max(0, s.altM + s.verticalMs * age);
      const m = lonLatToMeters(lon, lat);
      s.sx = m.x - this.sceneOrigin.x;
      s.sz = -(m.y - this.sceneOrigin.y);
      s.sy = this.opts.yForEntity({
        id: s.id,
        kind: this.opts.name === "aircraft" ? "aircraft" : "vessel",
        lat,
        lon,
        altM,
        headingDeg: s.headingDeg,
        speedMs: s.speedMs,
        verticalMs: s.verticalMs,
        ts: s.ts,
      });

      // Sample trail at the configured cadence.
      if (nowS - s.lastSampleS >= this.opts.trailSampleS) {
        s.lastSampleS = nowS;
        const off = s.trailHead * 4;
        s.trail[off + 0] = s.sx;
        s.trail[off + 1] = s.sy;
        s.trail[off + 2] = s.sz;
        s.trail[off + 3] = nowS;
        s.trailHead = (s.trailHead + 1) % this.opts.trailMaxSamples;
        s.trailCount = Math.min(s.trailCount + 1, this.opts.trailMaxSamples);
      }

      this.dummy.position.set(s.sx, s.sy, s.sz);
      this.dummy.rotation.set(0, headingRad, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(active, this.dummy.matrix);
      active++;
    }
    this.mesh.count = active;
    this.mesh.instanceMatrix.needsUpdate = true;

    for (const id of aged) this.remove(id);

    if (wallNow - this.lastTrailRebuildMs >= FeedLayerBase.TRAIL_REBUILD_MS) {
      this.lastTrailRebuildMs = wallNow;
      this.rebuildTrails(nowS);
    }

    // Night-glow: fades in when sun below horizon.
    const night = Math.max(0, -sunAltitude);
    this.material.emissiveIntensity = 0.1 + night * 1.4 * glow;
  }

  private rebuildTrails(nowS: number) {
    const maxAge = this.opts.trailMaxSamples * this.opts.trailSampleS;
    const c = this.opts.trailColor;
    let v = 0; // vertex cursor
    for (const s of this.states.values()) {
      if (s.trailCount < 2) continue;
      // Walk samples oldest-to-newest, emitting segments between consecutive
      // valid samples. With a ring buffer, oldest is at (head - count) mod N.
      const N = this.opts.trailMaxSamples;
      const startIdx = (s.trailHead - s.trailCount + N) % N;
      for (let i = 0; i < s.trailCount - 1; i++) {
        const a = (startIdx + i) % N;
        const b = (startIdx + i + 1) % N;
        const aOff = a * 4;
        const bOff = b * 4;
        const tA = s.trail[aOff + 3];
        const tB = s.trail[bOff + 3];
        const ageA = nowS - tA;
        const ageB = nowS - tB;
        const fA = Math.max(0, 1 - ageA / maxAge);
        const fB = Math.max(0, 1 - ageB / maxAge);
        // Position
        this.trailPos[v * 3 + 0] = s.trail[aOff + 0];
        this.trailPos[v * 3 + 1] = s.trail[aOff + 1];
        this.trailPos[v * 3 + 2] = s.trail[aOff + 2];
        this.trailPos[v * 3 + 3] = s.trail[bOff + 0];
        this.trailPos[v * 3 + 4] = s.trail[bOff + 1];
        this.trailPos[v * 3 + 5] = s.trail[bOff + 2];
        // Colour (RGBA), alpha falls off with age² for a punchier "newest is brightest" curve
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
      // Also emit a segment from the newest sample to the live position so
      // the trail visually meets the moving entity.
      const lastIdx = (s.trailHead - 1 + N) % N;
      const lOff = lastIdx * 4;
      const tL = s.trail[lOff + 3];
      const ageL = nowS - tL;
      const fL = Math.max(0, 1 - ageL / maxAge);
      if (v + 2 <= this.trailPos.length / 3) {
        this.trailPos[v * 3 + 0] = s.trail[lOff + 0];
        this.trailPos[v * 3 + 1] = s.trail[lOff + 1];
        this.trailPos[v * 3 + 2] = s.trail[lOff + 2];
        this.trailPos[v * 3 + 3] = s.sx;
        this.trailPos[v * 3 + 4] = s.sy;
        this.trailPos[v * 3 + 5] = s.sz;
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
    void this.tmpColor;
  }

  countActive(): number {
    return this.states.size;
  }
}
