// Simulation systems operating on the bitECS map3d world. No classes — pure
// functions that read/write component columns. Tiger style: every system
// asserts inputs, every loop is bounded, hot paths allocate nothing.

import { addComponents, addEntity, query, removeComponents } from "bitecs";
import {
  addPolyline,
  FLAG_IS_AGENT,
  KIND_AGENT_PEDESTRIAN,
  KIND_AGENT_TRAIN,
  KIND_AGENT_VEHICLE,
  removePolyline,
  type Map3dWorld,
  type Polyline,
} from "../ecs/world";
import {
  assert,
  assertFinite,
  assertInRange,
  assertU32,
  checkLoopBound,
  dassert,
} from "../util/assert";
import type { SimLineGeometry, SimTile } from "./tileShape";

export type AgentKindCode =
  | typeof KIND_AGENT_VEHICLE
  | typeof KIND_AGENT_TRAIN
  | typeof KIND_AGENT_PEDESTRIAN;

const AGENT_KINDS: AgentKindCode[] = [
  KIND_AGENT_VEHICLE,
  KIND_AGENT_TRAIN,
  KIND_AGENT_PEDESTRIAN,
];

const KIND_SPEED: Record<AgentKindCode, number> = {
  [KIND_AGENT_VEHICLE]: 18,
  [KIND_AGENT_TRAIN]: 30,
  [KIND_AGENT_PEDESTRIAN]: 1.6,
};

const KIND_TARGET_PER_PATH: Record<AgentKindCode, number> = {
  [KIND_AGENT_VEHICLE]: 3.0,
  [KIND_AGENT_TRAIN]: 1.5,
  [KIND_AGENT_PEDESTRIAN]: 3.0,
};

const KIND_LAYER: Record<AgentKindCode, "roads" | "rail" | "paths"> = {
  [KIND_AGENT_VEHICLE]: "roads",
  [KIND_AGENT_TRAIN]: "rail",
  [KIND_AGENT_PEDESTRIAN]: "paths",
};

const MIN_POLYLINE_LEN_M = 10;
const HOP_RADIUS_M = 30;
const HOP_MAX_TRIES = 8;

// ---------- Tile ingestion -----------------------------------------------

export interface IngestOptions {
  sceneOrigin: { x: number; y: number };
  /** Optional cap on how many agents are spawned per kind after this ingest. */
  agentCapPerKind?: Partial<Record<AgentKindCode, number>>;
}

export function ingestTileSystem(
  world: Map3dWorld,
  tile: SimTile,
  opts: IngestOptions,
): void {
  assertU32(tile.z, "tile.z");
  assertU32(tile.x, "tile.x");
  assertU32(tile.y, "tile.y");
  assertFinite(opts.sceneOrigin.x, "sceneOrigin.x");
  assertFinite(opts.sceneOrigin.y, "sceneOrigin.y");

  const tk = `${tile.z}/${tile.x}/${tile.y}`;
  assert(
    !world.context.polylinesByTile.has(tk),
    `ingestTile: duplicate ${tk}`,
  );

  const added: number[] = [];
  for (const kind of AGENT_KINDS) {
    const layer = tile.layers[KIND_LAYER[kind]];
    if (!layer || layer.kind !== "line") continue;
    extractPolylines(layer, kind, tk, opts.sceneOrigin, world, added);
  }
  world.context.polylinesByTile.set(tk, added);

  for (const kind of AGENT_KINDS) {
    const cap = opts.agentCapPerKind?.[kind];
    spawnAgentsForKind(world, kind, cap);
  }
}

export function releaseTileSystem(world: Map3dWorld, tileKey: string): void {
  assert(typeof tileKey === "string" && tileKey.length > 0, "releaseTile key");
  const ctx = world.context;
  const indices = ctx.polylinesByTile.get(tileKey);
  if (!indices) return;
  const evicted = new Set<number>(indices);

  const { Kind, PathRef } = world.components;
  // Reassign any agent currently on an evicted polyline.
  for (const eid of query(world, [PathRef])) {
    const idx = PathRef.polylineIdx[eid];
    if (idx >= 0 && evicted.has(idx)) {
      respawnAgent(world, eid, Kind.value[eid] as AgentKindCode);
    }
  }
  for (const idx of indices) removePolyline(world, idx);
  ctx.polylinesByTile.delete(tileKey);
}

