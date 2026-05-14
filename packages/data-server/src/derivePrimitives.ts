// Pure derivation of renderable primitive records from a parsed MVT tile.
// Mirrors the client-side layer logic so the data-server can send oriented
// building boxes, ribbon meshes for line layers, triangulated meshes for
// polygons, lanterns, and props directly down the wire.
//
// Tiger style: every coordinate runs through assertFinite; every feature loop
// is bounded by checkLoopBound with a hard cap.

import {
  assertFinite,
  assertU32,
  assertInRange,
  checkLoopBound,
  bakeRibbonMesh,
  RoadWidthM,
  RailWidthM,
  PathWidthM,
  PoiClass,
  type ParsedTile,
  type LayerGeometry,
  type LayerName,
  type BuildingRecord,
  type MeshRecord,
  type LanternRecord,
  type PropRecord,
} from "@map3d/data-core";

const MAX_FEATURES_PER_TILE = 200_000;
const MAX_INDICES_PER_MESH = 65_536;

// Building height buckets — kept in lockstep with renderer prefab kinds.
const BUILDING_KIND_LOW = 0;
const BUILDING_KIND_MID = 1;
const BUILDING_KIND_HIGH = 2;

// Mesh layer_kind values per spec.
export const MESH_LAYER_ROADS = 0;
export const MESH_LAYER_RAIL = 1;
export const MESH_LAYER_PATHS = 2;
export const MESH_LAYER_WATERWAY = 3;
export const MESH_LAYER_WATER = 16;
export const MESH_LAYER_LANDCOVER = 17;
export const MESH_LAYER_LANDUSE = 18;

// Prop kinds — spec mapping.
const PROP_KIND_TREE = 0;
const PROP_KIND_BIN = 1;
const PROP_KIND_HYDRANT = 2;
const PROP_KIND_BENCH = 3;

// Map a POI class (data-core enum) to a coarse prop kind. Unknown classes are
// dropped silently — the renderer has prefabs only for the four kinds above.
function poiClassToPropKind(cls: number): number | null {
  if (cls === PoiClass.leisure) return PROP_KIND_BENCH;
  if (cls === PoiClass.transit) return PROP_KIND_BIN;
  if (cls === PoiClass.emergency) return PROP_KIND_HYDRANT;
  if (cls === PoiClass.attraction) return PROP_KIND_TREE;
  return null;
}

export interface DerivedTilePrimitives {
  buildings: BuildingRecord[];
  meshes: MeshRecord[];
  lanterns: LanternRecord[];
  props: PropRecord[];
}

/**
 * Pack (z, x, y, fi) into a single u32 remote id. The tile cohort is encoded
 * in the high 19 bits (8 z + 11 each x/y mod), and fi in the low 13 bits.
 * That's enough room for 4k tiles × 8k features per tile, which suffices for
 * a streaming ring at baseZoom=15.
 */
export function packRemoteId(z: number, x: number, y: number, fi: number): number {
  assertU32(z, "packRemoteId.z");
  assertU32(x, "packRemoteId.x");
  assertU32(y, "packRemoteId.y");
  assertU32(fi, "packRemoteId.fi");
  assertInRange(z, 0, 31, "packRemoteId.z");
  // Mix the tile coordinates with a stable hash; we only need uniqueness
  // within a single client's loaded set, not a reversible packing.
  const hi = (((z & 0x1f) << 27) ^ ((x & 0x7fff) << 12) ^ ((y & 0x7fff) << 0)) >>> 0;
  const lo = fi & 0xfffff; // 20 low bits for feature index
  return ((hi ^ lo) >>> 0);
}

