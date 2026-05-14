// IndexedDB-backed TileStore.
//
// Two object stores:
//   raw     — original MVT pbf bytes (for re-parsing if the schema changes)
//   parsed  — fully unpacked ParsedTile (typed arrays survive structured clone)
//
// LRU eviction by total byteSize. Eviction is cheap because each row carries
// its own size; we just sort by lastAccess asc and drop until under budget.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  assert,
  assertU32,
  assertFinite,
  assertInRange,
  checkLoopBound,
} from "../util/assert";
import type { ParsedTile, RawTile, TileStore } from "./types";

const DB_NAME = "map3d-tiles";
const DB_VERSION = 1;
const RAW_STORE = "raw";
const PARSED_STORE = "parsed";

// Static caps. These bound what we will ever pull out of IndexedDB so a
// corrupt or runaway store can't OOM the renderer.
//
// MAX_ROWS_PER_STORE: hard cap on rows scanned by evictTo. At ~1 MiB/tile and
//   our default 256 MiB budget the working set tops out near 256 rows, so 1M
//   is ~four orders of magnitude of headroom before we treat it as a bug.
// MAX_BYTE_BUDGET: hard cap on the configurable LRU budget. 16 GiB is well
//   beyond any browser's persistent-storage grant; anything larger is a typo.
// MAX_TILE_BYTES: per-row size sanity. Anything larger than 256 MiB in a
//   single tile is a parser bug, not legitimate data.
// MAX_ZOOM: tile coordinates are u32 but the meaningful Web Mercator range is
//   0..30; we guard against accidental sentinel values like 1e9.
const MAX_ROWS_PER_STORE = 1_000_000;
const MAX_BYTE_BUDGET = 16 * 1024 * 1024 * 1024;
const MAX_TILE_BYTES = 256 * 1024 * 1024;
const MAX_ZOOM = 30;

interface Schema extends DBSchema {
  [RAW_STORE]: {
    key: string;
    value: {
      key: string;
      tile: RawTile;
      byteSize: number;
      lastAccess: number;
    };
    indexes: { lastAccess: number };
  };
  [PARSED_STORE]: {
    key: string;
    value: {
      key: string;
      tile: ParsedTile;
      byteSize: number;
      lastAccess: number;
    };
    indexes: { lastAccess: number };
  };
}

function assertTileCoord(z: number, x: number, y: number, version: number): void {
  assertU32(z, "tileCache: z");
  assertU32(x, "tileCache: x");
  assertU32(y, "tileCache: y");
  assertU32(version, "tileCache: version");
  assertInRange(z, 0, MAX_ZOOM, "tileCache: z range");
  // At zoom z there are 2^z tiles per axis. Guard the implied bound.
  const axis = z >= 31 ? 0xffffffff : (1 << z) >>> 0;
  assert(x < axis, `tileCache: x ${x} >= 2^z ${axis}`);
  assert(y < axis, `tileCache: y ${y} >= 2^z ${axis}`);
}

function k(z: number, x: number, y: number, version: number) {
  return `${version}/${z}/${x}/${y}`;
}

export function makeVersion(providerId: string, schema: string, schemaRev = 2): number {
  assert(typeof providerId === "string", "makeVersion: providerId not string");
  assert(typeof schema === "string", "makeVersion: schema not string");
  assertU32(schemaRev, "makeVersion: schemaRev");
  // Hash provider+schema into a stable u32 so swapping providers keys to a
  // different cache namespace. schemaRev bumps when our parser changes.
  let h = 5381;
  const s = `${providerId}|${schema}|${schemaRev}`;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    checkLoopBound(i, n + 1, "makeVersion: hash loop");
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  assertU32(h, "makeVersion: output");
  return h;
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(d) {
        const raw = d.createObjectStore(RAW_STORE, { keyPath: "key" });
        raw.createIndex("lastAccess", "lastAccess");
        const parsed = d.createObjectStore(PARSED_STORE, { keyPath: "key" });
        parsed.createIndex("lastAccess", "lastAccess");
      },
    });
  }
  return dbPromise;
}

// Best-effort lastAccess refresh. Failure here is non-fatal (a future read
// will simply see a stale timestamp and the row will evict slightly earlier
// than ideal) but we still surface it for diagnostics rather than swallowing.
function touch(
  d: IDBPDatabase<Schema>,
  store: typeof RAW_STORE | typeof PARSED_STORE,
  row: Schema[typeof store]["value"],
): void {
  // The idb typings narrow `put` per-store; routing through a helper keeps
  // both call sites identical and the failure-handling consistent.
  const next = { ...row, lastAccess: Date.now() };
  const p =
    store === RAW_STORE
      ? d.put(RAW_STORE, next as Schema[typeof RAW_STORE]["value"])
      : d.put(PARSED_STORE, next as Schema[typeof PARSED_STORE]["value"]);
  p.catch((err: unknown) => {
    // Diagnostic only — eviction guarantees we still bound memory.
    console.warn("[tileCache] touch failed", { store, key: row.key, err });
  });
}

