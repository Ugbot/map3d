// Pure-JS ribbon mesh generation — same logic as src/engine/layers/util.ts
// `ribbonGeometry`, but no Three.js dependency so it can run in a worker.
//
// Emits a shallow extruded box per polyline with top + bottom + two outward
// side faces. Optional UV mapping (U=0..1 across width on the top, side
// vertices use the configured "neutral asphalt" UV).
//
// Output is scene-local coords (mercator metres shifted by sceneOrigin and
// flipped so mercator north → scene -Z) so the main thread can attach the
// blob to a BufferGeometry without any further transform.

import {
  assert,
  assertU32,
  assertFinite,
  checkLoopBound,
} from "../util/assert";
import type { LayerGeometry } from "./types";

// Tiger Style bounds — generous, but ensure a malformed tile cannot push us
// into a runaway alloc. See tileFetch.worker.ts for the matching caps.
const MAX_RIBBON_FEATURES = 200_000;
const MAX_RIBBON_VERTICES = 1_000_000;

export interface RibbonConfig {
  thickness: number;
  /** widthByClass[classId] in metres. Falls back to widthByClass[0]. */
  widthByClass: Record<number, number>;
  /** If set, generate UVs. V repeats every lengthM. */
  textureLengthM?: number;
  /** Side-face UV (no stripes on kerbs). */
  textureSideUV?: { u: number; v: number };
}

export interface BakedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
  featureRanges: Uint32Array;
  featureIds: Uint32Array;
}

export function bakeRibbonMesh(
  g: LayerGeometry,
  origin: { x: number; y: number },
  cfg: RibbonConfig,
): BakedMesh | null {
  if (g.kind !== "line") return null;
  // Tiger Style entry checks. `g` is already produced by freezeGeometry, but
  // origin/cfg come from RPC payload; treat them as untrusted.
  assertFinite(origin.x, "ribbon origin.x");
  assertFinite(origin.y, "ribbon origin.y");
  assertFinite(cfg.thickness, "ribbon thickness");
  assert(cfg.thickness >= 0, "ribbon thickness >= 0");
  const featureCount = g.featureIds.length;
  assertU32(featureCount, "ribbon featureCount");
  assert(featureCount <= MAX_RIBBON_FEATURES, "ribbon feature cap");
  assert(g.featureStart.length === featureCount + 1, "ribbon featureStart len");
  assert(g.positions.length % 2 === 0, "ribbon positions xy");
  const inVerts = g.positions.length / 2;
  assert(inVerts <= MAX_RIBBON_VERTICES, "ribbon input vertex cap");

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const featureRanges: number[] = [0];
  const featureIds: number[] = [];
  const yBot = 0;
  const yTop = cfg.thickness;
  const fallbackW = cfg.widthByClass[0] ?? 4;
  const wantUVs = cfg.textureLengthM !== undefined && cfg.textureSideUV !== undefined;

  for (let fi = 0; fi < featureCount; fi++) {
    checkLoopBound(fi, MAX_RIBBON_FEATURES, "ribbon features");
    const vStart = g.featureStart[fi];
    const vEnd = g.featureStart[fi + 1];
    assert(vEnd >= vStart, "ribbon featureStart monotonic");
    assert(vEnd <= inVerts, "ribbon featureStart in range");
    if (vEnd - vStart < 2) {
      featureRanges.push(indices.length);
      featureIds.push(g.featureIds[fi]);
      continue;
    }
    const cls = g.featureClass[fi];
    const halfW = (cfg.widthByClass[cls] ?? fallbackW) * 0.5;
    assertFinite(halfW, "ribbon halfW");
    const ptCount = vEnd - vStart;
    assert(ptCount <= MAX_RIBBON_VERTICES, "ribbon ptCount cap");
    // Project points to scene-local XZ once so the inner loops can be tight.
    const pts = new Float32Array(ptCount * 2);
    for (let i = 0; i < ptCount; i++) {
      pts[i * 2] = g.positions[(vStart + i) * 2] - origin.x;
      pts[i * 2 + 1] = -(g.positions[(vStart + i) * 2 + 1] - origin.y);
    }
    const arc = wantUVs ? new Float32Array(ptCount) : null;
    if (arc) {
      for (let i = 1; i < ptCount; i++) {
        const dx = pts[i * 2] - pts[(i - 1) * 2];
        const dz = pts[i * 2 + 1] - pts[(i - 1) * 2 + 1];
        arc[i] = arc[i - 1] + Math.hypot(dx, dz);
      }
    }

    const baseVert = positions.length / 3;
    for (let i = 0; i < ptCount; i++) {
      const px = pts[i * 2];
      const pz = pts[i * 2 + 1];
      const prevI = Math.max(0, i - 1);
      const nextI = Math.min(ptCount - 1, i + 1);
      const dx = pts[nextI * 2] - pts[prevI * 2];
      const dz = pts[nextI * 2 + 1] - pts[prevI * 2 + 1];
      const tLen = Math.hypot(dx, dz) || 1;
      const tnx = dx / tLen;
      const tnz = dz / tLen;
      // Normal-to-tangent in XZ: n = (-tz, tx)
      const nx = -tnz;
      const nz = tnx;
      const lx = px + nx * halfW;
      const lz = pz + nz * halfW;
      const rx = px - nx * halfW;
      const rz = pz - nz * halfW;
      positions.push(lx, yBot, lz);
      positions.push(rx, yBot, rz);
      positions.push(lx, yTop, lz);
      positions.push(rx, yTop, rz);
      if (wantUVs) {
        const v = (arc as Float32Array)[i] / (cfg.textureLengthM as number);
        const su = (cfg.textureSideUV as { u: number; v: number }).u;
        const sv = (cfg.textureSideUV as { u: number; v: number }).v;
        uvs.push(su, sv);
        uvs.push(su, sv);
        uvs.push(0, v);
        uvs.push(1, v);
      }
    }
    for (let i = 0; i < ptCount - 1; i++) {
      const a = baseVert + i * 4;
      const al = a + 2;
      const ar = a + 3;
      const b = baseVert + (i + 1) * 4;
      const bl = b + 2;
      const br = b + 3;
      indices.push(al, bl, br);
      indices.push(al, br, ar);
      indices.push(a, b, bl);
      indices.push(a, bl, al);
      indices.push(ar, br, b + 1);
      indices.push(ar, b + 1, a + 1);
      indices.push(a, a + 1, b + 1);
      indices.push(a, b + 1, b);
    }
    featureRanges.push(indices.length);
    featureIds.push(g.featureIds[fi]);
  }

  // Sentinel invariants before handing off to main thread.
  assert(positions.length % 3 === 0, "ribbon positions xyz");
  assert(indices.length % 3 === 0, "ribbon indices % 3");
  assert(
    featureRanges.length === featureIds.length + 1,
    "ribbon featureRanges length",
  );
  assert(featureIds.length === featureCount, "ribbon featureIds == in count");
  if (wantUVs) assert(uvs.length === (positions.length / 3) * 2, "ribbon uvs len");

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    uvs: wantUVs ? new Float32Array(uvs) : undefined,
    featureRanges: new Uint32Array(featureRanges),
    featureIds: new Uint32Array(featureIds),
  };
}
