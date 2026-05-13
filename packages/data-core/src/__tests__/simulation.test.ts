import { describe, expect, it } from "vitest";
import { query } from "bitecs";
import { createMap3dWorld, FLAG_IS_AGENT, KIND_AGENT_VEHICLE } from "../ecs/world";
import { ingestTileSystem, simUpdateSystem } from "../sim/simSystems";
import type { SimTile } from "../sim/tileShape";
import { makeRng } from "../util/rng";

function makeStraightRoadTile(seed: number): SimTile {
  const rng = makeRng(seed);
  // Generate a single straight road from (0,0) to (500,0) with N vertices.
  const N = 8;
  const positions = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    positions[i * 2] = (i / (N - 1)) * 500 + rng.next() * 0.01;
    positions[i * 2 + 1] = 0;
  }
  const featureStart = new Uint32Array([0, N]);
  const featureIds = new Uint32Array([1]);
  const featureClass = new Uint8Array([1]);
  return {
    z: 14,
    x: 0,
    y: 0,
    layers: {
      roads: {
        kind: "line",
        positions,
        featureStart,
        featureIds,
        featureClass,
      },
    },
  };
}

describe("Simulation systems (bitECS)", () => {
  it("spawns vehicles after a road tile is ingested", () => {
    const world = createMap3dWorld({
      entityCap: 1024,
      polylineCap: 1024,
      feedStaleMs: 60_000,
      seed: 0x1234,
    });
    ingestTileSystem(world, makeStraightRoadTile(1), {
      sceneOrigin: { x: 0, y: 0 },
    });
    const { Kind, Flags, PathRef } = world.components;
    let n = 0;
    for (const eid of query(world, [Kind, Flags, PathRef])) {
      if (
        (Flags.bits[eid] & FLAG_IS_AGENT) !== 0 &&
        Kind.value[eid] === KIND_AGENT_VEHICLE &&
        PathRef.polylineIdx[eid] >= 0
      ) {
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it("advances agent positions deterministically", () => {
    const worldA = createMap3dWorld({
      entityCap: 1024,
      polylineCap: 1024,
      feedStaleMs: 60_000,
      seed: 0x1234,
    });
    const worldB = createMap3dWorld({
      entityCap: 1024,
      polylineCap: 1024,
      feedStaleMs: 60_000,
      seed: 0x1234,
    });
    ingestTileSystem(worldA, makeStraightRoadTile(1), {
      sceneOrigin: { x: 0, y: 0 },
    });
    ingestTileSystem(worldB, makeStraightRoadTile(1), {
      sceneOrigin: { x: 0, y: 0 },
    });
    for (let i = 0; i < 30; i++) {
      simUpdateSystem(worldA, 1 / 30);
      simUpdateSystem(worldB, 1 / 30);
    }
    const cA = worldA.components;
    const cB = worldB.components;
    for (let eid = 0; eid < 64; eid++) {
      // First handful of entity slots — bitECS allocates monotonically.
      expect(cA.Position.x[eid]).toBeCloseTo(cB.Position.x[eid], 4);
      expect(cA.Position.z[eid]).toBeCloseTo(cB.Position.z[eid], 4);
    }
  });

  it("produces finite positions for every active agent", () => {
    const world = createMap3dWorld({
      entityCap: 1024,
      polylineCap: 1024,
      feedStaleMs: 60_000,
      seed: 0x9999,
    });
    ingestTileSystem(world, makeStraightRoadTile(2), {
      sceneOrigin: { x: 0, y: 0 },
    });
    for (let i = 0; i < 60; i++) simUpdateSystem(world, 1 / 30);
    const c = world.components;
    for (const eid of query(world, [c.PathRef, c.Position])) {
      if (c.PathRef.polylineIdx[eid] < 0) continue;
      expect(Number.isFinite(c.Position.x[eid])).toBe(true);
      expect(Number.isFinite(c.Position.z[eid])).toBe(true);
    }
  });
});