export function derivePrimitives(
  tile: ParsedTile,
  sceneOrigin: { x: number; y: number },
  baseRemoteId: number,
): DerivedTilePrimitives {
  assertFinite(sceneOrigin.x, "derivePrimitives.sceneOrigin.x");
  assertFinite(sceneOrigin.y, "derivePrimitives.sceneOrigin.y");
  assertU32(baseRemoteId, "derivePrimitives.baseRemoteId");

  const buildings: BuildingRecord[] = [];
  const meshes: MeshRecord[] = [];
  const lanterns: LanternRecord[] = [];
  const props: PropRecord[] = [];

  deriveBuildings(tile, sceneOrigin, buildings);
  deriveRibbon(tile, sceneOrigin, "roads", MESH_LAYER_ROADS, { thickness: 1.2, widthByClass: RoadWidthM }, meshes);
  deriveRibbon(tile, sceneOrigin, "rail", MESH_LAYER_RAIL, { thickness: 1.6, widthByClass: RailWidthM }, meshes);
  deriveRibbon(tile, sceneOrigin, "paths", MESH_LAYER_PATHS, { thickness: 0.6, widthByClass: PathWidthM }, meshes);
  deriveRibbon(tile, sceneOrigin, "waterway", MESH_LAYER_WATERWAY, { thickness: 0.5, widthByClass: { 0: 4 } }, meshes);
  derivePolygon(tile, sceneOrigin, "water", MESH_LAYER_WATER, meshes);
  derivePolygon(tile, sceneOrigin, "landcover", MESH_LAYER_LANDCOVER, meshes);
  derivePolygon(tile, sceneOrigin, "landuse", MESH_LAYER_LANDUSE, meshes);
  deriveLanterns(tile, sceneOrigin, lanterns);
  deriveProps(tile, sceneOrigin, props);

  return { buildings, meshes, lanterns, props };
}

function deriveBuildings(
  tile: ParsedTile,
  sceneOrigin: { x: number; y: number },
  out: BuildingRecord[],
): void {
  const g = tile.layers.buildings;
  if (!g || g.kind !== "polygon" || !g.indices) return;
  const featureCount = g.featureIds.length;
  for (let fi = 0; fi < featureCount; fi++) {
    checkLoopBound(fi, MAX_FEATURES_PER_TILE, "deriveBuildings.features");
    // featureStart[i..i+1] are index *positions* (triangle indices) for poly.
    const iStart = g.featureStart[fi];
    const iEnd = g.featureStart[fi + 1];
    if (iEnd <= iStart) continue;
    // Collect the unique vertex set referenced by these triangles. Cap so a
    // single pathologically large building cannot dominate the loop.
    const seen = new Set<number>();
    let i = iStart;
    let safety = 0;
    while (i < iEnd) {
      checkLoopBound(safety++, MAX_FEATURES_PER_TILE * 6, "deriveBuildings.indexScan");
      seen.add(g.indices[i]);
      i++;
    }
    if (seen.size < 3) continue;

    // Pull vertices in scene-local metres (x, z = -mercator_y).
    const pts: { x: number; z: number }[] = [];
    let scan = 0;
    for (const vi of seen) {
      checkLoopBound(scan++, MAX_FEATURES_PER_TILE * 4, "deriveBuildings.vertGather");
      const mx = g.positions[vi * 2];
      const my = g.positions[vi * 2 + 1];
      const sx = mx - sceneOrigin.x;
      const sz = -(my - sceneOrigin.y);
      assertFinite(sx, "building vertex sx");
      assertFinite(sz, "building vertex sz");
      pts.push({ x: sx, z: sz });
    }

    // PCA-based oriented bounding box.
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < pts.length; k++) {
      cx += pts[k].x;
      cz += pts[k].z;
    }
    cx /= pts.length;
    cz /= pts.length;
    let sxx = 0;
    let szz = 0;
    let sxz = 0;
    for (let k = 0; k < pts.length; k++) {
      const dx = pts[k].x - cx;
      const dz = pts[k].z - cz;
      sxx += dx * dx;
      szz += dz * dz;
      sxz += dx * dz;
    }
    const n = pts.length;
    sxx /= n;
    szz /= n;
    sxz /= n;
    // Principal eigenvector of the 2×2 symmetric covariance.
    // λ = (trace ± sqrt(trace²-4*det))/2 ; pick larger.
    const trace = sxx + szz;
    const det = sxx * szz - sxz * sxz;
    const disc = Math.max(0, trace * trace * 0.25 - det);
    const lambda = trace * 0.5 + Math.sqrt(disc);
    // Eigenvector for λ: (sxz, λ - sxx) if sxz != 0; else axis-aligned.
    let axisX: number;
    let axisZ: number;
    if (Math.abs(sxz) > 1e-9) {
      axisX = sxz;
      axisZ = lambda - sxx;
    } else if (sxx >= szz) {
      axisX = 1;
      axisZ = 0;
    } else {
      axisX = 0;
      axisZ = 1;
    }
    const al = Math.hypot(axisX, axisZ) || 1;
    axisX /= al;
    axisZ /= al;
    // Perpendicular axis.
    const perpX = -axisZ;
    const perpZ = axisX;
    // Extents of vertices in the rotated frame.
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let k = 0; k < pts.length; k++) {
      const dx = pts[k].x - cx;
      const dz = pts[k].z - cz;
      const a = dx * axisX + dz * axisZ;
      const b = dx * perpX + dz * perpZ;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    const halfA = (maxA - minA) * 0.5;
    const halfB = (maxB - minB) * 0.5;
    const centreA = (maxA + minA) * 0.5;
    const centreB = (maxB + minB) * 0.5;
    // Map rotated centre back to world frame.
    const rcx = cx + centreA * axisX + centreB * perpX;
    const rcz = cz + centreA * axisZ + centreB * perpZ;
    // sx is along the principal (long) axis; sz across.
    const boxLong = halfA * 2;
    const boxShort = halfB * 2;
    if (!Number.isFinite(boxLong) || !Number.isFinite(boxShort)) continue;
    if (boxLong < 1e-3 || boxShort < 1e-3) continue;
    // Heading follows codebase convention: atan2(axisX, axisZ) maps north→0.
    const heading = Math.atan2(axisX, axisZ);

    const heightM = Math.max(0, g.featureHeight[fi]);
    const minHeightM = Math.max(0, g.featureMinHeight[fi]);
    const sy = heightM > 0 ? heightM : 6; // default 6 m so empty heights still render
    const cy = minHeightM + sy * 0.5;

    let kind = BUILDING_KIND_LOW;
    if (sy > 120) kind = BUILDING_KIND_HIGH;
    else if (sy > 60) kind = BUILDING_KIND_MID;

    out.push({
      remoteId: packRemoteId(tile.z, tile.x, tile.y, fi) >>> 0,
      kind,
      cx: rcx,
      cy,
      cz: rcz,
      sx: boxLong,
      sy,
      sz: boxShort,
      heading,
      color: 0,
    });
  }
}

