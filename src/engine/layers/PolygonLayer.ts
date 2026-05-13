// Flat polygon layer used by Water + Landuse. Triangulated already by the
// worker; we just lift to a small Y to avoid z-fighting with the ground plane.

import * as THREE from "three";
import type { Layer, LayerContext, TileMeshHandle } from "../Layer";
import type { LayerGeometry, LayerName, ParsedTile } from "../../cache/types";
import { flatPolygonGeometry } from "./util";
import { makeGlowMaterial } from "./glowMaterial";

interface PolyOpts {
  name: LayerName;
  baseColor: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
  opacity?: number;
  /** Physical Y offset of the layer root. Combined with polygon offset for
   *  fine-tuning, but the real ordering comes from this. */
  yLift?: number;
}

interface PHandle extends TileMeshHandle {
  mesh: THREE.Mesh;
}

export class PolygonLayer implements Layer {
  readonly root = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly name: LayerName;
  private handles = new Map<string, PHandle>();

  constructor(opts: PolyOpts) {
    this.name = opts.name;
    this.root.name = `layer:${opts.name}`;
    this.root.position.y = opts.yLift ?? 0;
    this.material = makeGlowMaterial({
      baseColor: opts.baseColor,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 0,
      roughness: 0.95,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      side: THREE.DoubleSide,
      polygonOffsetFactor: opts.polygonOffsetFactor,
      polygonOffsetUnits: opts.polygonOffsetUnits ?? opts.polygonOffsetFactor,
    });
  }

  load(tile: ParsedTile, g: LayerGeometry, ctx: LayerContext): TileMeshHandle | null {
    if (g.featureIds.length === 0) return null;
    const geom = flatPolygonGeometry(g, ctx.sceneOrigin);
    if (!geom) return null;
    const mesh = new THREE.Mesh(geom, this.material);
    mesh.userData.layer = this.name;
    mesh.userData.tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    this.root.add(mesh);
    const handle: PHandle = {
      mesh,
      dispose: () => {
        this.root.remove(mesh);
        geom.dispose();
      },
    };
    this.handles.set(`${tile.z}/${tile.x}/${tile.y}`, handle);
    return handle;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }
  setOpacity(v: number): void {
    this.material.opacity = v;
    this.material.transparent = v < 1;
  }
}
