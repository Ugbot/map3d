/// <reference lib="webworker" />

// Browser-side Web Worker that fetches MVT tiles (PMTiles range reads or a
// raw {z}/{x}/{y} URL template) and hands them to the pure parseTile()
// function exported from @map3d/data-core. All decoding logic lives in
// data-core so the Node data-server can call the same parser.

import { PMTiles } from "pmtiles";
import {
  assert,
  assertU32,
  assertFinite,
  assertInRange,
  parseTile,
  bakeRibbonMesh,
  approximateByteSize,
  type RibbonConfig,
  type LayerName,
  type BakedLineMesh,
  type ParsedTile,
  type SchemaName,
  type WorkerRequest,
  type WorkerResponse,
} from "@map3d/data-core";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const MAX_TILE_BYTES = 64 * 1024 * 1024;
const MAX_TILE_ZOOM = 24;

// ────────────────────────────────────────────────────────────────────────────
// Tile sources
// ────────────────────────────────────────────────────────────────────────────
interface TileSource {
  kind: "pmtiles" | "raw";
  getTile(z: number, x: number, y: number): Promise<ArrayBuffer | undefined>;
}

class PMTilesSource implements TileSource {
  readonly kind = "pmtiles" as const;
  private p: PMTiles;
  constructor(url: string) {
    this.p = new PMTiles(url);
  }
  async getTile(z: number, x: number, y: number) {
    const r = await this.p.getZxy(z, x, y);
    return r?.data;
  }
}

class MVTSource implements TileSource {
  readonly kind = "raw" as const;
  constructor(private readonly urlTemplate: string) {}
  async getTile(z: number, x: number, y: number) {
    const url = this.urlTemplate
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) return undefined;
      throw new Error(`tile fetch ${res.status} for ${z}/${x}/${y}`);
    }
    return res.arrayBuffer();
  }
}

let source: TileSource | null = null;
let schema: SchemaName = "openmaptiles";
let cacheVersion = 0;
let sceneOrigin: { x: number; y: number } | null = null;
let ribbonConfigs: Partial<Record<LayerName, RibbonConfig>> = {};

interface InitPayload {
  source: { kind: "pmtiles"; url: string } | { kind: "mvt"; urlTemplate: string };
  schema: SchemaName;
  cacheVersion: number;
  sceneOrigin?: { x: number; y: number };
  ribbonConfigs?: Partial<Record<LayerName, RibbonConfig>>;
}

function bakeAndAttach(parsed: ParsedTile): void {
  if (!sceneOrigin) return;
  const baked: Partial<Record<LayerName, BakedLineMesh>> = {};
  let any = false;
  for (const ln in ribbonConfigs) {
    const cfg = ribbonConfigs[ln as LayerName];
    const g = parsed.layers[ln as LayerName];
    if (!cfg || !g || g.kind !== "line") continue;
    const m = bakeRibbonMesh(g, sceneOrigin, cfg);
    if (m) {
      baked[ln as LayerName] = m;
      any = true;
    }
  }
  if (any) {
    parsed.bakedLines = baked;
    // Re-account: baked buffers add real bytes; budget tracking matters.
    parsed.byteSize = approximateByteSize(parsed);
  }
}

function transferablesOf(t: ParsedTile): Transferable[] {
  const out: Transferable[] = [];
  for (const k in t.layers) {
    const g = t.layers[k as LayerName]!;
    out.push(g.positions.buffer);
    if (g.indices) out.push(g.indices.buffer);
    out.push(g.featureStart.buffer);
    out.push(g.featureIds.buffer);
    out.push(g.featureClass.buffer);
    out.push(g.featureHeight.buffer);
    out.push(g.featureMinHeight.buffer);
  }
  if (t.bakedLines) {
    for (const k in t.bakedLines) {
      const m = t.bakedLines[k as LayerName];
      if (!m) continue;
      out.push(m.positions.buffer);
      out.push(m.indices.buffer);
      if (m.uvs) out.push(m.uvs.buffer);
      out.push(m.featureRanges.buffer);
      out.push(m.featureIds.buffer);
    }
  }
  return out;
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  // Tiger Style: validate every field on the message handler entry. The
  // payload is bytes from another realm; treat it as untrusted.
  assert(e.data !== null && typeof e.data === "object", "msg envelope");
  const { id, type, payload } = e.data;
  assertU32(id, "msg id");
  assert(typeof type === "string" && type.length > 0, "msg type string");
  try {
    if (type === "init") {
      assert(payload !== null && typeof payload === "object", "init payload");
      const p = payload as InitPayload;
      assert(
        p.source.kind === "pmtiles" || p.source.kind === "mvt",
        "init.source.kind",
      );
      source =
        p.source.kind === "pmtiles"
          ? new PMTilesSource(p.source.url)
          : new MVTSource(p.source.urlTemplate);
      assert(
        p.schema === "openmaptiles" || p.schema === "protomaps-v4",
        "init.schema",
      );
      schema = p.schema;
      assertU32(p.cacheVersion, "init.cacheVersion");
      cacheVersion = p.cacheVersion;
      if (p.sceneOrigin) {
        assertFinite(p.sceneOrigin.x, "sceneOrigin.x");
        assertFinite(p.sceneOrigin.y, "sceneOrigin.y");
        sceneOrigin = p.sceneOrigin;
      }
      if (p.ribbonConfigs) ribbonConfigs = p.ribbonConfigs;
      reply(id, true, { ok: true });
    } else if (type === "fetchTile") {
      if (!source) throw new Error("worker not initialised");
      assert(payload !== null && typeof payload === "object", "fetchTile payload");
      const { z, x, y } = payload as { z: number; x: number; y: number };
      assertU32(z, "fetchTile.z");
      assertU32(x, "fetchTile.x");
      assertU32(y, "fetchTile.y");
      assertInRange(z, 0, MAX_TILE_ZOOM, "fetchTile.z range");
      const axis = 1 << z;
      assertInRange(x, 0, axis - 1, "fetchTile.x range");
      assertInRange(y, 0, axis - 1, "fetchTile.y range");
      const bytes = await source.getTile(z, x, y);
      if (!bytes) {
        reply(id, true, { missing: true, z, x, y });
        return;
      }
      assert(bytes.byteLength > 0, "fetched tile bytes");
      assert(bytes.byteLength <= MAX_TILE_BYTES, "fetched tile bytes cap");
      const parsed = parseTile({
        z,
        x,
        y,
        bytes,
        version: cacheVersion,
        schema,
        sourceKind: source.kind,
      });
      bakeAndAttach(parsed);
      reply(id, true, { tile: parsed, missing: false }, transferablesOf(parsed));
    } else {
      throw new Error(`unknown message: ${type}`);
    }
  } catch (err) {
    // Surface, never swallow. The pool rejects the matching pending RPC.
    reply(id, false, undefined, [], err instanceof Error ? err.message : String(err));
  }
};

function reply(
  id: number,
  ok: boolean,
  result?: unknown,
  transfer: Transferable[] = [],
  error?: string,
) {
  const msg: WorkerResponse = { id, ok, result, error };
  ctx.postMessage(msg, transfer);
}