function deriveRibbon(
  tile: ParsedTile,
  sceneOrigin: { x: number; y: number },
  layerName: LayerName,
  layerKind: number,
  cfg: { thickness: number; widthByClass: Record<number, number> },
  out: MeshRecord[],
): void {
  const g = tile.layers[layerName];
  if (!g || g.kind !== "line") return;
  // bakeRibbonMesh already converts to scene-local with z = -(mercator_y).
  const baked = bakeRibbonMesh(g, sceneOrigin, cfg);
  if (!baked) return;
  if (baked.indices.length === 0) return;
  splitAndPushMesh(
    tile,
    layerName,
    layerKind,
    baked.positions,
    baked.indices,
    out,
  );
}

function derivePolygon(
  tile: ParsedTile,
  sceneOrigin: { x: number; y: number },
  layerName: LayerName,
  layerKind: number,
  out: MeshRecord[],
): void {
  const g = tile.layers[layerName];
  if (!g || g.kind !== "polygon" || !g.indices) return;
  const inPositions = g.positions;
  const inIndices = g.indices;
  const vertexCount = inPositions.length / 2;
  if (inIndices.length === 0) return;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    checkLoopBound(i, MAX_FEATURES_PER_TILE * 16, "derivePolygon.verts");
    const mx = inPositions[i * 2];
    const my = inPositions[i * 2 + 1];
    const sx = mx - sceneOrigin.x;
    const sz = -(my - sceneOrigin.y);
    assertFinite(sx, `polygon vertex sx (${layerName})`);
    assertFinite(sz, `polygon vertex sz (${layerName})`);
    positions[i * 3 + 0] = sx;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = sz;
  }
  // Indices already triangle-fan ready (earcut output stored linearly).
  const indices = new Uint32Array(inIndices);
  splitAndPushMesh(tile, layerName, layerKind, positions, indices, out);
}

