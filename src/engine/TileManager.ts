// Camera-driven tile streamer.
//
// Strategy: pick a single base zoom (default z=15). Compute the slippy tile
// directly under the camera each frame; load a NxN ring around it; evict tiles
// outside the ring + buffer.
//
// Data flow per tile:
//   1. Check IndexedDB parsed cache → if hit, hand straight to layers
//   2. Else dispatch fetch to worker pool → worker reads PMTiles, decodes MVT,
//      returns SoA buffers
//   3. Cache parsed result, hand to layers
//
// All layer dispatch is keyed by tileKey so eviction is O(1) per tile.

import { lonLatToTile, tileMetersBox, tileKey, lonLatToMeters } from "../projection/mercator";
import type { Layer } from "./Layer";
import type { LayerContext } from "./Layer";
import type { LayerName, ParsedTile } from "../cache/types";
import type { TileStore } from "../cache/types";
import { WorkerPool } from "../workers/pool";

interface LoadedTile {
  key: string;
  z: number;
  x: number;
  y: number;
  handles: Partial<Record<LayerName, { dispose(): void }>>;
  lastSeen: number;
}

export interface TileManagerOptions {
  pmtilesUrl: string;
  baseZoom?: number;
  ringRadius?: number; // tiles outwards from camera tile (1 ring = 3x3 = 9 tiles)
  bufferRings?: number; // extra rings before eviction kicks in
  sceneOrigin: { x: number; y: number };
  layers: Record<LayerName, Layer>;
  store: TileStore;
  workers: WorkerPool;
  onProgress?: (loaded: number, inflight: number) => void;
  onSelect?: (layer: LayerName, featureGlobalId: string) => void;
  onTileLoaded?: (tile: ParsedTile) => void;
  onTileEvicted?: (tileKey: string) => void;
}

export class TileManager {
  private loaded = new Map<string, LoadedTile>();
  private inflight = new Set<string>();
  private cancelled = new Set<string>();
  private readonly baseZoom: number;
  private readonly ringRadius: number;
  private readonly bufferRings: number;
  private readonly ctx: LayerContext;
  private bbox: { west: number; south: number; east: number; north: number } | null = null;

  constructor(private readonly opts: TileManagerOptions) {
    this.baseZoom = opts.baseZoom ?? 15;
    this.ringRadius = opts.ringRadius ?? 2;
    this.bufferRings = opts.bufferRings ?? 1;
    this.ctx = {
      sceneOrigin: opts.sceneOrigin,
      onSelect: opts.onSelect ?? (() => {}),
    };
  }

  /** Initialise the worker pool against the PMTiles URL. */
  async init(): Promise<void> {
    for (let i = 0; i < (navigator.hardwareConcurrency || 2); i++) {
      // pool.request fans out round-robin; we send init to every worker so each
      // one has its own PMTiles instance.
      try {
        await this.opts.workers.request("init", { url: this.opts.pmtilesUrl });
      } catch {
        // already initialised on that worker
      }
    }
  }

  /** Optionally clamp streaming to a bbox (e.g. the user's selection). */
  setBBox(bbox: { west: number; south: number; east: number; north: number } | null) {
    this.bbox = bbox;
  }

  /** Called every frame from Engine.update. */
  poll(cameraWorldX: number, cameraWorldZ: number): void {
    // cameraWorldX/Z are scene-local; reconstruct mercator metres by adding back origin.
    const mx = cameraWorldX + this.opts.sceneOrigin.x;
    const my = -cameraWorldZ + this.opts.sceneOrigin.y;
    // Camera mercator → tile.
    // Inverse of lonLatToMeters and lonLatToTile composed; simpler to compute
    // tile directly via metres-to-tile.
    const z = this.baseZoom;
    const tileSize = (Math.PI * 2 * 6378137) / Math.pow(2, z);
    const originShift = (Math.PI * 2 * 6378137) / 2;
    const camTx = (mx + originShift) / tileSize;
    const camTy = (originShift - my) / tileSize;
    const cx = Math.floor(camTx);
    const cy = Math.floor(camTy);

    // Decide desired tiles within ringRadius.
    const desired = new Set<string>();
    for (let dx = -this.ringRadius; dx <= this.ringRadius; dx++) {
      for (let dy = -this.ringRadius; dy <= this.ringRadius; dy++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (this.bbox && !this.tileIntersectsBBox(z, tx, ty)) continue;
        const key = tileKey(z, tx, ty);
        desired.add(key);
        if (!this.loaded.has(key) && !this.inflight.has(key)) {
          this.dispatch(z, tx, ty);
        }
      }
    }

    // Evict tiles outside the (ringRadius + bufferRings) ring.
    const evictRadius = this.ringRadius + this.bufferRings;
    for (const [key, lt] of this.loaded) {
      const ddx = Math.abs(lt.x - cx);
      const ddy = Math.abs(lt.y - cy);
      if (ddx > evictRadius || ddy > evictRadius) {
        this.evict(key);
      }
    }
    // Cancel inflight requests that are outside the desired set already.
    for (const k of this.inflight) {
      if (!desired.has(k)) this.cancelled.add(k);
    }
  }

