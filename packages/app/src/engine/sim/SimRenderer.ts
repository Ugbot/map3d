// Renders sim agents (vehicles, trains, pedestrians) directly out of the
// data-core bitECS world. One InstancedMesh per kind, written each frame
// from the world's Position/Heading/Kind/PathRef columns.
//
// Tiger style: zero per-frame allocations beyond the single Object3D dummy
// owned by this class; counts are bounded by the world's entityCap.

import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  KIND_AGENT_PEDESTRIAN,
  KIND_AGENT_TRAIN,
  KIND_AGENT_VEHICLE,
  query,
  assert,
  type Map3dWorld,
} from "@map3d/data-core";

type KindCode = 0 | 1 | 2;

const KIND_ORDER: KindCode[] = [
  KIND_AGENT_VEHICLE,
  KIND_AGENT_TRAIN,
  KIND_AGENT_PEDESTRIAN,
];

const KIND_COLOR: Record<KindCode, number> = {
  [KIND_AGENT_VEHICLE]: 0xffd166,
  [KIND_AGENT_TRAIN]: 0xc18bff,
  [KIND_AGENT_PEDESTRIAN]: 0x9be7ff,
};

const KIND_SIZE: Record<KindCode, [number, number, number]> = {
  [KIND_AGENT_VEHICLE]: [3, 1.6, 5],
  [KIND_AGENT_TRAIN]: [4, 3.5, 30],
  [KIND_AGENT_PEDESTRIAN]: [0.6, 1.8, 0.6],
};

const KIND_CAPACITY: Record<KindCode, number> = {
  [KIND_AGENT_VEHICLE]: 4000,
  [KIND_AGENT_TRAIN]: 120,
  [KIND_AGENT_PEDESTRIAN]: 1200,
};

const KIND_DAY_EMISSIVE: Record<KindCode, number> = {
  [KIND_AGENT_VEHICLE]: 0.15,
  [KIND_AGENT_TRAIN]: 0.4,
  [KIND_AGENT_PEDESTRIAN]: 0.1,
};

interface KindSlot {
  mesh: THREE.InstancedMesh;
  material: MeshStandardNodeMaterial;
  halfHeight: number;
}

export class SimRenderer {
  private readonly world: Map3dWorld;
  private readonly slots: Record<KindCode, KindSlot>;
  private readonly dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, world: Map3dWorld) {
    assert(!!world && !!world.components, "SimRenderer: world required");
    this.world = world;
    const slots = {} as Record<KindCode, KindSlot>;
    for (const kind of KIND_ORDER) {
      const [sx, sy, sz] = KIND_SIZE[kind];
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mat = new MeshStandardNodeMaterial({
        color: KIND_COLOR[kind],
        emissive: KIND_COLOR[kind],
        emissiveIntensity: KIND_DAY_EMISSIVE[kind],
        roughness: 0.4,
        metalness: 0.3,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, KIND_CAPACITY[kind]);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `sim:${kind}`;
      scene.add(mesh);
      slots[kind] = { mesh, material: mat, halfHeight: sy / 2 };
    }
    this.slots = slots;
  }

  /** Update InstancedMesh transforms from the world's component columns. */
  update(): void {
    const c = this.world.components;
    const Position = c.Position;
    const Heading = c.Heading;
    const Kind = c.Kind;
    const PathRef = c.PathRef;
    const counts: Record<number, number> = {
      [KIND_AGENT_VEHICLE]: 0,
      [KIND_AGENT_TRAIN]: 0,
      [KIND_AGENT_PEDESTRIAN]: 0,
    };
    for (const eid of query(this.world, [Position, Heading, Kind, PathRef])) {
      if (PathRef.polylineIdx[eid] < 0) continue;
      const kind = Kind.value[eid] as KindCode;
      const slot = this.slots[kind];
      if (!slot) continue;
      const idx = counts[kind];
      if (idx >= slot.mesh.instanceMatrix.count) continue;
      this.dummy.position.set(Position.x[eid], slot.halfHeight, Position.z[eid]);
      this.dummy.rotation.set(0, Heading.angle[eid], 0);
      this.dummy.updateMatrix();
      slot.mesh.setMatrixAt(idx, this.dummy.matrix);
      counts[kind] = idx + 1;
    }
    for (const kind of KIND_ORDER) {
      const slot = this.slots[kind];
      slot.mesh.count = counts[kind];
      slot.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Night glow ramp (matches old Simulation.setNight). */
  setNight(t: number): void {
    for (const kind of KIND_ORDER) {
      this.slots[kind].material.emissiveIntensity =
        KIND_DAY_EMISSIVE[kind] + t * 1.6;
    }
  }
}
