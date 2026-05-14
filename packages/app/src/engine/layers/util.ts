// Shared geometry helpers for layer implementations.

import * as THREE from "three";
import {
  assert,
  assertFinite,
  assertU32,
  checkLoopBound,
} from "@map3d/data-core";
import type { LayerGeometry } from "@map3d/data-core";

export interface Origin {
  x: number;
  y: number;
}

// Tiger Style caps for per-tile feature/vertex counts. If real-world data
// breaks these, loosen and note here.
export const MAX_FEATURES_PER_TILE = 200_000;
export const MAX_VERTICES_PER_TILE = 2_000_000;

export function assertOrigin(o: Origin, ctx: string): void {
  assertFinite(o.x, `${ctx}: origin.x`);
  assertFinite(o.y, `${ctx}: origin.y`);
}

// Validate the structural invariants of a LayerGeometry before we read it
// into Three.js BufferGeometry. Cheap O(featureCount) checks; the per-vertex
// finite check is restricted to a small sample for cost reasons (worker
// already produces finite floats — this catches gross corruption).
export function assertLayerGeometry(g: LayerGeometry, ctx: string): void {
  assert(g.positions.length % 2 === 0, `${ctx}: positions length not even`);
  const vertCount = g.positions.length / 2;
  assertU32(vertCount, `${ctx}: vertCount`);
  assert(
    vertCount <= MAX_VERTICES_PER_TILE,
    `${ctx}: vertex count ${vertCount} exceeds cap ${MAX_VERTICES_PER_TILE}`,
  );
  const featureCount = g.featureIds.length;
  assertU32(featureCount, `${ctx}: featureCount`);
  assert(
    featureCount <= MAX_FEATURES_PER_TILE,
    `${ctx}: feature count ${featureCount} exceeds cap ${MAX_FEATURES_PER_TILE}`,
  );
  assert(
    g.featureStart.length === featureCount + 1,
    `${ctx}: featureStart length ${g.featureStart.length} != featureCount+1 ${featureCount + 1}`,
  );
  assert(
    g.featureClass.length === featureCount,
    `${ctx}: featureClass length mismatch`,
  );
  if (g.kind === "polygon") {
    assert(!!g.indices, `${ctx}: polygon missing indices`);
    assert(
      g.featureHeight.length === featureCount,
      `${ctx}: featureHeight length mismatch`,
    );
    assert(
      g.featureMinHeight.length === featureCount,
      `${ctx}: featureMinHeight length mismatch`,
    );
  }
  // Sentinel: monotonic non-decreasing featureStart.
  let prev = 0;
  for (let i = 0; i < g.featureStart.length; i++) {
    checkLoopBound(i, MAX_FEATURES_PER_TILE + 2, `${ctx}: featureStart walk`);
    const v = g.featureStart[i];
    assertU32(v, `${ctx}: featureStart[${i}]`);
    assert(v >= prev, `${ctx}: featureStart not monotonic at ${i}: ${v} < ${prev}`);
    prev = v;
  }
}

// Convert Mercator-metres positions (x east, y north) into a Three.js BufferGeometry
// suitable for a flat (Y=0) ground-plane polygon. y mercator becomes -z scene
// because Three.js convention is +Z out of screen.
export function flatPolygonGeometry(
  g: LayerGeometry,
  origin: Origin,
): THREE.BufferGeometry | null {
  if (g.kind !== "polygon" || !g.indices) return null;
  assertOrigin(origin, "flatPolygonGeometry");
  assertLayerGeometry(g, "flatPolygonGeometry");
  const vertCount = g.positions.length / 2;
  const verts = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    checkLoopBound(i, MAX_VERTICES_PER_TILE, "flatPolygonGeometry: vert walk");
    verts[i * 3 + 0] = g.positions[i * 2] - origin.x;
    verts[i * 3 + 1] = 0;
    verts[i * 3 + 2] = -(g.positions[i * 2 + 1] - origin.y); // flip north→-Z
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geom.setIndex(new THREE.BufferAttribute(g.indices, 1));
  geom.computeVertexNormals();
  return geom;
}

