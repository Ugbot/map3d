// Owns the FeedSources and fans entity events to the matching engine layer.
// Watches camera position (in scene-local metres) and re-subscribes when the
// region centre has moved more than a threshold.

import { metersToLonLat } from "../projection/mercator";
import { OpenSkyFeed } from "./openSkyFeed";
import { AISStreamFeed } from "./aisStreamFeed";
import type { FeedBbox, FeedEntity, FeedEvent, FeedKind, FeedSource } from "./types";

export interface FeedSink {
  onUpdate(entity: FeedEntity): void;
  onRemove(id: string): void;
}

interface KindConfig {
  paddingKm: number;
  /** Don't resubscribe unless the camera centre has moved this far. */
  resubKm: number;
}

const CONFIG: Record<FeedKind, KindConfig> = {
  // Wider bbox so sparse-traffic regions (Abu Dhabi at off-hours, etc.) still
  // pick up some aircraft. 200 km pad = 400 km × 400 km region.
  aircraft: { paddingKm: 200, resubKm: 60 },
  vessel: { paddingKm: 80, resubKm: 25 },
};

export class FeedManager {
  private sources: FeedSource[];
  private sinks: Partial<Record<FeedKind, FeedSink>> = {};
  private sceneOrigin: { x: number; y: number };
  private lastSubCentre: Partial<Record<FeedKind, { lat: number; lon: number }>> = {};
  private running = false;

  constructor(sceneOrigin: { x: number; y: number }) {
    this.sceneOrigin = sceneOrigin;
    this.sources = [new OpenSkyFeed(), new AISStreamFeed()];
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

  /** Called from the engine loop with the camera's scene-local XZ position. */
  tickCamera(sceneX: number, sceneZ: number) {
    if (!this.running) return;
    // Convert scene XZ → mercator metres → lonLat.
    const mx = sceneX + this.sceneOrigin.x;
    const my = -sceneZ + this.sceneOrigin.y;
    const centre = metersToLonLat(mx, my);
    for (const kind of ["aircraft", "vessel"] as FeedKind[]) {
      const cfg = CONFIG[kind];
      const prev = this.lastSubCentre[kind];
      const movedKm = prev ? haversineKm(centre.lat, centre.lon, prev.lat, prev.lon) : Infinity;
      if (movedKm < cfg.resubKm) continue;
      const bbox = bboxAround(centre.lat, centre.lon, cfg.paddingKm);
      this.lastSubCentre[kind] = { lat: centre.lat, lon: centre.lon };
      for (const src of this.sources) if (src.kind === kind) src.setRegion(bbox);
    }
  }

  /** Diagnostic — for DebugHUD. */
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

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