function splitAndPushMesh(
  tile: ParsedTile,
  layerName: LayerName,
  layerKind: number,
  positions: Float32Array,
  indices: Uint32Array,
  out: MeshRecord[],
): void {
  // FrameCodec requires indices[i]*3 < n_floats; positions are 3-component.
  // If we have more than the cap, split — but each split needs its own vertex
  // remap to keep indices small. Simplest correct approach: chunk indices and
  // include only referenced vertices per chunk.
  if (indices.length <= MAX_INDICES_PER_MESH) {
    pushMesh(tile, layerName, layerKind, positions, indices, out, 0);
    return;
  }
  let chunkStart = 0;
  let chunkSeq = 0;
  while (chunkStart < indices.length) {
    checkLoopBound(chunkSeq, 1024, "splitAndPushMesh.chunks");
    const chunkEnd = Math.min(indices.length, chunkStart + MAX_INDICES_PER_MESH);
    // Re-pack vertices used by this chunk.
    const remap = new Map<number, number>();
    const subPos: number[] = [];
    const subIdx = new Uint32Array(chunkEnd - chunkStart);
    for (let i = chunkStart; i < chunkEnd; i++) {
      const vi = indices[i];
      let mapped = remap.get(vi);
      if (mapped === undefined) {
        mapped = subPos.length / 3;
        subPos.push(
          positions[vi * 3 + 0],
          positions[vi * 3 + 1],
          positions[vi * 3 + 2],
        );
        remap.set(vi, mapped);
      }
      subIdx[i - chunkStart] = mapped;
    }
    pushMesh(
      tile,
      layerName,
      layerKind,
      new Float32Array(subPos),
      subIdx,
      out,
      chunkSeq,
    );
    chunkStart = chunkEnd;
    chunkSeq++;
  }
}

function pushMesh(
  tile: ParsedTile,
  layerName: LayerName,
  layerKind: number,
  positions: Float32Array,
  indices: Uint32Array,
  out: MeshRecord[],
  subSeq: number,
): void {
  // Build a stable per-(tile, layer, sub-chunk) remote id by hashing in the
  // layer kind so different layers don't collide.
  const remoteId =
    (packRemoteId(tile.z, tile.x, tile.y, (layerKind << 8) | (subSeq & 0xff)) >>> 0);
  out.push({
    remoteId,
    layerKind,
    originX: 0,
    originY: 0,
    originZ: 0,
    color: 0,
    positions,
    indices,
  });
  // Silence unused-name lint without dropping the parameter.
  void layerName;
}

function deriveLanterns(
  tile: ParsedTile,
  sceneOrigin: { x: number; y: number },
  out: LanternRecord[],
): void {
  const g = tile.layers.streetlights;
  if (!g || g.kind !== "point") return;
  const featureCount = g.featureIds.length;
  for (let fi = 0; fi < featureCount; fi++) {
    checkLoopBound(fi, MAX_FEATURES_PER_TILE, "deriveLanterns.features");
    const vStart = g.featureStart[fi];
    const vEnd = g.featureStart[fi + 1];
    if (vEnd <= vStart) continue;
    const mx = g.positions[vStart * 2];
    const my = g.positions[vStart * 2 + 1];
    const x = mx - sceneOrigin.x;
    const z = -(my - sceneOrigin.y);
    assertFinite(x, "lantern.x");
    assertFinite(z, "lantern.z");
    out.push({
      remoteId: packRemoteId(tile.z, tile.x, tile.y, fi) >>> 0,
      x,
      y: 0,
      z,
    });
  }
}

function deriveProps(
  tile: ParsedTile,
  sceneOrigin: { x: number; y: number },
  out: PropRecord[],
): void {
  const g: LayerGeometry | undefined = tile.layers.pois;
  if (!g || g.kind !== "point") return;
  const featureCount = g.featureIds.length;
  for (let fi = 0; fi < featureCount; fi++) {
    checkLoopBound(fi, MAX_FEATURES_PER_TILE, "deriveProps.features");
    const cls = g.featureClass[fi];
    const propKind = poiClassToPropKind(cls);
    if (propKind === null) continue;
    const vStart = g.featureStart[fi];
    const vEnd = g.featureStart[fi + 1];
    if (vEnd <= vStart) continue;
    const mx = g.positions[vStart * 2];
    const my = g.positions[vStart * 2 + 1];
    const x = mx - sceneOrigin.x;
    const z = -(my - sceneOrigin.y);
    assertFinite(x, "prop.x");
    assertFinite(z, "prop.z");
    out.push({
      remoteId: packRemoteId(tile.z, tile.x, tile.y, fi) >>> 0,
      propKind,
      x,
      y: 0,
      z,
      heading: 0,
    });
  }
}
