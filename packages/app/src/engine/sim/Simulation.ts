// Multi-agent simulation: vehicles, trains, pedestrians as instanced
// "boxes of light" along the network polylines that tiles bring in.
//
// Data layout is SoA in flat typed arrays:
//   ax[i], az[i], aheading[i], aspeed[i]              — kinematic state
//   apath[i]   = index into pathsByKind[akind[i]]      — which polyline
//   acursor[i] = pre-scaled progress along path (0..1) — where on it
//   akind[i]   = 0=vehicle 1=train 2=pedestrian
//
// Eviction safety: when a tile evicts we drop its polylines and reassign any
// agent that was on them to a new random path. No NaNs leak into the buffers.

import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";

interface Polyline {
  // (x,z) in scene-local metres, length = N*2
  flat: Float32Array;
  // cumulative arc length per vertex, length = N
  arc: Float32Array;
  total: number; // total length
  classId: number;
  tileKey: string;
}

const KIND_VEHICLE = 0;
const KIND_TRAIN = 1;
const KIND_PEDESTRIAN = 2;

const KIND_TO_LAYER: Record<number, LayerName> = {
  [KIND_VEHICLE]: "roads",
  [KIND_TRAIN]: "rail",
  [KIND_PEDESTRIAN]: "paths",
};

const KIND_SPEED: Record<number, number> = {
  [KIND_VEHICLE]: 18,
  [KIND_TRAIN]: 30,
  [KIND_PEDESTRIAN]: 1.6,
};

const KIND_COLOR: Record<number, number> = {
  [KIND_VEHICLE]: 0xffd166,
  [KIND_TRAIN]: 0xc18bff,
  [KIND_PEDESTRIAN]: 0x9be7ff,
};

const KIND_SIZE: Record<number, [number, number, number]> = {
  [KIND_VEHICLE]: [3, 1.6, 5],
  [KIND_TRAIN]: [4, 3.5, 30],
  [KIND_PEDESTRIAN]: [0.6, 1.8, 0.6],
};

const KIND_CAPACITY: Record<number, number> = {
  [KIND_VEHICLE]: 4000,
  [KIND_TRAIN]: 120,
  [KIND_PEDESTRIAN]: 1200,
};

const KIND_DAY_EMISSIVE: Record<number, number> = {
  [KIND_VEHICLE]: 0.15,
  [KIND_TRAIN]: 0.4,
  [KIND_PEDESTRIAN]: 0.1,
};

const KIND_TARGET_PER_PATH: Record<number, number> = {
  [KIND_VEHICLE]: 3.0,
  [KIND_TRAIN]: 1.5,
  [KIND_PEDESTRIAN]: 3.0,
};

export class Simulation {
  private pathsByKind: Map<number, Polyline[]> = new Map([
    [KIND_VEHICLE, []],
    [KIND_TRAIN, []],
    [KIND_PEDESTRIAN, []],
  ]);
  private pathsByTile: Map<string, Polyline[]> = new Map();

  // SoA per-kind, since each kind has its own InstancedMesh.
  private agents: Record<
    number,
    {
      x: Float32Array;
      z: Float32Array;
      heading: Float32Array;
      /** null = unspawned. Direct reference avoids index-shift bugs on eviction. */
      path: (Polyline | null)[];
      cursor: Float32Array;
      direction: Float32Array;
      mesh: THREE.InstancedMesh;
      material: MeshStandardNodeMaterial;
    }
  > = {} as never;

