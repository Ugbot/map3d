// Shared geometry helpers for layer implementations.

import * as THREE from "three";
import type { LayerGeometry } from "../../cache/types";

export interface Origin {
  x: number;
  y: number;
}

// Convert Mercator-metres positions (x east, y north) into a Three.js BufferGeometry
// suitable for a flat (Y=0) ground-plane polygon. y mercator becomes -z scene
// because Three.js convention is +Z out of screen.
export function flatPolygonGeometry(
  g: LayerGeometry,
  origin: Origin,
  yLift = 0,
): THREE.BufferGeometry {
  if (g.kind !== "polygon" || !g.indices) throw new Error("polygon expected");
  const vertCount = g.positions.length / 2;
  const verts = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    verts[i * 3 + 0] = g.positions[i * 2] - origin.x;
    verts[i * 3 + 1] = yLift;
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
  fallbackHeightForClass: (cls: number) => number,
): { geometry: THREE.BufferGeometry; featureRanges: Uint32Array; featureIds: Uint32Array } {
  if (g.kind !== "polygon" || !g.indices) throw new Error("polygon expected");
  const positions: number[] = [];
  const indices: number[] = [];
  const featureRanges: number[] = [0]; // index ranges per feature (in indices array)
  const featureIds: number[] = [];

  const featureCount = g.featureIds.length;
  for (let fi = 0; fi < featureCount; fi++) {
    const triStart = g.featureStart[fi];
    const triEnd = g.featureStart[fi + 1];
    if (triEnd === triStart) {
      featureRanges.push(indices.length);
      featureIds.push(g.featureIds[fi]);
      continue;
    }
    const minH = g.featureMinHeight[fi];
    let topH = g.featureHeight[fi];
    if (topH <= 0) topH = fallbackHeightForClass(g.featureClass[fi]);
    if (topH <= minH) topH = minH + 3;

    // Find local vertex set used by this feature's triangles.
    const localMap = new Map<number, number>(); // global vertIdx → local index
    const localVerts: number[] = []; // global vertex indices in local order
    for (let i = triStart; i < triEnd; i++) {
      const gv = g.indices[i];
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
// Each feature is a single polyline. Per-class width comes from `widthLookup`.
export function ribbonGeometry(
  g: LayerGeometry,
  origin: Origin,
  widthLookup: (cls: number) => number,
  yLift = 0.05,
): { geometry: THREE.BufferGeometry; featureRanges: Uint32Array; featureIds: Uint32Array } {
  if (g.kind !== "line") throw new Error("line expected");
  const positions: number[] = [];
  const indices: number[] = [];
  const featureRanges: number[] = [0];
  const featureIds: number[] = [];

  const featureCount = g.featureIds.length;
  for (let fi = 0; fi < featureCount; fi++) {
    const vStart = g.featureStart[fi];
    const vEnd = g.featureStart[fi + 1];
    if (vEnd - vStart < 2) {
      featureRanges.push(indices.length);
      featureIds.push(g.featureIds[fi]);
      continue;
    }
    const halfW = widthLookup(g.featureClass[fi]) * 0.5;
    const pts: { x: number; z: number }[] = [];
    for (let i = vStart; i < vEnd; i++) {
      pts.push({
        x: g.positions[i * 2] - origin.x,
        z: -(g.positions[i * 2 + 1] - origin.y),
      });
    }
    // Emit two vertices per point (left and right offsets along the normal).
    const baseVert = positions.length / 3;
    for (let i = 0; i < pts.length; i++) {
      // Tangent from neighbours.
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const tLen = Math.hypot(tx, tz) || 1;
      tx /= tLen;
      tz /= tLen;
      // Normal (perp in 2D, y-axis rotation): n = (-tz, tx)
      const nx = -tz;
      const nz = tx;
      positions.push(p.x + nx * halfW, yLift, p.z + nz * halfW); // left
      positions.push(p.x - nx * halfW, yLift, p.z - nz * halfW); // right
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = baseVert + i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
    featureRanges.push(indices.length);
    featureIds.push(g.featureIds[fi]);
  }

  const posArr = new Float32Array(positions);
  const idxArr =
    positions.length / 3 < 65535 ? new Uint16Array(indices) : new Uint32Array(indices);
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