// Build extruded prisms from per-feature 2D polygons. The 2D triangulation in
// `g.indices` already gives us the top + bottom cap (same triangles). We add
// side quads by walking each feature's *boundary edges* — those are the edges
// that appear in exactly one triangle.
export function extrudePolygons(
  g: LayerGeometry,
  origin: Origin,
  fallbackHeight: (cls: number, featureIndex: number) => number,
): { geometry: THREE.BufferGeometry; featureRanges: Uint32Array; featureIds: Uint32Array } | null {
  if (g.kind !== "polygon" || !g.indices) return null;
  assertOrigin(origin, "extrudePolygons");
  assertLayerGeometry(g, "extrudePolygons");
  const indexCount = g.indices.length;
  assert(indexCount % 3 === 0, `extrudePolygons: indices not multiple of 3 (${indexCount})`);
  const positions: number[] = [];
  const indices: number[] = [];
  const featureRanges: number[] = [0]; // index ranges per feature (in indices array)
  const featureIds: number[] = [];

  const featureCount = g.featureIds.length;
  for (let fi = 0; fi < featureCount; fi++) {
    checkLoopBound(fi, MAX_FEATURES_PER_TILE, "extrudePolygons: feature walk");
    const triStart = g.featureStart[fi];
    const triEnd = g.featureStart[fi + 1];
    assert(
      triEnd <= indexCount && triStart <= triEnd,
      `extrudePolygons: bad featureStart range [${triStart},${triEnd}] for indices ${indexCount}`,
    );
    assert(
      (triEnd - triStart) % 3 === 0,
      `extrudePolygons: feature ${fi} triangle range not multiple of 3`,
    );
    if (triEnd === triStart) {
      featureRanges.push(indices.length);
      featureIds.push(g.featureIds[fi]);
      continue;
    }
    const minH = g.featureMinHeight[fi];
    let topH = g.featureHeight[fi];
    assertFinite(minH, `extrudePolygons: featureMinHeight[${fi}]`);
    assertFinite(topH, `extrudePolygons: featureHeight[${fi}]`);
    if (topH <= 0) {
      topH = fallbackHeight(g.featureClass[fi], fi);
      assertFinite(topH, `extrudePolygons: fallbackHeight(${fi})`);
    }
    if (topH <= minH) topH = minH + 3;

    // Find local vertex set used by this feature's triangles.
    const localMap = new Map<number, number>(); // global vertIdx → local index
    const localVerts: number[] = []; // global vertex indices in local order
    for (let i = triStart; i < triEnd; i++) {
      checkLoopBound(i - triStart, MAX_VERTICES_PER_TILE, "extrudePolygons: feature index walk");
      const gv = g.indices[i];
      assertU32(gv, `extrudePolygons: indices[${i}]`);
      if (!localMap.has(gv)) {
        localMap.set(gv, localVerts.length);
        localVerts.push(gv);
      }
    }

    const baseVert = positions.length / 3;
    // Emit bottom verts (Y=minH) then top verts (Y=topH).
    for (const gv of localVerts) {
      const x = g.positions[gv * 2] - origin.x;
      const z = -(g.positions[gv * 2 + 1] - origin.y);
      positions.push(x, minH, z);
    }
    const topBase = baseVert + localVerts.length;
    for (const gv of localVerts) {
      const x = g.positions[gv * 2] - origin.x;
      const z = -(g.positions[gv * 2 + 1] - origin.y);
      positions.push(x, topH, z);
    }

    // Cap triangles. Top wound as input (CCW from above). Bottom wound reversed
    // so its normal points down.
    const triCount = (triEnd - triStart) / 3;
    // Boundary edge counter for sides.
    const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    const edgeCount = new Map<string, number>();
    const edgeRep = new Map<string, [number, number]>();
    for (let t = 0; t < triCount; t++) {
      const a = localMap.get(g.indices[triStart + t * 3 + 0])!;
      const b = localMap.get(g.indices[triStart + t * 3 + 1])!;
      const c = localMap.get(g.indices[triStart + t * 3 + 2])!;
      // top
      indices.push(topBase + a, topBase + b, topBase + c);
      // bottom (reversed winding → down-facing normal)
      indices.push(baseVert + c, baseVert + b, baseVert + a);
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as [number, number][]) {
        const k = edgeKey(u, v);
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
        if (!edgeRep.has(k)) edgeRep.set(k, [u, v]);
      }
    }
    // Side quads for boundary edges (edges that appear exactly once).
    for (const [k, count] of edgeCount) {
      if (count !== 1) continue;
      const [u, v] = edgeRep.get(k)!;
      // Quad: baseVert+u → baseVert+v → topBase+v → topBase+u
      indices.push(baseVert + u, baseVert + v, topBase + v);
      indices.push(baseVert + u, topBase + v, topBase + u);
    }

    featureRanges.push(indices.length);
    featureIds.push(g.featureIds[fi]);
  }

  const posArr = new Float32Array(positions);
  const idxArr = positions.length / 3 < 65535 ? new Uint16Array(indices) : new Uint32Array(indices);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  geom.setIndex(new THREE.BufferAttribute(idxArr, 1));
  geom.computeVertexNormals();

  return {
    geometry: geom,
    featureRanges: new Uint32Array(featureRanges),
    featureIds: new Uint32Array(featureIds),
  };
}

// Build a ribbon mesh from a LayerGeometry of line features.
//
// Emits a **shallow extruded box** per polyline so roads/rail have actual
// physical thickness — visible from any angle, occludes things behind it,
// receives shadows, can't be hidden by a 1-pixel quad coplanarity bug.
//
// Per polyline point we emit 4 verts (L_bot, R_bot, L_top, R_top). Per
// segment we emit a top quad and two outward-facing side quads. No bottom
// (saves tris; nothing renders below thanks to the engine's stage plate).
export interface RibbonUVOpts {
  /** Texture length period in metres along V. */
  lengthPeriodM: number;
  /** Side-vertex UV (neutral asphalt sample so kerbs don't show stripes). */
  sideUV: { u: number; v: number };
}

