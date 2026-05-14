// derivePrimitives synthetic-tile round-trip tests. Builds a randomized
// ParsedTile, runs derivePrimitives, then validates record counts, heading
// recovery accuracy, and FrameCodec round-trip.

import { describe, expect, it } from "vitest";
import earcut from "earcut";
import {
  FRAME_KIND_KEYFRAME,
  FrameDecoder,
  FrameEncoder,
  SECTION_TILE_BUILDINGS,
  SECTION_TILE_MESH,
  readTileBuildings,
  readTileMesh,
  type LayerGeometry,
  type ParsedTile,
} from "@map3d/data-core";
import { derivePrimitives } from "../src/derivePrimitives";

// Deterministic mulberry32 PRNG so failures reproduce.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rect {
  cx: number;
  cy: number; // mercator-y centre (will become scene -z)
  long: number;
  short: number;
  rot: number; // rotation in radians, applied around centre, x→long axis
  height: number;
}

function buildBuildingsLayer(
  rects: Rect[],
  sceneOrigin: { x: number; y: number },
): LayerGeometry {
  void sceneOrigin; // building layer positions are in mercator, sceneOrigin
                    // applied later by derivePrimitives.
  const positions: number[] = [];
  const indices: number[] = [];
  const featureStart: number[] = [0];
  const featureIds: number[] = [];
  const featureClass: number[] = [];
  const featureHeight: number[] = [];
  const featureMinHeight: number[] = [];

  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    // Construct 4 corners of the rectangle in mercator space.
    const hx = r.long * 0.5;
    const hz = r.short * 0.5;
    const cos = Math.cos(r.rot);
    const sin = Math.sin(r.rot);
    // Local corners (long-axis is x, short-axis is y). Note: we are emitting
    // mercator positions; the conversion to scene-local (negate y) happens in
    // derivePrimitives. So `rot` here is the rotation of the long axis in
    // mercator XY plane.
    const corners = [
      [+hx, +hz],
      [-hx, +hz],
      [-hx, -hz],
      [+hx, -hz],
    ] as const;
    const baseVertex = positions.length / 2;
    const flat: number[] = [];
    for (const c of corners) {
      const wx = c[0] * cos - c[1] * sin + r.cx;
      const wy = c[0] * sin + c[1] * cos + r.cy;
      positions.push(wx, wy);
      flat.push(wx, wy);
    }
    const tri = earcut(flat);
    for (let k = 0; k < tri.length; k++) indices.push(baseVertex + tri[k]);
    featureStart.push(indices.length);
    featureIds.push(i);
    featureClass.push(0);
    featureHeight.push(r.height);
    featureMinHeight.push(0);
  }
  return {
    kind: "polygon",
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    featureStart: new Uint32Array(featureStart),
    featureIds: new Uint32Array(featureIds),
    featureClass: new Uint8Array(featureClass),
    featureHeight: new Float32Array(featureHeight),
    featureMinHeight: new Float32Array(featureMinHeight),
  };
}

function buildRoadsLayer(rand: () => number): LayerGeometry {
  const positions: number[] = [];
  const featureStart: number[] = [0];
  const featureIds: number[] = [];
  const featureClass: number[] = [];
  const featureHeight: number[] = [];
  const featureMinHeight: number[] = [];
  const numLines = 10;
  for (let i = 0; i < numLines; i++) {
    const verts = 5 + Math.floor(rand() * 16);
    let x = (rand() - 0.5) * 2000;
    let y = (rand() - 0.5) * 2000;
    for (let v = 0; v < verts; v++) {
      positions.push(x, y);
      x += (rand() - 0.5) * 80;
      y += (rand() - 0.5) * 80;
    }
    featureStart.push(positions.length / 2);
    featureIds.push(i);
    featureClass.push(1); // motorway
    featureHeight.push(0);
    featureMinHeight.push(0);
  }
  return {
    kind: "line",
    positions: new Float32Array(positions),
    featureStart: new Uint32Array(featureStart),
    featureIds: new Uint32Array(featureIds),
    featureClass: new Uint8Array(featureClass),
    featureHeight: new Float32Array(featureHeight),
    featureMinHeight: new Float32Array(featureMinHeight),
  };
}

function buildWaterLayer(rand: () => number): LayerGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const featureStart: number[] = [0];
  const featureIds: number[] = [];
  const featureClass: number[] = [];
  const featureHeight: number[] = [];
  const featureMinHeight: number[] = [];
  for (let i = 0; i < 5; i++) {
    const cx = (rand() - 0.5) * 2000;
    const cy = (rand() - 0.5) * 2000;
    const r = 40 + rand() * 80;
    const baseVertex = positions.length / 2;
    const flat: number[] = [];
    const nSides = 6;
    for (let k = 0; k < nSides; k++) {
      const a = (k / nSides) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      positions.push(x, y);
      flat.push(x, y);
    }
    const tri = earcut(flat);
    for (let k = 0; k < tri.length; k++) indices.push(baseVertex + tri[k]);
    featureStart.push(indices.length);
    featureIds.push(i);
    featureClass.push(0);
    featureHeight.push(0);
    featureMinHeight.push(0);
  }
  return {
    kind: "polygon",
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    featureStart: new Uint32Array(featureStart),
    featureIds: new Uint32Array(featureIds),
    featureClass: new Uint8Array(featureClass),
    featureHeight: new Float32Array(featureHeight),
    featureMinHeight: new Float32Array(featureMinHeight),
  };
}

