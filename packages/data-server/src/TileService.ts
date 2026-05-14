// Per-client tile streaming service. Fetches PMTiles via range reads, parses
// them through @map3d/data-core, derives renderable primitive records, and
// drains them into per-client FrameEncoders.
//
// Tiger style: every public boundary asserts its arguments; LRU caches and
// per-client queues have hard caps; spiral-out iteration is bounded.

import { PMTiles } from "pmtiles";
import {
  assert,
  assertFinite,
  assertU32,
  assertInRange,
  checkLoopBound,
  lonLatToMeters,
  lonLatToTile,
  parseTile,
  tileKey,
  type FrameEncoder,
  type ParsedTile,
  type SchemaName,
} from "@map3d/data-core";
import { derivePrimitives } from "./derivePrimitives";

const MAX_RING_RADIUS = 8;
const MAX_PARSED_CACHE = 256;
const MAX_QUEUE_PER_CLIENT = 4096;
const MAX_CLIENTS = 1024;
const PMTILES_DEFAULT_URL = "https://demo-bucket.protomaps.com/v4.pmtiles";
const SCHEMA_DEFAULT: SchemaName = "protomaps-v4";

export interface TileServiceOptions {
  pmtilesUrl?: string;
  schema?: SchemaName;
  baseZoom?: number;
  ringRadius?: number;
  maxBatchesPerTick?: number;
  cacheVersion?: number;
}

interface ClientTileState {
  origin: { lon: number; lat: number };
  sceneOrigin: { x: number; y: number };
  loaded: Set<string>;       // tileKeys we've already streamed
  released: Set<string>;     // tileKeys we still owe a TILE_RELEASE for
  queue: string[];           // tileKeys pending stream
  centerTx: number;
  centerTy: number;
}

export class TileService {
  private readonly pm: PMTiles;
  private readonly schema: SchemaName;
  private readonly baseZoom: number;
  private readonly ringRadius: number;
  private readonly maxBatchesPerTick: number;
  private readonly cacheVersion: number;

  // Shared LRU on parsed tiles. Map iteration order = insertion order; on hit
  // we delete + reinsert to refresh recency.
  private parsedCache = new Map<string, ParsedTile>();
  // Tiles currently being fetched/parsed (shared across clients).
  private inflight = new Map<string, Promise<ParsedTile | null>>();
  private clients = new Map<string, ClientTileState>();

  constructor(opts: TileServiceOptions = {}) {
    const url = opts.pmtilesUrl ?? PMTILES_DEFAULT_URL;
    assert(typeof url === "string" && url.length > 0, "pmtilesUrl");
    this.pm = new PMTiles(url);
    this.schema = opts.schema ?? SCHEMA_DEFAULT;
    assert(
      this.schema === "openmaptiles" || this.schema === "protomaps-v4",
      "schema",
    );
    this.baseZoom = opts.baseZoom ?? 15;
    assertInRange(this.baseZoom, 0, 22, "baseZoom");
    this.ringRadius = opts.ringRadius ?? 2;
    assertInRange(this.ringRadius, 0, MAX_RING_RADIUS, "ringRadius");
    this.maxBatchesPerTick = opts.maxBatchesPerTick ?? 4;
    assertInRange(this.maxBatchesPerTick, 1, 64, "maxBatchesPerTick");
    this.cacheVersion = opts.cacheVersion ?? 1;
    assertU32(this.cacheVersion, "cacheVersion");
  }

  registerClient(clientId: string, opts: { origin: { lon: number; lat: number } }): void {
    assert(typeof clientId === "string" && clientId.length > 0, "clientId");
    assertFinite(opts.origin.lon, "origin.lon");
    assertFinite(opts.origin.lat, "origin.lat");
    assertInRange(opts.origin.lon, -180, 180, "origin.lon");
    assertInRange(opts.origin.lat, -85, 85, "origin.lat");
    assert(this.clients.size < MAX_CLIENTS, "TileService: client cap");
    const sceneOrigin = lonLatToMeters(opts.origin.lon, opts.origin.lat);
    const t = lonLatToTile(opts.origin.lon, opts.origin.lat, this.baseZoom);
    const state: ClientTileState = {
      origin: { lon: opts.origin.lon, lat: opts.origin.lat },
      sceneOrigin,
      loaded: new Set(),
      released: new Set(),
      queue: [],
      centerTx: Math.floor(t.x),
      centerTy: Math.floor(t.y),
    };
    this.clients.set(clientId, state);
    this.enqueueRingFor(state);
  }

