// Generic line-feature layer used by Roads, Rail, Paths. Builds a flat ribbon
// at a layer-specific y-lift; each feature's width comes from a width LUT.

import * as THREE from "three";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";
import { ribbonGeometry } from "./util";
import { makeGlowMaterial } from "./glowMaterial";

export interface LineLayerOptions {
  name: LayerName;
  baseColor: THREE.ColorRepresentation;
  emissive: THREE.ColorRepresentation;
  emissiveIntensity: number;
  yLift: number;
  width: (cls: number) => number;
  glowAtNight?: boolean;
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

  constructor(private readonly opts: LineLayerOptions) {
    this.name = opts.name;
    this.root.name = `layer:${opts.name}`;
    this.baseEmissive = opts.emissiveIntensity;
    this.glowAtNight = opts.glowAtNight ?? true;
    this.material = makeGlowMaterial({
      baseColor: opts.baseColor,
      emissive: opts.emissive,
      emissiveIntensity: opts.emissiveIntensity,
      roughness: 0.6,
      metalness: 0.2,
    });
  }

  load(tile: ParsedTile, g: LayerGeometry, ctx: LayerContext): TileMeshHandle | null {
    const { geometry, featureRanges, featureIds } = ribbonGeometry(
      g,
      ctx.sceneOrigin,
      this.opts.width,
      this.opts.yLift,
    );
    if (featureIds.length === 0) {
      geometry.dispose();
      return null;
    }
    const vertCount = (geometry.getAttribute("position") as THREE.BufferAttribute).count;
    geometry.setAttribute("selected", new THREE.BufferAttribute(new Float32Array(vertCount), 1));
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.userData.layer = this.name;
    mesh.userData.tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    this.root.add(mesh);
    const tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    const globalIds = new Array<string>(featureIds.length);
    for (let i = 0; i < featureIds.length; i++) globalIds[i] = `${tileKey}:${featureIds[i]}`;
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
    if (!this.glowAtNight) return;
    const night = Math.max(0, -sunAltitude); // 0..1-ish
    this.material.emissiveIntensity = this.baseEmissive + night * 1.5 * glow;
  }
}
