// IndexedDB-backed TileStore.
//
// Two object stores:
//   raw     — original MVT pbf bytes (for re-parsing if the schema changes)
//   parsed  — fully unpacked ParsedTile (typed arrays survive structured clone)
//
// LRU eviction by total byteSize. Eviction is cheap because each row carries
// its own size; we just sort by lastAccess asc and drop until under budget.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ParsedTile, RawTile, TileStore } from "./types";

const DB_NAME = "map3d-tiles";
const DB_VERSION = 1;
const RAW_STORE = "raw";
const PARSED_STORE = "parsed";

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

function k(z: number, x: number, y: number, version: number) {
  return `${version}/${z}/${x}/${y}`;
}

export function makeVersion(providerId: string, schema: string, schemaRev = 2): number {
  // Hash provider+schema into a stable u32 so swapping providers keys to a
  // different cache namespace. schemaRev bumps when our parser changes.
  let h = 5381;
  const s = `${providerId}|${schema}|${schemaRev}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
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

export class IDBTileStore implements TileStore {
  constructor(private readonly byteBudget = 256 * 1024 * 1024) {}

  async getRaw(z: number, x: number, y: number, version: number): Promise<RawTile | undefined> {
    const d = await db();
    const key = k(z, x, y, version);
    const row = await d.get(RAW_STORE, key);
    if (!row) return undefined;
    // Touch lastAccess in a separate, non-blocking write.
    d.put(RAW_STORE, { ...row, lastAccess: Date.now() }).catch(() => {});
    return row.tile;
  }

  async putRaw(tile: RawTile): Promise<void> {
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
    const d = await db();
    const key = k(z, x, y, version);
    const row = await d.get(PARSED_STORE, key);
    if (!row) return undefined;
    d.put(PARSED_STORE, { ...row, lastAccess: Date.now() }).catch(() => {});
    return row.tile;
  }

  async putParsed(tile: ParsedTile): Promise<void> {
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
    const d = await db();
    for (const store of [PARSED_STORE, RAW_STORE] as const) {
      let total = 0;
      const rows: { key: string; byteSize: number; lastAccess: number }[] = [];
      const tx = d.transaction(store, "readonly");
      let cursor = await tx.store.openCursor();
      while (cursor) {
        const v = cursor.value;
        total += v.byteSize;
        rows.push({ key: v.key, byteSize: v.byteSize, lastAccess: v.lastAccess });
        cursor = await cursor.continue();
      }
      if (total <= byteBudget) continue;
      rows.sort((a, b) => a.lastAccess - b.lastAccess);
      const wtx = d.transaction(store, "readwrite");
      for (const r of rows) {
        if (total <= byteBudget) break;
        await wtx.store.delete(r.key);
        total -= r.byteSize;
      }
      await wtx.done;
    }
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