export class IDBTileStore implements TileStore {
  private readonly byteBudget: number;

  constructor(byteBudget = 256 * 1024 * 1024) {
    assertFinite(byteBudget, "IDBTileStore: byteBudget");
    assertInRange(byteBudget, 1024, MAX_BYTE_BUDGET, "IDBTileStore: byteBudget range");
    this.byteBudget = byteBudget;
  }

  async getRaw(z: number, x: number, y: number, version: number): Promise<RawTile | undefined> {
    assertTileCoord(z, x, y, version);
    const d = await db();
    const key = k(z, x, y, version);
    const row = await d.get(RAW_STORE, key);
    if (!row) return undefined;
    touch(d, RAW_STORE, row);
    return row.tile;
  }

  async putRaw(tile: RawTile): Promise<void> {
    assert(tile != null, "putRaw: tile null");
    assertTileCoord(tile.z, tile.x, tile.y, tile.version);
    assert(tile.bytes instanceof ArrayBuffer, "putRaw: bytes not ArrayBuffer");
    assertInRange(tile.bytes.byteLength, 0, MAX_TILE_BYTES, "putRaw: bytes too large");
    const d = await db();
    const key = k(tile.z, tile.x, tile.y, tile.version);
    await d.put(RAW_STORE, {
      key,
      tile,
      byteSize: tile.bytes.byteLength,
      lastAccess: Date.now(),
    });
  }

  async getParsed(
    z: number,
    x: number,
    y: number,
    version: number,
  ): Promise<ParsedTile | undefined> {
    assertTileCoord(z, x, y, version);
    const d = await db();
    const key = k(z, x, y, version);
    const row = await d.get(PARSED_STORE, key);
    if (!row) return undefined;
    touch(d, PARSED_STORE, row);
    return row.tile;
  }

  async putParsed(tile: ParsedTile): Promise<void> {
    assert(tile != null, "putParsed: tile null");
    assertTileCoord(tile.z, tile.x, tile.y, tile.version);
    assertFinite(tile.byteSize, "putParsed: byteSize");
    assertInRange(tile.byteSize, 0, MAX_TILE_BYTES, "putParsed: byteSize range");
    const d = await db();
    const key = k(tile.z, tile.x, tile.y, tile.version);
    await d.put(PARSED_STORE, {
      key,
      tile,
      byteSize: tile.byteSize,
      lastAccess: Date.now(),
    });
  }

  async evictTo(byteBudget = this.byteBudget): Promise<void> {
    assertFinite(byteBudget, "evictTo: byteBudget");
    assertInRange(byteBudget, 0, MAX_BYTE_BUDGET, "evictTo: byteBudget range");
    const d = await db();
    for (const store of [PARSED_STORE, RAW_STORE] as const) {
      await this.evictStoreTo(d, store, byteBudget);
    }
  }

  // Single-store eviction pass. Split out so evictTo stays small and so the
  // bounded-loop guards live next to the loops they protect.
  private async evictStoreTo(
    d: IDBPDatabase<Schema>,
    store: typeof RAW_STORE | typeof PARSED_STORE,
    byteBudget: number,
  ): Promise<void> {
    let total = 0;
    const rows: { key: string; byteSize: number; lastAccess: number }[] = [];
    const tx = d.transaction(store, "readonly");
    let cursor = await tx.store.openCursor();
    let scanned = 0;
    while (cursor) {
      checkLoopBound(scanned, MAX_ROWS_PER_STORE, `evictTo: ${store} scan`);
      const v = cursor.value;
      assertFinite(v.byteSize, "evictTo: row byteSize");
      assertFinite(v.lastAccess, "evictTo: row lastAccess");
      total += v.byteSize;
      rows.push({ key: v.key, byteSize: v.byteSize, lastAccess: v.lastAccess });
      cursor = await cursor.continue();
      scanned++;
    }
    if (total <= byteBudget) return;
    rows.sort((a, b) => a.lastAccess - b.lastAccess);
    const wtx = d.transaction(store, "readwrite");
    const maxDrops = rows.length;
    for (let i = 0; i < maxDrops; i++) {
      checkLoopBound(i, MAX_ROWS_PER_STORE, `evictTo: ${store} drop`);
      if (total <= byteBudget) break;
      const r = rows[i];
      await wtx.store.delete(r.key);
      total -= r.byteSize;
    }
    await wtx.done;
    assert(total >= 0, "evictTo: total went negative");
  }

  async clear(): Promise<void> {
    const d = await db();
    await d.clear(RAW_STORE);
    await d.clear(PARSED_STORE);
  }
}

// Singleton with sensible default.
let _instance: IDBTileStore | null = null;
export function tileCache(): IDBTileStore {
  if (!_instance) _instance = new IDBTileStore();
  return _instance;
}