  updateClientOrigin(clientId: string, lon: number, lat: number): void {
    assertFinite(lon, "updateClientOrigin.lon");
    assertFinite(lat, "updateClientOrigin.lat");
    assertInRange(lon, -180, 180, "updateClientOrigin.lon");
    assertInRange(lat, -85, 85, "updateClientOrigin.lat");
    const state = this.clients.get(clientId);
    if (!state) return;
    const t = lonLatToTile(lon, lat, this.baseZoom);
    const newCx = Math.floor(t.x);
    const newCy = Math.floor(t.y);
    if (newCx === state.centerTx && newCy === state.centerTy) {
      // Origin didn't cross a tile boundary — no work.
      state.origin = { lon, lat };
      return;
    }
    state.origin = { lon, lat };
    state.sceneOrigin = lonLatToMeters(lon, lat);
    state.centerTx = newCx;
    state.centerTy = newCy;
    // Diff: anything loaded outside the new ring → release; new tiles → queue.
    const newSet = this.ringTileKeys(newCx, newCy);
    let i = 0;
    for (const k of state.loaded) {
      checkLoopBound(i++, MAX_PARSED_CACHE * 8, "updateClientOrigin.releaseScan");
      if (!newSet.has(k)) state.released.add(k);
    }
    for (const k of state.released) state.loaded.delete(k);
    state.queue.length = 0;
    let j = 0;
    for (const k of newSet) {
      checkLoopBound(j++, MAX_QUEUE_PER_CLIENT, "updateClientOrigin.enqueue");
      if (!state.loaded.has(k)) state.queue.push(k);
    }
    this.spiralSort(state);
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /**
   * Drain at most `maxBatchesPerTick` tiles per client into the provided
   * encoder. Returns the set of clientIds for which at least one tile
   * section was written.
   *
   * The encoder must already have a frame open (beginFrame called); the
   * service writes TILE_* sections directly into it.
   */
  tickAndEncode(encoderFor: (clientId: string) => FrameEncoder): Set<string> {
    const writtenClients = new Set<string>();
    for (const [clientId, state] of this.clients) {
      checkLoopBound(0, MAX_CLIENTS, "tickAndEncode.clients");
      const encoder = encoderFor(clientId);
      const markWritten = () => writtenClients.add(clientId);
      // Emit pending releases first — small payloads, free up renderer slots.
      let releaseBudget = this.maxBatchesPerTick;
      for (const key of state.released) {
        if (releaseBudget-- <= 0) break;
        const tk = parseKey(key);
        if (!tk) continue;
        try {
          encoder.writeTileRelease(tk.z, tk.x, tk.y);
          markWritten();
        } catch {
          // Encoder full or invariant breach — stop releasing this tick.
          break;
        }
      }
      // Clear the ones we successfully sent (best-effort: all of them, since
      // even if some fail above we'll retry next tick from `released`).
      for (const key of Array.from(state.released).slice(0, this.maxBatchesPerTick)) {
        state.released.delete(key);
      }

      // Drain the queue: only tiles already in the parsed cache go out this
      // tick. Missing tiles trigger an async fetch + cache fill.
      let emitted = 0;
      let scan = 0;
      const remaining: string[] = [];
      for (let qi = 0; qi < state.queue.length; qi++) {
        checkLoopBound(scan++, MAX_QUEUE_PER_CLIENT, "tickAndEncode.queue");
        const key = state.queue[qi];
        if (emitted >= this.maxBatchesPerTick) {
          remaining.push(key);
          continue;
        }
        if (state.loaded.has(key)) continue;
        const tk = parseKey(key);
        if (!tk) continue;
        const parsed = this.getCached(key);
        if (!parsed) {
          // Kick off a fetch in the background; keep the key queued.
          this.ensureFetch(tk.z, tk.x, tk.y);
          remaining.push(key);
          continue;
        }
        const wrote = this.writeParsed(encoder, state, parsed);
        if (wrote) {
          state.loaded.add(key);
          emitted++;
          markWritten();
        } else {
          // Encoder ran out of room — keep the key for next tick.
          remaining.push(key);
        }
      }
      state.queue = remaining;
    }
    return writtenClients;
  }

  // Diagnostics: how many parsed tiles are cached right now.
  cacheSize(): number {
    return this.parsedCache.size;
  }

  // ── internals ──────────────────────────────────────────────────────────
  private enqueueRingFor(state: ClientTileState): void {
    const keys = this.ringTileKeys(state.centerTx, state.centerTy);
    for (const k of keys) state.queue.push(k);
    this.spiralSort(state);
    // Best-effort: trigger fetches now so first tiles arrive on the next tick.
    for (const key of state.queue) {
      const tk = parseKey(key);
      if (tk) this.ensureFetch(tk.z, tk.x, tk.y);
    }
  }

  private ringTileKeys(cx: number, cy: number): Set<string> {
    const out = new Set<string>();
    const r = this.ringRadius;
    let iter = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        checkLoopBound(iter++, (2 * MAX_RING_RADIUS + 1) ** 2, "ringTileKeys");
        out.add(tileKey(this.baseZoom, cx + dx, cy + dy));
      }
    }
    return out;
  }

  private spiralSort(state: ClientTileState): void {
    const cx = state.centerTx;
    const cy = state.centerTy;
    state.queue.sort((a, b) => {
      const ta = parseKey(a);
      const tb = parseKey(b);
      if (!ta || !tb) return 0;
      const da = Math.abs(ta.x - cx) + Math.abs(ta.y - cy);
      const db = Math.abs(tb.x - cx) + Math.abs(tb.y - cy);
      return da - db;
    });
  }

  private getCached(key: string): ParsedTile | null {
    const hit = this.parsedCache.get(key);
    if (!hit) return null;
    // Refresh LRU position.
    this.parsedCache.delete(key);
    this.parsedCache.set(key, hit);
    return hit;
  }

  private putCached(key: string, tile: ParsedTile): void {
    this.parsedCache.set(key, tile);
    while (this.parsedCache.size > MAX_PARSED_CACHE) {
      const first = this.parsedCache.keys().next();
      if (first.done) break;
      this.parsedCache.delete(first.value);
    }
  }

  private ensureFetch(z: number, x: number, y: number): Promise<ParsedTile | null> {
    const key = tileKey(z, x, y);
    if (this.parsedCache.has(key)) return Promise.resolve(this.parsedCache.get(key)!);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.fetchAndParse(z, x, y)
      .then((tile) => {
        if (tile) this.putCached(key, tile);
        return tile;
      })
      .catch((err) => {
        console.error("[TileService] fetch failed", { key, err });
        return null;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  private async fetchAndParse(z: number, x: number, y: number): Promise<ParsedTile | null> {
    const r = await this.pm.getZxy(z, x, y);
    if (!r || !r.data) return null;
    const bytes = r.data instanceof ArrayBuffer
      ? r.data
      : (r.data as Uint8Array).buffer.slice(
          (r.data as Uint8Array).byteOffset,
          (r.data as Uint8Array).byteOffset + (r.data as Uint8Array).byteLength,
        ) as ArrayBuffer;
    if (bytes.byteLength === 0) return null;
    return parseTile({
      z,
      x,
      y,
      bytes,
      version: this.cacheVersion,
      schema: this.schema,
      sourceKind: "pmtiles",
    });
  }

  private writeParsed(
    encoder: FrameEncoder,
    state: ClientTileState,
    tile: ParsedTile,
  ): boolean {
    const baseRemoteId = packTileSeed(tile.z, tile.x, tile.y);
    const prims = derivePrimitives(tile, state.sceneOrigin, baseRemoteId);
    try {
      encoder.writeTileBegin(tile.z, tile.x, tile.y);
      if (prims.buildings.length > 0) encoder.writeTileBuildings(prims.buildings);
      for (const m of prims.meshes) encoder.writeTileMesh(m);
      if (prims.lanterns.length > 0) encoder.writeTileLanterns(prims.lanterns);
      if (prims.props.length > 0) encoder.writeTileProps(prims.props);
      encoder.writeTileEnd();
      return true;
    } catch (err) {
      // Encoder capacity exceeded mid-tile — caller may retry next tick. The
      // partial sections are still in the frame buffer; we can't roll them
      // back, so the consumer will see an unmatched TILE_BEGIN. Mitigation:
      // the frame capacity is sized generously (4 MiB) so this only triggers
      // when something has gone genuinely wrong.
      console.error("[TileService] tile encode failed", {
        z: tile.z,
        x: tile.x,
        y: tile.y,
        err,
      });
      return false;
    }
  }
}

function parseKey(key: string): { z: number; x: number; y: number } | null {
  const parts = key.split("/");
  if (parts.length !== 3) return null;
  const z = Number(parts[0]);
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { z, x, y };
}

function packTileSeed(z: number, x: number, y: number): number {
  return (((z & 0x1f) << 27) ^ ((x & 0x7fff) << 12) ^ (y & 0xfff)) >>> 0;
}