export function ribbonGeometry(
  g: LayerGeometry,
  origin: Origin,
  widthLookup: (cls: number) => number,
  thickness = 1.0,
  uvOpts?: RibbonUVOpts,
): { geometry: THREE.BufferGeometry; featureRanges: Uint32Array; featureIds: Uint32Array } | null {
  if (g.kind !== "line") return null;
  assertOrigin(origin, "ribbonGeometry");
  assertLayerGeometry(g, "ribbonGeometry");
  assertFinite(thickness, "ribbonGeometry: thickness");
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const featureRanges: number[] = [0];
  const featureIds: number[] = [];
  const yBot = 0;
  const yTop = thickness;
  const vertCountTotal = g.positions.length / 2;

  const featureCount = g.featureIds.length;
  for (let fi = 0; fi < featureCount; fi++) {
    checkLoopBound(fi, MAX_FEATURES_PER_TILE, "ribbonGeometry: feature walk");
    const vStart = g.featureStart[fi];
    const vEnd = g.featureStart[fi + 1];
    assert(
      vStart <= vEnd && vEnd <= vertCountTotal,
      `ribbonGeometry: bad featureStart range [${vStart},${vEnd}] vertCount ${vertCountTotal}`,
    );
    if (vEnd - vStart < 2) {
      featureRanges.push(indices.length);
      featureIds.push(g.featureIds[fi]);
      continue;
    }
    const halfW = widthLookup(g.featureClass[fi]) * 0.5;
    assertFinite(halfW, `ribbonGeometry: halfW for feature ${fi}`);
    const pts: { x: number; z: number }[] = [];
    for (let i = vStart; i < vEnd; i++) {
      checkLoopBound(i - vStart, MAX_VERTICES_PER_TILE, "ribbonGeometry: pt walk");
      pts.push({
        x: g.positions[i * 2] - origin.x,
        z: -(g.positions[i * 2 + 1] - origin.y),
      });
    }
    // Cumulative arc length for V (only used if uvOpts is set).
    const arc: number[] = [0];
    if (uvOpts) {
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dz = pts[i].z - pts[i - 1].z;
        arc.push(arc[i - 1] + Math.hypot(dx, dz));
      }
    }
    const baseVert = positions.length / 3;
    // 4 verts per point: L_bot, R_bot, L_top, R_top
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const tLen = Math.hypot(tx, tz) || 1;
      tx /= tLen;
      tz /= tLen;
      const nx = -tz;
      const nz = tx;
      const lx = p.x + nx * halfW;
      const lz = p.z + nz * halfW;
      const rx = p.x - nx * halfW;
      const rz = p.z - nz * halfW;
      positions.push(lx, yBot, lz);
      positions.push(rx, yBot, rz);
      positions.push(lx, yTop, lz);
      positions.push(rx, yTop, rz);
      if (uvOpts) {
        const v = arc[i] / uvOpts.lengthPeriodM;
        const su = uvOpts.sideUV.u;
        const sv = uvOpts.sideUV.v;
        // L_bot, R_bot use neutral side UV; L_top is left edge (U=0),
        // R_top is right edge (U=1). V along the road length.
        uvs.push(su, sv); // L_bot
        uvs.push(su, sv); // R_bot
        uvs.push(0, v);   // L_top
        uvs.push(1, v);   // R_top
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = baseVert + i * 4;     // L_bot @ current
      const al = a + 2;               // L_top @ current
      const ar = a + 3;               // R_top @ current
      const b = baseVert + (i + 1) * 4; // L_bot @ next
      const bl = b + 2;               // L_top @ next
      const br = b + 3;               // R_top @ next
      // Top face — CCW when viewed from above (+Y), so the normal points up
      // and the face survives back-face culling.
      // L_top@cur → L_top@next → R_top@next → R_top@cur
      indices.push(al, bl, br);
      indices.push(al, br, ar);
      // Left side (outward normal -X for a +Z-going segment).
      // L_bot@cur → L_bot@next → L_top@next → L_top@cur
      indices.push(a, b, bl);
      indices.push(a, bl, al);
      // Right side (outward normal +X for a +Z-going segment).
      // R_top@cur → R_top@next → R_bot@next → R_bot@cur
      indices.push(ar, br, b + 1);
      indices.push(ar, b + 1, a + 1);
      // Bottom face — CCW when viewed from below (-Y), so normal points down.
      // L_bot@cur → R_bot@cur → R_bot@next → L_bot@next
      indices.push(a, a + 1, b + 1);
      indices.push(a, b + 1, b);
    }
    featureRanges.push(indices.length);
    featureIds.push(g.featureIds[fi]);
  }

  const posArr = new Float32Array(positions);
  const vertCount = positions.length / 3;
  const idxArr =
    vertCount < 65535 ? new Uint16Array(indices) : new Uint32Array(indices);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  if (uvOpts) geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geom.setIndex(new THREE.BufferAttribute(idxArr, 1));
  geom.computeVertexNormals();

  return {
    geometry: geom,
    featureRanges: new Uint32Array(featureRanges),
    featureIds: new Uint32Array(featureIds),
  };
}