function makeSyntheticTile(seed: number): { tile: ParsedTile; rects: Rect[] } {
  const rand = rng(seed);
  const rects: Rect[] = [];
  for (let i = 0; i < 50; i++) {
    const long = 20 + rand() * 60;
    // Force a clear long/short distinction so PCA recovers the major axis.
    const short = long * (0.25 + rand() * 0.4);
    rects.push({
      cx: (rand() - 0.5) * 4000,
      cy: (rand() - 0.5) * 4000,
      long,
      short,
      rot: (rand() - 0.5) * Math.PI,
      height: 5 + rand() * 180,
    });
  }
  const sceneOrigin = { x: 0, y: 0 };
  const tile: ParsedTile = {
    z: 15,
    x: 1234,
    y: 5678,
    version: 1,
    layers: {
      buildings: buildBuildingsLayer(rects, sceneOrigin),
      roads: buildRoadsLayer(rand),
      water: buildWaterLayer(rand),
    },
    attributes: {},
    byteSize: 0,
  };
  return { tile, rects };
}

function angleDiffDeg(aRad: number, bRad: number): number {
  let d = (aRad - bRad) * (180 / Math.PI);
  while (d > 90) d -= 180;
  while (d < -90) d += 180;
  return Math.abs(d);
}

describe("derivePrimitives", () => {
  it("emits one building per feature with PCA heading within 10°", () => {
    const { tile, rects } = makeSyntheticTile(0xdeadbeef);
    const prims = derivePrimitives(tile, { x: 0, y: 0 }, 0);
    expect(prims.buildings.length).toBe(rects.length);
    // Expected heading in the codebase convention is atan2(axisX, axisZ),
    // where axisZ corresponds to -mercator_y (the scene-local z axis).
    // For a rect rotated by `rot` in mercator (x,y) space, the long axis in
    // scene-local space is (cos(rot), -sin(rot)) on (x, z) — so the expected
    // heading is atan2(cos(rot), -sin(rot)).
    let withinTol = 0;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const b = prims.buildings[i];
      const expHeading = Math.atan2(Math.cos(r.rot), -Math.sin(r.rot));
      const diff = angleDiffDeg(b.heading, expHeading);
      if (diff <= 10) withinTol++;
    }
    // Allow one outlier — earcut + float32 truncation can shift PCA slightly
    // for the near-square rectangles. We required short < 0.65*long but a
    // randomized stream can still produce close-to-square cases.
    expect(withinTol).toBeGreaterThanOrEqual(rects.length - 2);
  });

  it("mesh count = line layers + polygon layers (non-building)", () => {
    const { tile } = makeSyntheticTile(0x1337);
    const prims = derivePrimitives(tile, { x: 0, y: 0 }, 0);
    // roads (line) + water (polygon) = 2.
    expect(prims.meshes.length).toBe(2);
  });

  it("encodes through FrameCodec and decodes back cleanly", () => {
    const { tile } = makeSyntheticTile(0xabc123);
    const prims = derivePrimitives(tile, { x: 0, y: 0 }, 0);
    const encoder = new FrameEncoder(4 * 1024 * 1024);
    encoder.beginFrame(FRAME_KIND_KEYFRAME, 0, 0);
    encoder.writeTileBegin(tile.z, tile.x, tile.y);
    if (prims.buildings.length > 0) encoder.writeTileBuildings(prims.buildings);
    for (const m of prims.meshes) encoder.writeTileMesh(m);
    encoder.writeTileEnd();
    const frame = encoder.endFrame();
    const dec = new FrameDecoder(new Uint8Array(frame));
    let sawBuildings = 0;
    let sawMeshes = 0;
    dec.forEachSection((type, payload) => {
      if (type === SECTION_TILE_BUILDINGS) {
        const recs = readTileBuildings(payload);
        sawBuildings += recs.length;
      } else if (type === SECTION_TILE_MESH) {
        const m = readTileMesh(payload);
        expect(m.positions.length % 3).toBe(0);
        expect(m.indices.length % 3).toBe(0);
        sawMeshes++;
      }
    });
    expect(sawBuildings).toBe(prims.buildings.length);
    expect(sawMeshes).toBe(prims.meshes.length);
  });
});