  private origin: { x: number; y: number };
  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, origin: { x: number; y: number }) {
    this.origin = origin;
    void this.origin;
    for (const kindStr in KIND_CAPACITY) {
      const kind = parseInt(kindStr, 10);
      const cap = KIND_CAPACITY[kind];
      const [sx, sy, sz] = KIND_SIZE[kind];
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mat = new MeshStandardNodeMaterial({
        color: KIND_COLOR[kind],
        emissive: KIND_COLOR[kind],
        emissiveIntensity: KIND_DAY_EMISSIVE[kind],
        roughness: 0.4,
        metalness: 0.3,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `sim:${kind}`;
      scene.add(mesh);
      this.agents[kind] = {
        x: new Float32Array(cap),
        z: new Float32Array(cap),
        heading: new Float32Array(cap),
        // Reference paths by object directly so tile eviction (which splices
        // pathsByKind arrays) can't silently corrupt agent assignments.
        path: new Array<Polyline | null>(cap).fill(null),
        cursor: new Float32Array(cap),
        direction: new Float32Array(cap).fill(1),
        mesh,
        material: mat,
      };
    }
  }

  /** Called by TileManager (via Engine) when a tile loads. */
  ingestTile(tile: ParsedTile, sceneOrigin: { x: number; y: number }) {
    const tk = `${tile.z}/${tile.x}/${tile.y}`;
    const pathsForTile: Polyline[] = [];
    for (const [layer, kind] of [
      ["roads", KIND_VEHICLE],
      ["rail", KIND_TRAIN],
      ["paths", KIND_PEDESTRIAN],
    ] as [LayerName, number][]) {
      const g = tile.layers[layer];
      if (!g || g.kind !== "line") continue;
      this.extractPolylines(g, kind, tk, sceneOrigin, pathsForTile);
    }
    this.pathsByTile.set(tk, pathsForTile);
    for (const p of pathsForTile) {
      this.pathsByKind.get(this.kindFromPath(p))!.push(p);
    }
    // Top up agent populations.
    for (const kindStr in KIND_CAPACITY) {
      const kind = parseInt(kindStr, 10);
      this.spawnUpTo(kind, this.targetCount(kind));
    }
  }

  private kindFromPath(p: Polyline): number {
    // We tag via a hidden field; piggy-back on classId range:
    // (we set kind on the Polyline below in extractPolylines via `total` is
    // unrelated, so store kind on a side-band map keyed by reference)
    return (p as Polyline & { _kind: number })._kind;
  }

  private extractPolylines(
    g: LayerGeometry,
    kind: number,
    tileKey: string,
    sceneOrigin: { x: number; y: number },
    out: Polyline[],
  ) {
    const fc = g.featureIds.length;
    for (let fi = 0; fi < fc; fi++) {
      const vs = g.featureStart[fi];
      const ve = g.featureStart[fi + 1];
      if (ve - vs < 2) continue;
      const n = ve - vs;
      const flat = new Float32Array(n * 2);
      const arc = new Float32Array(n);
      let total = 0;
      for (let i = 0; i < n; i++) {
        const x = g.positions[(vs + i) * 2] - sceneOrigin.x;
        const z = -(g.positions[(vs + i) * 2 + 1] - sceneOrigin.y);
        flat[i * 2] = x;
        flat[i * 2 + 1] = z;
        if (i > 0) {
          total += Math.hypot(
            flat[i * 2] - flat[i * 2 - 2],
            flat[i * 2 + 1] - flat[i * 2 - 1],
          );
        }
        arc[i] = total;
      }
      if (total < 10) continue; // skip stubby fragments
      const pl: Polyline = {
        flat,
        arc,
        total,
        classId: g.featureClass[fi],
        tileKey,
      };
      (pl as Polyline & { _kind: number })._kind = kind;
      out.push(pl);
    }
  }

  /** Called when a tile evicts. */
  releaseTile(tileKey: string) {
    const paths = this.pathsByTile.get(tileKey);
    if (!paths) return;
    const evictedSet = new Set<Polyline>(paths);
    // Respawn agents on evicted paths BEFORE we mutate the path arrays — that
    // way the agent has a fresh valid reference and never observes the array
    // mid-mutation.
    for (const kindStr in this.agents) {
      const kind = parseInt(kindStr, 10);
      const a = this.agents[kind];
      for (let i = 0; i < a.path.length; i++) {
        const p = a.path[i];
        if (p && evictedSet.has(p)) this.respawnAgent(kind, i);
      }
    }
    // Now drop the evicted paths from the per-kind arrays.
    for (const p of paths) {
      const kind = this.kindFromPath(p);
      const arr = this.pathsByKind.get(kind)!;
      const idx = arr.indexOf(p);
      if (idx >= 0) arr.splice(idx, 1);
    }
    this.pathsByTile.delete(tileKey);
  }

  private targetCount(kind: number): number {
    const paths = this.pathsByKind.get(kind)!.length;
    const ratio = KIND_TARGET_PER_PATH[kind] ?? 1;
    return Math.min(KIND_CAPACITY[kind], Math.floor(paths * ratio));
  }

  private spawnUpTo(kind: number, n: number) {
    const a = this.agents[kind];
    let active = 0;
    for (let i = 0; i < a.path.length; i++) if (a.path[i]) active++;
    for (let i = 0; i < a.path.length && active < n; i++) {
      if (!a.path[i]) {
        this.respawnAgent(kind, i);
        if (a.path[i]) active++;
      }
    }
    a.mesh.count = active;
  }

  private respawnAgent(kind: number, i: number) {
    const a = this.agents[kind];
    const list = this.pathsByKind.get(kind)!;
    if (list.length === 0) {
      a.path[i] = null;
      return;
    }
    const p = list[Math.floor(Math.random() * list.length)];
    a.path[i] = p;
    a.cursor[i] = Math.random() * p.total;
    a.direction[i] = Math.random() < 0.5 ? 1 : -1;
    this.sampleAlongPath(p, a.cursor[i], i, a);
  }

  private sampleAlongPath(
    p: Polyline,
    cursor: number,
    i: number,
    a: { x: Float32Array; z: Float32Array; heading: Float32Array },
  ) {
    // Binary search in arc array.
    let lo = 0;
    let hi = p.arc.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (p.arc[m] < cursor) lo = m + 1;
      else hi = m;
    }
    const seg = Math.max(1, lo);
    const prevArc = p.arc[seg - 1];
    const segLen = p.arc[seg] - prevArc;
    const t = segLen > 0 ? (cursor - prevArc) / segLen : 0;
    const x0 = p.flat[(seg - 1) * 2];
    const z0 = p.flat[(seg - 1) * 2 + 1];
    const x1 = p.flat[seg * 2];
    const z1 = p.flat[seg * 2 + 1];
    a.x[i] = x0 + (x1 - x0) * t;
    a.z[i] = z0 + (z1 - z0) * t;
    a.heading[i] = Math.atan2(x1 - x0, z1 - z0);
  }

  update(dt: number) {
    for (const kindStr in this.agents) {
      const kind = parseInt(kindStr, 10);
      const a = this.agents[kind];
      const baseSpeed = KIND_SPEED[kind];
      let active = 0;
      for (let i = 0; i < a.path.length; i++) {
        let p = a.path[i];
        if (!p) continue;
        a.cursor[i] += baseSpeed * a.direction[i] * dt;
        if (a.cursor[i] >= p.total || a.cursor[i] <= 0) {
          this.tryHop(kind, i, p);
          p = a.path[i];
          if (!p) continue;
        }
        this.sampleAlongPath(p, a.cursor[i], i, a);
        this.dummy.position.set(a.x[i], KIND_SIZE[kind][1] / 2, a.z[i]);
        this.dummy.rotation.set(0, a.heading[i], 0);
        this.dummy.updateMatrix();
        a.mesh.setMatrixAt(active, this.dummy.matrix);
        active++;
      }
      a.mesh.count = active;
      a.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private tryHop(kind: number, i: number, current: Polyline) {
    const a = this.agents[kind];
    const list = this.pathsByKind.get(kind)!;
    const endIdx = a.direction[i] > 0 ? current.flat.length / 2 - 1 : 0;
    const ex = current.flat[endIdx * 2];
    const ez = current.flat[endIdx * 2 + 1];
    const RADIUS = 30;
    for (let k = 0; k < 8; k++) {
      const cand = list[Math.floor(Math.random() * list.length)];
      if (cand === current) continue;
      const lastV = cand.flat.length / 2 - 1;
      const dxA = cand.flat[0] - ex;
      const dzA = cand.flat[1] - ez;
      const dxB = cand.flat[lastV * 2] - ex;
      const dzB = cand.flat[lastV * 2 + 1] - ez;
      const dA = dxA * dxA + dzA * dzA;
      const dB = dxB * dxB + dzB * dzB;
      if (dA < RADIUS * RADIUS) {
        a.path[i] = cand;
        a.cursor[i] = 0;
        a.direction[i] = 1;
        return;
      }
      if (dB < RADIUS * RADIUS) {
        a.path[i] = cand;
        a.cursor[i] = cand.total;
        a.direction[i] = -1;
        return;
      }
    }
    this.respawnAgent(kind, i);
  }

  /** Glow ramp for night. Engine drives this. Day baseline stays visible. */
  setNight(t: number) {
    for (const kindStr in this.agents) {
      const kind = parseInt(kindStr, 10);
      const a = this.agents[kind];
      a.material.emissiveIntensity = KIND_DAY_EMISSIVE[kind] + t * 1.6;
    }
  }
}