  private tileIntersectsBBox(z: number, x: number, y: number): boolean {
    if (!this.bbox) return true;
    const n = Math.pow(2, z);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const corner of [
      [this.bbox.west, this.bbox.north],
      [this.bbox.east, this.bbox.south],
    ]) {
      const t = lonLatToTile(corner[0], corner[1], z);
      xs.push(t.x);
      ys.push(t.y);
    }
    const minX = Math.floor(Math.min(...xs));
    const maxX = Math.floor(Math.max(...xs));
    const minY = Math.floor(Math.min(...ys));
    const maxY = Math.floor(Math.max(...ys));
    void n;
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  }

  private async dispatch(z: number, x: number, y: number): Promise<void> {
    const key = tileKey(z, x, y);
    this.inflight.add(key);
    this.opts.onProgress?.(this.loaded.size, this.inflight.size);
    try {
      let parsed = await this.opts.store.getParsed(z, x, y, 1);
      if (!parsed) {
        if (this.cancelled.has(key)) {
          this.cancelled.delete(key);
          return;
        }
        const res = await this.opts.workers.request<{ tile?: ParsedTile; missing?: boolean }>(
          "fetchTile",
          { z, x, y },
        );
        if (res.missing || !res.tile) {
          this.inflight.delete(key);
          return;
        }
        parsed = res.tile;
        this.opts.store.putParsed(parsed).catch((e) => console.warn("cache put failed", e));
      }
      if (this.cancelled.has(key)) {
        this.cancelled.delete(key);
        this.inflight.delete(key);
        return;
      }
      this.installTile(parsed);
    } catch (err) {
      console.warn("tile fetch failed", key, err);
    } finally {
      this.inflight.delete(key);
      this.opts.onProgress?.(this.loaded.size, this.inflight.size);
    }
  }

  private installTile(parsed: ParsedTile) {
    const key = tileKey(parsed.z, parsed.x, parsed.y);
    if (this.loaded.has(key)) return; // raced with another caller
    const handles: LoadedTile["handles"] = {};
    for (const layerName in parsed.layers) {
      const ln = layerName as LayerName;
      const layer = this.opts.layers[ln];
      if (!layer) continue;
      const handle = layer.load(parsed, parsed.layers[ln]!, this.ctx);
      if (handle) handles[ln] = handle;
    }
    this.loaded.set(key, {
      key,
      z: parsed.z,
      x: parsed.x,
      y: parsed.y,
      handles,
      lastSeen: Date.now(),
    });
    this.opts.onTileLoaded?.(parsed);
  }

  private evict(key: string) {
    const lt = this.loaded.get(key);
    if (!lt) return;
    for (const ln in lt.handles) {
      lt.handles[ln as LayerName]?.dispose();
    }
    this.loaded.delete(key);
    this.opts.onTileEvicted?.(key);
  }

  /** Compute the centre-meters point of the bbox to use as sceneOrigin. */
  static computeSceneOrigin(bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  }): { x: number; y: number } {
    const centerLon = (bbox.west + bbox.east) / 2;
    const centerLat = (bbox.south + bbox.north) / 2;
    return lonLatToMeters(centerLon, centerLat);
  }

  /** Visible loaded tiles, for engine queries (debug HUD, exports). */
  get loadedKeys(): string[] {
    return Array.from(this.loaded.keys());
  }

  /** Helper for selection: find building handle for a given mesh+face. */
  getLoadedTile(key: string): LoadedTile | undefined {
    return this.loaded.get(key);
  }

  /** Get the centre of a tile in scene-local coords (for camera anchoring). */
  tileSceneCenter(z: number, x: number, y: number): { x: number; z: number } {
    const box = tileMetersBox(z, x, y);
    const cx = (box.minX + box.maxX) / 2 - this.opts.sceneOrigin.x;
    const cz = -((box.minY + box.maxY) / 2 - this.opts.sceneOrigin.y);
    return { x: cx, z: cz };
  }

  dispose() {
    for (const k of Array.from(this.loaded.keys())) this.evict(k);
  }
}
