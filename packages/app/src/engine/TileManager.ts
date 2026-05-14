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
import { DERIVED_SOURCES } from "./layers";
import {
  assert,
  assertU32,
  assertFinite,
  assertInRange,
  checkLoopBound,
} from "@map3d/data-core";

// Tiger-style hard caps. These are well above any legitimate working set: at
// z=15 a ring radius of 8 yields (2*8+1)^2 = 289 tiles. 4096 gives plenty of
// headroom while still tripping on runaway allocation bugs (e.g. accidental
// O(n^2) growth of `loaded` or `inflight`).
const MAX_RING_RADIUS = 32;
const MAX_TILES_INFLIGHT = 4096;
const MAX_TILES_LOADED = 4096;
const MAX_INSTALL_QUEUE = 4096;
// Slippy-map z is bounded to [0,30] in practice; OSM tops out at 22.
const MAX_TILE_ZOOM = 30;
// Layer install loops iterate over an object with bounded key set; the union
// LayerName has 13 entries today. 64 is a generous ceiling that catches stray
// non-LayerName keys leaking in from worker payloads.
const MAX_LAYERS_PER_TILE = 64;

interface LoadedTile {
  key: string;
  z: number;
  x: number;
  y: number;
  handles: Partial<Record<LayerName, { dispose(): void }>>;
  lastSeen: number;
}

export interface TileManagerOptions {
  /** @deprecated unused; tile source is configured per-worker via init payload. */
  pmtilesUrl?: string;
  baseZoom?: number;
  ringRadius?: number;
  bufferRings?: number;
  cacheVersion: number;
  sceneOrigin: { x: number; y: number };
  layers: Record<LayerName, Layer>;
  store: TileStore;
  workers: WorkerPool;
  /** Forwarded to every worker on init. */
  workerInitPayload: unknown;
  onProgress?: (loaded: number, inflight: number) => void;
  onSelect?: (layer: LayerName, featureGlobalId: string) => void;
  onTileLoaded?: (tile: ParsedTile) => void;
  onTileEvicted?: (tileKey: string) => void;
}

export class TileManager {
  private loaded = new Map<string, LoadedTile>();
  private inflight = new Set<string>();
  private cancelled = new Set<string>();
  // Parsed tiles that arrived but haven't been installed to layers yet.
  // Throttling installation prevents frame freezes when many tiles arrive at
  // once (the ribbon-extrude geometry generation is non-trivial main-thread
  // work — even with workers doing the parse).
  private installQueue: ParsedTile[] = [];
  private static readonly INSTALLS_PER_FRAME = 2;
  private readonly baseZoom: number;
  private readonly ringRadius: number;
  private readonly bufferRings: number;
  private readonly ctx: LayerContext;
  private bbox: { west: number; south: number; east: number; north: number } | null = null;

  constructor(private readonly opts: TileManagerOptions) {
    assert(opts != null, "TileManager: opts required");
    assertU32(opts.cacheVersion, "TileManager: cacheVersion");
    assertFinite(opts.sceneOrigin.x, "TileManager: sceneOrigin.x");
    assertFinite(opts.sceneOrigin.y, "TileManager: sceneOrigin.y");
    assert(opts.layers != null, "TileManager: layers required");
    assert(opts.store != null, "TileManager: store required");
    assert(opts.workers != null, "TileManager: workers required");
    this.baseZoom = opts.baseZoom ?? 15;
    this.ringRadius = opts.ringRadius ?? 2;
    this.bufferRings = opts.bufferRings ?? 1;
    assertInRange(this.baseZoom, 0, MAX_TILE_ZOOM, "TileManager: baseZoom");
    assertInRange(this.ringRadius, 0, MAX_RING_RADIUS, "TileManager: ringRadius");
    assertInRange(this.bufferRings, 0, MAX_RING_RADIUS, "TileManager: bufferRings");
    this.ctx = {
      sceneOrigin: opts.sceneOrigin,
      onSelect: opts.onSelect ?? (() => {}),
    };
  }

