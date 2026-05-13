// Owns FeedSources and fans entity events to sinks. Watches a moving centre
// (scene-local metres) and re-subscribes when the centre has moved more than
// a per-kind threshold.

import { haversineKm, metersToLonLat } from "../projection/mercator";
import type { FeedBbox, FeedEntity, FeedEvent, FeedKind, FeedSource } from "./types";

export interface FeedSink {
  onUpdate(entity: FeedEntity): void;
  onRemove(id: string): void;
}

interface KindConfig {
  paddingKm: number;
  resubKm: number;
}

const CONFIG: Record<FeedKind, KindConfig> = {
  aircraft: { paddingKm: 200, resubKm: 60 },
  vessel: { paddingKm: 80, resubKm: 25 },
};

export class FeedManager {
  private sources: FeedSource[];
  private sinks: Partial<Record<FeedKind, FeedSink>> = {};
  private sceneOrigin: { x: number; y: number };
  private lastSubCentre: Partial<Record<FeedKind, { lat: number; lon: number }>> = {};
  private running = false;

  constructor(sceneOrigin: { x: number; y: number }, sources: FeedSource[]) {
    this.sceneOrigin = sceneOrigin;
    this.sources = sources;
  }

  registerSink(kind: FeedKind, sink: FeedSink) {
    this.sinks[kind] = sink;
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const src of this.sources) {
      src.start((e) => this.dispatch(src.kind, e));
    }
  }

  stop() {
    this.running = false;
    for (const src of this.sources) src.stop();
  }

  /** Called from the host loop with the camera's scene-local XZ position. */
  tickCamera(sceneX: number, sceneZ: number) {
    if (!this.running) return;
    const mx = sceneX + this.sceneOrigin.x;
    const my = -sceneZ + this.sceneOrigin.y;
    const centre = metersToLonLat(mx, my);
    this.tickCentre(centre.lat, centre.lon);
  }

  /** Variant used by non-three hosts that already know lat/lon. */
  tickCentre(lat: number, lon: number) {
    if (!this.running) return;
    for (const kind of ["aircraft", "vessel"] as FeedKind[]) {
      const cfg = CONFIG[kind];
      const prev = this.lastSubCentre[kind];
      const movedKm = prev ? haversineKm(lat, lon, prev.lat, prev.lon) : Infinity;
      if (movedKm < cfg.resubKm) continue;
      const bbox = bboxAround(lat, lon, cfg.paddingKm);
      this.lastSubCentre[kind] = { lat, lon };
      for (const src of this.sources) if (src.kind === kind) src.setRegion(bbox);
    }
  }

  status() {
    const out: Record<string, { connected: boolean; lastUpdateTs: number; reason?: string }> = {};
    for (const src of this.sources) out[src.id] = src.status();
    return out;
  }

  private dispatch(kind: FeedKind, e: FeedEvent) {
    const sink = this.sinks[kind];
    if (!sink) return;
    if (e.type === "update") sink.onUpdate(e.entity);
    else sink.onRemove(e.id);
  }
}

function bboxAround(lat: number, lon: number, padKm: number): FeedBbox {
  const dLat = padKm / 111;
  const dLon = padKm / (111 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}