function extractPolylines(
  g: SimLineGeometry,
  kind: AgentKindCode,
  tileKey: string,
  sceneOrigin: { x: number; y: number },
  world: Map3dWorld,
  out: number[],
): void {
  const fc = g.featureIds.length;
  assert(fc < 1_000_000, "extractPolylines: feature count bound");
  for (let fi = 0; fi < fc; fi++) {
    const vs = g.featureStart[fi];
    const ve = g.featureStart[fi + 1];
    assertU32(vs, "vs");
    assertU32(ve, "ve");
    if (ve - vs < 2) continue;
    const n = ve - vs;
    const flat = new Float32Array(n * 2);
    const arc = new Float32Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const px = g.positions[(vs + i) * 2];
      const py = g.positions[(vs + i) * 2 + 1];
      const x = px - sceneOrigin.x;
      const z = -(py - sceneOrigin.y);
      flat[i * 2] = x;
      flat[i * 2 + 1] = z;
      if (i > 0) {
        const dx = flat[i * 2] - flat[i * 2 - 2];
        const dz = flat[i * 2 + 1] - flat[i * 2 - 1];
        total += Math.hypot(dx, dz);
      }
      arc[i] = total;
    }
    if (total < MIN_POLYLINE_LEN_M) continue;
    assertFinite(total, "polyline total");
    const polyline: Polyline = {
      flat,
      arc,
      total,
      classId: g.featureClass[fi],
      tileKey,
      kindCode: kind,
    };
    out.push(addPolyline(world, polyline));
  }
}

// ---------- Spawning -----------------------------------------------------

function spawnAgentsForKind(
  world: Map3dWorld,
  kind: AgentKindCode,
  override?: number,
): void {
  const { polylines } = world.context;
  let pathCount = 0;
  for (let i = 0; i < polylines.length; i++) {
    const p = polylines[i];
    if (p && p.kindCode === kind) pathCount++;
  }
  if (pathCount === 0) return;
  const target = override ?? Math.floor(pathCount * KIND_TARGET_PER_PATH[kind]);
  let active = 0;
  const { Kind, PathRef } = world.components;
  for (const eid of query(world, [PathRef])) {
    if (Kind.value[eid] === kind && PathRef.polylineIdx[eid] >= 0) active++;
  }
  const need = target - active;
  for (let n = 0; n < need; n++) {
    const eid = addEntity(world);
    addComponents(
      world,
      eid,
      world.components.Position,
      world.components.Heading,
      world.components.Speed,
      world.components.Kind,
      world.components.PathRef,
      world.components.Flags,
    );
    Kind.value[eid] = kind;
    world.components.Flags.bits[eid] = FLAG_IS_AGENT;
    world.components.Speed.value[eid] = KIND_SPEED[kind];
    respawnAgent(world, eid, kind);
  }
}

function respawnAgent(
  world: Map3dWorld,
  eid: number,
  kind: AgentKindCode,
): void {
  const ctx = world.context;
  const { PathRef, Position, Heading } = world.components;
  // Pick a random polyline of this kind.
  const candidates: number[] = [];
  for (let i = 0; i < ctx.polylines.length; i++) {
    const p = ctx.polylines[i];
    if (p && p.kindCode === kind) candidates.push(i);
  }
  if (candidates.length === 0) {
    PathRef.polylineIdx[eid] = -1;
    return;
  }
  const idx = candidates[ctx.rng.nextInt(candidates.length)];
  const p = ctx.polylines[idx]!;
  PathRef.polylineIdx[eid] = idx;
  PathRef.cursor[eid] = ctx.rng.next() * p.total;
  PathRef.direction[eid] = ctx.rng.sign();
  sampleAlongPath(p, PathRef.cursor[eid], eid, Position, Heading);
}

// ---------- Per-tick update ---------------------------------------------