  /** Initialise every worker with the provider config. */
  async init(): Promise<void> {
    try {
      await this.opts.workers.broadcast("init", this.opts.workerInitPayload);
    } catch (err) {
      // Broadcast may legitimately fail if a worker is restarting; we degrade
      // to a per-request init path. Log structured context rather than swallow.
      console.error("TileManager.init: worker broadcast failed", { err });
    }
  }

  /** Optionally clamp streaming to a bbox (e.g. the user's selection). */
  setBBox(bbox: { west: number; south: number; east: number; north: number } | null) {
    if (bbox) {
      assertFinite(bbox.west, "setBBox: west");
      assertFinite(bbox.south, "setBBox: south");
      assertFinite(bbox.east, "setBBox: east");
      assertFinite(bbox.north, "setBBox: north");
      assertInRange(bbox.west, -180, 180, "setBBox: west");
      assertInRange(bbox.east, -180, 180, "setBBox: east");
      assertInRange(bbox.south, -90, 90, "setBBox: south");
      assertInRange(bbox.north, -90, 90, "setBBox: north");
    }
    this.bbox = bbox;
  }

  /** Called every frame from Engine.update. */
  poll(cameraWorldX: number, cameraWorldZ: number): void {
    assertFinite(cameraWorldX, "poll: cameraWorldX");
    assertFinite(cameraWorldZ, "poll: cameraWorldZ");
    // Loaded/inflight sets must stay within the tiger-style caps; if they
    // don't, we have a leak (eviction not running, or runaway dispatch).
    assert(this.loaded.size <= MAX_TILES_LOADED, "poll: loaded set overflow");
    assert(this.inflight.size <= MAX_TILES_INFLIGHT, "poll: inflight set overflow");
    assert(
      this.installQueue.length <= MAX_INSTALL_QUEUE,
      "poll: installQueue overflow",
    );

    this.drainInstallQueue();

    // cameraWorldX/Z are scene-local; reconstruct mercator metres by adding back origin.
    const mx = cameraWorldX + this.opts.sceneOrigin.x;
    const my = -cameraWorldZ + this.opts.sceneOrigin.y;
    const z = this.baseZoom;
    const tileSize = (Math.PI * 2 * 6378137) / Math.pow(2, z);
    const originShift = (Math.PI * 2 * 6378137) / 2;
    const camTx = (mx + originShift) / tileSize;
    const camTy = (originShift - my) / tileSize;
    assertFinite(camTx, "poll: camTx");
    assertFinite(camTy, "poll: camTy");
    const cx = Math.floor(camTx);
    const cy = Math.floor(camTy);

    const desired = this.computeDesiredAndDispatch(z, cx, cy);
    this.evictOutsideRing(cx, cy);
    this.cancelUndesiredInflight(desired);
  }

  /** Drain at most INSTALLS_PER_FRAME items from the pending-install queue. */
  private drainInstallQueue(): void {
    const cap = TileManager.INSTALLS_PER_FRAME;
    for (let n = 0; n < cap && this.installQueue.length > 0; n++) {
      checkLoopBound(n, cap, "drainInstallQueue");
      const next = this.installQueue.shift()!;
      this.installTile(next);
    }
  }

