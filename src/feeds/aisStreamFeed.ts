// AISStream.io WebSocket feed for vessels.
//
// Endpoint: wss://stream.aisstream.io/v0/stream
// Requires a free API key (https://aisstream.io). Read from:
//   localStorage["map3d.aisstream_key"]  -or-  import.meta.env.VITE_AISSTREAM_KEY
// If neither is set, the feed is a quiet no-op (logs once).
//
// Protocol (we use):
//   client -> { APIKey, BoundingBoxes: [[[minLat,minLon],[maxLat,maxLon]]],
//               FilterMessageTypes: ["PositionReport","ShipStaticData"] }
//   server -> JSON messages, one per line; MessageType key tells us which.

import type { FeedBbox, FeedEntity, FeedEvent, FeedSource } from "./types";

const URL = "wss://stream.aisstream.io/v0/stream";

interface PositionReportMsg {
  MessageType: "PositionReport";
  MetaData: { MMSI: number; ShipName?: string; latitude: number; longitude: number; time_utc: string };
  Message: {
    PositionReport: {
      UserID: number;
      Latitude: number;
      Longitude: number;
      Cog: number; // course over ground
      Sog: number; // speed over ground (knots)
      TrueHeading: number;
      NavigationalStatus: number;
    };
  };
}
interface ShipStaticMsg {
  MessageType: "ShipStaticData";
  MetaData: { MMSI: number; ShipName?: string };
  Message: { ShipStaticData: { Type: number; Name: string } };
}

function readKey(): string | null {
  try {
    if (typeof localStorage !== "undefined") {
      const k = localStorage.getItem("map3d.aisstream_key");
      if (k) return k;
    }
  } catch {
    // ignore
  }
  const env = (import.meta as unknown as { env: Record<string, string> }).env;
  return env?.VITE_AISSTREAM_KEY ?? null;
}

export class AISStreamFeed implements FeedSource {
  readonly id = "aisstream";
  readonly kind = "vessel" as const;
  private ws: WebSocket | null = null;
  private bbox: FeedBbox | null = null;
  private onEvent: ((e: FeedEvent) => void) | null = null;
  private knownIds = new Set<string>();
  private shipTypes = new Map<string, number>();
  private lastUpdateTs = 0;
  private connected = false;
  private lastReason: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private apiKey: string | null = null;
  private warnedAboutKey = false;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  setRegion(bbox: FeedBbox): void {
    this.bbox = bbox;
    // Re-send subscription with the new box.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.sendSubscribe();
  }

  start(onEvent: (e: FeedEvent) => void): void {
    this.onEvent = onEvent;
    this.apiKey = readKey();
    if (!this.apiKey) {
      if (!this.warnedAboutKey) {
        console.info(
          "[AISStreamFeed] No API key — vessels disabled. Set localStorage.map3d.aisstream_key.",
        );
        this.warnedAboutKey = true;
      }
      this.lastReason = "no-key";
      return;
    }
    this.connect();
    // Periodically remove entities that haven't updated in a while; AISStream
    // is push-only, no inherent "out of region" message.
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = setInterval(() => this.prune(), 30_000);
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.onEvent = null;
  }

  status() {
    return { connected: this.connected, lastUpdateTs: this.lastUpdateTs, reason: this.lastReason };
  }

  private connect() {
    if (!this.apiKey) return;
    try {
      this.ws = new WebSocket(URL);
    } catch (err) {
      this.lastReason = (err as Error).message;
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.lastReason = undefined;
      this.sendSubscribe();
    };
    this.ws.onmessage = (ev) => this.onMessage(ev.data);
    this.ws.onerror = () => {
      this.lastReason = "ws error";
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.onEvent) this.connect();
    }, 5000);
  }

  private sendSubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.apiKey || !this.bbox) return;
    const msg = {
      APIKey: this.apiKey,
      BoundingBoxes: [
        [
          [this.bbox.minLat, this.bbox.minLon],
          [this.bbox.maxLat, this.bbox.maxLon],
        ],
      ],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"],
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.lastReason = (err as Error).message;
    }
  }

  private onMessage(raw: string) {
    if (!this.onEvent) return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const m = msg as { MessageType?: string };
    if (m.MessageType === "PositionReport") {
      const p = msg as PositionReportMsg;
      const id = String(p.MetaData.MMSI);
      const cog = p.Message.PositionReport.Cog;
      const sogKnots = p.Message.PositionReport.Sog;
      const lat = p.Message.PositionReport.Latitude;
      const lon = p.Message.PositionReport.Longitude;
      const speedMs = sogKnots * 0.5144; // knots → m/s
      const ent: FeedEntity = {
        id,
        kind: "vessel",
        lat,
        lon,
        headingDeg: cog,
        speedMs,
        label: p.MetaData.ShipName?.trim() || id,
        shipType: this.shipTypes.get(id),
        ts: Date.now(),
      };
      this.knownIds.add(id);
      this.lastUpdateTs = Date.now();
      this.onEvent({ type: "update", entity: ent });
    } else if (m.MessageType === "ShipStaticData") {
      const s = msg as ShipStaticMsg;
      this.shipTypes.set(String(s.MetaData.MMSI), s.Message.ShipStaticData.Type);
    }
  }

  private prune() {
    if (!this.onEvent) return;
    // The layer itself ages out entities — we don't need to chase them here.
    // This hook is reserved for any out-of-region cleanup we want to add.
  }
}
