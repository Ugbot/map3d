// One bitECS world hosts every map3d entity: simulated road/rail/path agents,
// live aircraft, live vessels, and any future kind. All components are SoA
// typed arrays sized to a static capacity that bounds the world's memory.
//
// Tiger style:
//   * Capacity is fixed at construction; addEntity will assert against it.
//   * Hot systems iterate query results — bitECS guarantees SoA, no GC churn.
//   * Auxiliary maps (polylines, feed-id ↔ eid) are bounded; oldest evicted.

import { createWorld, type World } from "bitecs";
import { assert, assertU32 } from "../util/assert";
import { makeRng, type Rng } from "../util/rng";

export interface Polyline {
  /** (x,z) scene-local metres, length = N*2. */
  flat: Float32Array;
  /** Cumulative arc length, length = N. */
  arc: Float32Array;
  total: number;
  classId: number;
  tileKey: string;
  kindCode: number; // matches Kind.value
}

export interface WorldConfig {
  /** Max entities (agents + feeds combined). */
  entityCap: number;
  /** Max polylines retained across all tiles. */
  polylineCap: number;
  /** Feed entity stale-eviction window (ms). */
  feedStaleMs: number;
  /** PRNG seed. */
  seed: number;
}

export interface WorldComponents {
  // Kinematic state shared by every drawable entity.
  Position: { x: Float32Array; y: Float32Array; z: Float32Array };
  Heading: { angle: Float32Array };
  Speed: { value: Float32Array };
  // Kind value:
  //   0..2 = simulated agents (vehicle/train/pedestrian)
  //   16   = aircraft
  //   17   = vessel
  Kind: { value: Uint8Array };
  // Sim-only: which polyline + arc-length cursor.
  PathRef: {
    polylineIdx: Int32Array; // -1 = unspawned
    cursor: Float32Array;
    direction: Int8Array; // +1 / -1
  };
  // Feed-only: original geographic obs + lifecycle metadata.
  Geo: { lon: Float32Array; lat: Float32Array; altM: Float32Array };
  Vertical: { mps: Float32Array };
  ObservedAt: { ms: Float64Array };
  // Bit flags (one Uint8Array column for compactness).
  Flags: { bits: Uint8Array };
}

export const FLAG_IS_AGENT = 1 << 0;
export const FLAG_IS_FEED = 1 << 1;
export const FLAG_ON_GROUND = 1 << 2;
export const FLAG_REMOVED = 1 << 3;

export const KIND_AGENT_VEHICLE = 0;
export const KIND_AGENT_TRAIN = 1;
export const KIND_AGENT_PEDESTRIAN = 2;
export const KIND_FEED_AIRCRAFT = 16;
export const KIND_FEED_VESSEL = 17;

export interface Map3dWorldContext {
  config: WorldConfig;
  rng: Rng;
  polylines: (Polyline | null)[]; // index-stable; nulls left after release
  freePolylineSlots: number[]; // recycled indices
  polylinesByTile: Map<string, number[]>;
  /** feed id → eid for upsert. Capped by config.entityCap. */
  feedIdToEid: Map<string, number>;
  /** Wall-clock ms used for stale checks; the host updates this each tick. */
  nowMs: number;
}

export type Map3dWorld = World & {
  components: WorldComponents;
  context: Map3dWorldContext;
};

export function createMap3dWorld(config: WorldConfig): Map3dWorld {
  assertU32(config.entityCap, "entityCap");
  assert(config.entityCap >= 16 && config.entityCap <= 1_000_000, "entityCap range");
  assertU32(config.polylineCap, "polylineCap");
  assert(config.polylineCap >= 1 && config.polylineCap <= 1_000_000, "polylineCap range");
  assert(config.feedStaleMs >= 1_000, "feedStaleMs >= 1s");
  assertU32(config.seed >>> 0, "seed");

  const N = config.entityCap;
  const world = createWorld({
    components: {
      Position: {
        x: new Float32Array(N),
        y: new Float32Array(N),
        z: new Float32Array(N),
      },
      Heading: { angle: new Float32Array(N) },
      Speed: { value: new Float32Array(N) },
      Kind: { value: new Uint8Array(N) },
      PathRef: {
        polylineIdx: new Int32Array(N).fill(-1),
        cursor: new Float32Array(N),
        direction: new Int8Array(N).fill(1),
      },
      Geo: {
        lon: new Float32Array(N),
        lat: new Float32Array(N),
        altM: new Float32Array(N),
      },
      Vertical: { mps: new Float32Array(N) },
      ObservedAt: { ms: new Float64Array(N) },
      Flags: { bits: new Uint8Array(N) },
    } satisfies WorldComponents,
  }) as unknown as Map3dWorld;

  world.context = {
    config,
    rng: makeRng(config.seed >>> 0),
    polylines: new Array<Polyline | null>(config.polylineCap).fill(null),
    freePolylineSlots: [],
    polylinesByTile: new Map(),
    feedIdToEid: new Map(),
    nowMs: 0,
  };
  return world;
}

/** Append a polyline to the world's bounded slab. Returns its stable index. */
export function addPolyline(world: Map3dWorld, p: Polyline): number {
  const ctx = world.context;
  let idx: number;
  if (ctx.freePolylineSlots.length > 0) {
    idx = ctx.freePolylineSlots.pop()!;
    ctx.polylines[idx] = p;
  } else {
    idx = ctx.polylines.indexOf(null);
    if (idx < 0) {
      // Fall back to first null slot; if none, allocate a new index.
      idx = ctx.polylines.length;
      assert(idx < ctx.config.polylineCap, "polyline capacity");
      ctx.polylines.push(p);
    } else {
      ctx.polylines[idx] = p;
    }
  }
  return idx;
}

export function removePolyline(world: Map3dWorld, idx: number): void {
  const ctx = world.context;
  assert(idx >= 0 && idx < ctx.polylines.length, "removePolyline idx");
  ctx.polylines[idx] = null;
  ctx.freePolylineSlots.push(idx);
}