  /** Decide desired tiles within ringRadius and dispatch any missing ones. */
  private computeDesiredAndDispatch(z: number, cx: number, cy: number): Set<string> {
    const desired = new Set<string>();
    const span = 2 * this.ringRadius + 1;
    // Hard cap on the ring iteration. With MAX_RING_RADIUS=32 this is 4225.
    const HARD_MAX = (2 * MAX_RING_RADIUS + 1) * (2 * MAX_RING_RADIUS + 1);
    let iter = 0;
    for (let dx = -this.ringRadius; dx <= this.ringRadius; dx++) {
      for (let dy = -this.ringRadius; dy <= this.ringRadius; dy++) {
        checkLoopBound(iter++, HARD_MAX, "computeDesiredAndDispatch");
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
    assert(desired.size <= span * span, "computeDesiredAndDispatch: oversize");
    return desired;
  }

  /** Evict tiles outside the (ringRadius + bufferRings) ring around cx,cy. */
  private evictOutsideRing(cx: number, cy: number): void {
    const evictRadius = this.ringRadius + this.bufferRings;
    let iter = 0;
    for (const [key, lt] of this.loaded) {
      checkLoopBound(iter++, MAX_TILES_LOADED, "evictOutsideRing");
      const ddx = Math.abs(lt.x - cx);
      const ddy = Math.abs(lt.y - cy);
      if (ddx > evictRadius || ddy > evictRadius) {
        this.evict(key);
      }
    }
  }

  /** Mark inflight tiles not in the desired set for cancellation. */
  private cancelUndesiredInflight(desired: Set<string>): void {
    let iter = 0;
    for (const k of this.inflight) {
      checkLoopBound(iter++, MAX_TILES_INFLIGHT, "cancelUndesiredInflight");
      if (!desired.has(k)) this.cancelled.add(k);
    }
  }

  private tileIntersectsBBox(z: number, x: number, y: number): boolean {
    if (!this.bbox) return true;
    assertInRange(z, 0, MAX_TILE_ZOOM, "tileIntersectsBBox: z");
    assertFinite(x, "tileIntersectsBBox: x");
    assertFinite(y, "tileIntersectsBBox: y");
    const n = Math.pow(2, z);
    // Static-size corner buffer — exactly two corners, never grows.
    const xs: [number, number] = [0, 0];
    const ys: [number, number] = [0, 0];
    const corners: ReadonlyArray<readonly [number, number]> = [
      [this.bbox.west, this.bbox.north],
      [this.bbox.east, this.bbox.south],
    ];
    for (let i = 0; i < corners.length; i++) {
      checkLoopBound(i, 2, "tileIntersectsBBox.corners");
      const c = corners[i]!;
      const t = lonLatToTile(c[0], c[1], z);
      assertFinite(t.x, "tileIntersectsBBox: t.x");
      assertFinite(t.y, "tileIntersectsBBox: t.y");
      xs[i] = t.x;
      ys[i] = t.y;
    }
    const minX = Math.floor(Math.min(xs[0], xs[1]));
    const maxX = Math.floor(Math.max(xs[0], xs[1]));
    const minY = Math.floor(Math.min(ys[0], ys[1]));
    const maxY = Math.floor(Math.max(ys[0], ys[1]));
    void n;
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  }

  private async dispatch(z: number, x: number, y: number): Promise<void> {
    assertInRange(z, 0, MAX_TILE_ZOOM, "dispatch: z");
    assertU32(x, "dispatch: x");
    assertU32(y, "dispatch: y");
    assert(this.inflight.size < MAX_TILES_INFLIGHT, "dispatch: inflight cap");
    const key = tileKey(z, x, y);
    this.inflight.add(key);
    this.opts.onProgress?.(this.loaded.size, this.inflight.size);
    try {
      let parsed = await this.opts.store.getParsed(z, x, y, this.opts.cacheVersion);
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
        // Validate worker output — these flow into geometry buffers downstream.
        assertU32(parsed.z, "dispatch: parsed.z");
        assertU32(parsed.x, "dispatch: parsed.x");
        assertU32(parsed.y, "dispatch: parsed.y");
        parsed.version = this.opts.cacheVersion;
        this.opts.store.putParsed(parsed).catch((e) =>
          console.error("TileManager.dispatch: cache put failed", { key, err: e }),
        );
      }
      if (this.cancelled.has(key)) {
        this.cancelled.delete(key);
        this.inflight.delete(key);
        return;
      }
      assert(
        this.installQueue.length < MAX_INSTALL_QUEUE,
        "dispatch: installQueue cap",
      );
      // Defer installation — drained at most INSTALLS_PER_FRAME per poll.
      this.installQueue.push(parsed);
    } catch (err) {
      // Structured log — preserves observable behaviour (swallow + continue)
      // while making failures actionable.
      console.error("TileManager.dispatch: tile fetch failed", { key, err });
    } finally {
      this.inflight.delete(key);
      this.opts.onProgress?.(this.loaded.size, this.inflight.size);
    }
  }

  private installTile(parsed: ParsedTile) {
    assert(parsed != null, "installTile: parsed required");
    assertU32(parsed.z, "installTile: parsed.z");
    assertU32(parsed.x, "installTile: parsed.x");
    assertU32(parsed.y, "installTile: parsed.y");
    assert(this.loaded.size < MAX_TILES_LOADED, "installTile: loaded cap");
    const key = tileKey(parsed.z, parsed.x, parsed.y);
    if (this.loaded.has(key)) return; // raced with another caller
    const handles: LoadedTile["handles"] = {};
    // Source-bearing layers first. Loop bound: object keys are derived from
    // worker output; in theory unbounded, in practice ≤ LayerName count.
    let i = 0;
    for (const layerName in parsed.layers) {
      checkLoopBound(i++, MAX_LAYERS_PER_TILE, "installTile.sourceLayers");
      const ln = layerName as LayerName;
      const layer = this.opts.layers[ln];
      if (!layer) continue;
      const handle = layer.load(parsed, parsed.layers[ln]!, this.ctx);
      if (handle) handles[ln] = handle;
    }
    // Derived layers — e.g. streetlights riding on the roads SoA.
    let j = 0;
    for (const ln in DERIVED_SOURCES) {
      checkLoopBound(j++, MAX_LAYERS_PER_TILE, "installTile.derivedLayers");
      const target = ln as LayerName;
      const source = DERIVED_SOURCES[target]!;
      const data = parsed.layers[source];
      const layer = this.opts.layers[target];
      if (!data || !layer) continue;
      const handle = layer.load(parsed, data, this.ctx);
      if (handle) handles[target] = handle;
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
    assert(typeof key === "string" && key.length > 0, "evict: key required");
    const lt = this.loaded.get(key);
    if (!lt) return;
    let i = 0;
    for (const ln in lt.handles) {
      checkLoopBound(i++, MAX_LAYERS_PER_TILE, "evict.handles");
      try {
        lt.handles[ln as LayerName]?.dispose();
      } catch (err) {
        // A failing dispose must not strand the tile in `loaded`; log and continue.
        console.error("TileManager.evict: handle dispose failed", { key, ln, err });
      }
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
    assert(bbox != null, "computeSceneOrigin: bbox required");
    assertInRange(bbox.west, -180, 180, "computeSceneOrigin: west");
    assertInRange(bbox.east, -180, 180, "computeSceneOrigin: east");
    assertInRange(bbox.south, -90, 90, "computeSceneOrigin: south");
    assertInRange(bbox.north, -90, 90, "computeSceneOrigin: north");
    const centerLon = (bbox.west + bbox.east) / 2;
    const centerLat = (bbox.south + bbox.north) / 2;
    const out = lonLatToMeters(centerLon, centerLat);
    assertFinite(out.x, "computeSceneOrigin: out.x");
    assertFinite(out.y, "computeSceneOrigin: out.y");
    return out;
  }

  /** Visible loaded tiles, for engine queries (debug HUD, exports). */
  get loadedKeys(): string[] {
    return Array.from(this.loaded.keys());
  }

  /** Helper for selection: find building handle for a given mesh+face. */
  getLoadedTile(key: string): LoadedTile | undefined {
    assert(typeof key === "string" && key.length > 0, "getLoadedTile: key required");
    return this.loaded.get(key);
  }

  /** Get the centre of a tile in scene-local coords (for camera anchoring). */
  tileSceneCenter(z: number, x: number, y: number): { x: number; z: number } {
    assertInRange(z, 0, MAX_TILE_ZOOM, "tileSceneCenter: z");
    assertU32(x, "tileSceneCenter: x");
    assertU32(y, "tileSceneCenter: y");
    const box = tileMetersBox(z, x, y);
    assertFinite(box.minX, "tileSceneCenter: box.minX");
    assertFinite(box.maxX, "tileSceneCenter: box.maxX");
    assertFinite(box.minY, "tileSceneCenter: box.minY");
    assertFinite(box.maxY, "tileSceneCenter: box.maxY");
    const cx = (box.minX + box.maxX) / 2 - this.opts.sceneOrigin.x;
    const cz = -((box.minY + box.maxY) / 2 - this.opts.sceneOrigin.y);
    return { x: cx, z: cz };
  }

  dispose() {
    const keys = Array.from(this.loaded.keys());
    for (let i = 0; i < keys.length; i++) {
      checkLoopBound(i, MAX_TILES_LOADED, "dispose");
      this.evict(keys[i]!);
    }
  }
}
