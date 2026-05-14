// Generic line-feature layer used by Roads, Rail, Paths, Waterways. Each
// polyline becomes a shallow extruded box (top + sides) with optional UV
// mapping for a procedural surface texture.

import * as THREE from "three";
import { assert, assertFinite, assertU32, checkLoopBound } from "@map3d/data-core";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";
import { ribbonGeometry, assertOrigin, MAX_FEATURES_PER_TILE } from "./util";
import { makeGlowMaterial } from "./glowMaterial";

export interface LineLayerOptions {
  name: LayerName;
  baseColor: THREE.ColorRepresentation;
  emissive: THREE.ColorRepresentation;
  emissiveIntensity: number;
  width: (cls: number) => number;
  thickness?: number;
  yLift?: number;
  glowAtNight?: boolean;
  constantGlow?: number;
  /** Optional procedural texture for the top face. */
  texture?: THREE.Texture;
  /** Required when `texture` is set — controls how V maps along road length. */
  textureLengthM?: number;
  /** Required when `texture` is set — UV for side faces (no stripes). */
  textureSideUV?: { u: number; v: number };
}

interface LHandle extends TileMeshHandle {
  mesh: THREE.Mesh;
  featureRanges: Uint32Array;
  featureIds: Uint32Array;
  globalIds: string[];
}

export class LineLayer implements Layer {
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly name: LayerName;
  private handles = new Map<string, LHandle>();
  private baseEmissive: number;
  private glowAtNight: boolean;
  private constantGlow: number;

  constructor(private readonly opts: LineLayerOptions) {
    this.name = opts.name;
    this.root.name = `layer:${opts.name}`;
    this.root.position.y = opts.yLift ?? 0;
    this.baseEmissive = opts.emissiveIntensity;
    this.glowAtNight = opts.glowAtNight ?? true;
    this.constantGlow = opts.constantGlow ?? 0;
    this.material = makeGlowMaterial({
      baseColor: opts.baseColor,
      emissive: opts.emissive,
      emissiveIntensity: opts.emissiveIntensity,
      roughness: 0.85,
      metalness: 0.0,
    });
    if (opts.texture) {
      this.material.map = opts.texture;
      this.material.needsUpdate = true;
    }
  }

  load(tile: ParsedTile, g: LayerGeometry, ctx: LayerContext): TileMeshHandle | null {
    assertU32(tile.z, "LineLayer.load: tile.z");
    assertU32(tile.x, "LineLayer.load: tile.x");
    assertU32(tile.y, "LineLayer.load: tile.y");
    assertOrigin(ctx.sceneOrigin, "LineLayer.load");
    const thickness = this.opts.thickness ?? 1.0;
    assertFinite(thickness, "LineLayer.load: thickness");
    let geometry: THREE.BufferGeometry;
    let featureRanges: Uint32Array;
    let featureIds: Uint32Array;

    // Prefer the worker-baked mesh when available — moves the per-tile
    // ribbon-extrude cost off the main thread.
    const baked = tile.bakedLines?.[this.name];
    if (baked && baked.featureIds.length > 0) {
      assert(baked.positions.length % 3 === 0, "LineLayer.load: baked.positions not multiple of 3");
      assert(
        baked.featureRanges.length === baked.featureIds.length + 1,
        "LineLayer.load: baked.featureRanges length mismatch",
      );
      assert(
        baked.featureIds.length <= MAX_FEATURES_PER_TILE,
        `LineLayer.load: baked featureIds ${baked.featureIds.length} exceeds cap`,
      );
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(baked.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(baked.indices, 1));
      if (baked.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(baked.uvs, 2));
      geometry.computeVertexNormals();
      featureRanges = baked.featureRanges;
      featureIds = baked.featureIds;
    } else {
      const uvOpts =
        this.opts.texture && this.opts.textureLengthM && this.opts.textureSideUV
          ? { lengthPeriodM: this.opts.textureLengthM, sideUV: this.opts.textureSideUV }
          : undefined;
      const built = ribbonGeometry(g, ctx.sceneOrigin, this.opts.width, thickness, uvOpts);
      if (!built) return null;
      geometry = built.geometry;
      featureRanges = built.featureRanges;
      featureIds = built.featureIds;
    }
    if (featureIds.length === 0) {
      geometry.dispose();
      return null;
    }
    const vertCount = (geometry.getAttribute("position") as THREE.BufferAttribute).count;
    geometry.setAttribute("selected", new THREE.BufferAttribute(new Float32Array(vertCount), 1));

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.userData.layer = this.name;
    mesh.userData.tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    mesh.castShadow = thickness >= 0.5;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    const tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    const globalIds = new Array<string>(featureIds.length);
    for (let i = 0; i < featureIds.length; i++) {
      checkLoopBound(i, MAX_FEATURES_PER_TILE, "LineLayer.load: globalIds");
      globalIds[i] = `${tileKey}:${featureIds[i]}`;
    }
    const h: LHandle = {
      mesh,
      featureRanges,
      featureIds,
      globalIds,
      dispose: () => {
        this.root.remove(mesh);
        geometry.dispose();
      },
    };
    this.handles.set(tileKey, h);
    return h;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }
  setOpacity(v: number): void {
    this.material.opacity = v;
    this.material.transparent = v < 1;
  }

  update(_t: number, sunAltitude: number, glow: number): void {
    assertFinite(sunAltitude, "LineLayer.update: sunAltitude");
    assertFinite(glow, "LineLayer.update: glow");
    const night = Math.max(0, -sunAltitude);
    const fromNight = this.glowAtNight ? night * 1.5 * glow : 0;
    this.material.emissiveIntensity = this.baseEmissive + this.constantGlow * glow + fromNight;
  }
}