export function simUpdateSystem(world: Map3dWorld, dt: number): void {
  assertFinite(dt, "dt");
  assertInRange(dt, 0, 5, "dt");
  const { Position, Heading, Speed, Kind, PathRef } = world.components;
  const ctx = world.context;

  let iter = 0;
  const guard = ctx.config.entityCap * 2;
  for (const eid of query(world, [PathRef])) {
    checkLoopBound(iter++, guard, "simUpdate");
    const idx = PathRef.polylineIdx[eid];
    if (idx < 0) continue;
    let p = ctx.polylines[idx];
    if (!p) {
      // Polyline gone — respawn.
      respawnAgent(world, eid, Kind.value[eid] as AgentKindCode);
      continue;
    }
    const v = Speed.value[eid] * PathRef.direction[eid];
    PathRef.cursor[eid] += v * dt;
    if (PathRef.cursor[eid] >= p.total || PathRef.cursor[eid] <= 0) {
      tryHop(world, eid, p);
      const newIdx = PathRef.polylineIdx[eid];
      if (newIdx < 0) continue;
      p = ctx.polylines[newIdx];
      if (!p) continue;
    }
    sampleAlongPath(p, PathRef.cursor[eid], eid, Position, Heading);
    dassert(Number.isFinite(Position.x[eid]), "Position.x finite");
    dassert(Number.isFinite(Position.z[eid]), "Position.z finite");
  }
}

function tryHop(world: Map3dWorld, eid: number, current: Polyline): void {
  const ctx = world.context;
  const { PathRef } = world.components;
  const endIdx = PathRef.direction[eid] > 0 ? current.flat.length / 2 - 1 : 0;
  const ex = current.flat[endIdx * 2];
  const ez = current.flat[endIdx * 2 + 1];
  const kind = current.kindCode;
  const polys = ctx.polylines;
  for (let k = 0; k < HOP_MAX_TRIES; k++) {
    // Pick a random polyline of the same kind.
    const i = ctx.rng.nextInt(polys.length);
    const cand = polys[i];
    if (!cand || cand.kindCode !== kind || cand === current) continue;
    const lastV = cand.flat.length / 2 - 1;
    const dxA = cand.flat[0] - ex;
    const dzA = cand.flat[1] - ez;
    const dxB = cand.flat[lastV * 2] - ex;
    const dzB = cand.flat[lastV * 2 + 1] - ez;
    if (dxA * dxA + dzA * dzA < HOP_RADIUS_M * HOP_RADIUS_M) {
      PathRef.polylineIdx[eid] = i;
      PathRef.cursor[eid] = 0;
      PathRef.direction[eid] = 1;
      return;
    }
    if (dxB * dxB + dzB * dzB < HOP_RADIUS_M * HOP_RADIUS_M) {
      PathRef.polylineIdx[eid] = i;
      PathRef.cursor[eid] = cand.total;
      PathRef.direction[eid] = -1;
      return;
    }
  }
  respawnAgent(world, eid, kind as AgentKindCode);
}

function sampleAlongPath(
  p: Polyline,
  cursor: number,
  eid: number,
  Position: { x: Float32Array; y: Float32Array; z: Float32Array },
  Heading: { angle: Float32Array },
): void {
  let lo = 0;
  let hi = p.arc.length - 1;
  let iter = 0;
  while (lo < hi) {
    checkLoopBound(iter++, 64, "sampleAlongPath bsearch");
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
  Position.x[eid] = x0 + (x1 - x0) * t;
  Position.z[eid] = z0 + (z1 - z0) * t;
  Position.y[eid] = 0;
  Heading.angle[eid] = Math.atan2(x1 - x0, z1 - z0);
}

// ---------- Cleanup -----------------------------------------------------

/** Removes the FLAG_REMOVED-marked entities from the world. Call after a
 *  frame's deltas are encoded so the codec can still see the removals. */
export function commitRemovalsSystem(world: Map3dWorld): void {
  const { Flags } = world.components;
  for (const eid of query(world, [Flags])) {
    if ((Flags.bits[eid] & 0x08) !== 0) {
      // FLAG_REMOVED. Avoid pulling the constant to dodge the import cycle.
      removeAllComponents(world, eid);
    }
  }
}

function removeAllComponents(world: Map3dWorld, eid: number): void {
  const c = world.components;
  removeComponents(
    world,
    eid,
    c.Position,
    c.Heading,
    c.Speed,
    c.Kind,
    c.PathRef,
    c.Geo,
    c.Vertical,
    c.ObservedAt,
    c.Flags,
  );
}
