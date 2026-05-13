// AISStream.io WebSocket feed for vessels.
//
// Requires an API key. In a browser environment you can read from
// localStorage["map3d.aisstream_key"] or import.meta.env.VITE_AISSTREAM_KEY;
// in Node the server passes the key explicitly via the constructor.

import type { FeedBbox, FeedEntity, FeedEvent, FeedSource } from "./types";

const DEFAULT_URL = "wss://stream.aisstream.io/v0/stream";

// Cross-environment WebSocket type — Node 20+ exposes a global WebSocket too,
// so this lines up with the browser DOM type.
type WSCtor = typeof WebSocket;
type WSInstance = WebSocket;

interface PositionReportMsg {
  MessageType: "PositionReport";
  MetaData: { MMSI: number; ShipName?: string; latitude: number; longitude: number; time_utc: string };
  Message: {
    PositionReport: {
      UserID: number;
      Latitude: number;
      Longitude: number;
      Cog: number;
      Sog: number;
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

export interface AISStreamOptions {
  /** Required. Pass null/undefined to disable (feed becomes a no-op). */
  apiKey?: string | null;
  /** Override the stream URL (e.g. for staging). */
  url?: string;
  /** Override the WebSocket constructor. Defaults to globalThis.WebSocket. */
  wsCtor?: WSCtor;
}

export class AISStreamFeed implements FeedSource {
  readonly id = "aisstream";
  readonly kind = "vessel" as const;
  private ws: WSInstance | null = null;
  private bbox: FeedBbox | null = null;
  private onEvent: ((e: FeedEvent) => void) | null = null;
  private shipTypes = new Map<string, number>();
  private lastUpdateTs = 0;
  private connected = false;
  private lastReason: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private apiKey: string | null;
  private readonly url: string;
  private readonly wsCtor: WSCtor | null;

  constructor(opts: AISStreamOptions = {}) {
    this.apiKey = opts.apiKey ?? null;
    this.url = opts.url ?? DEFAULT_URL;
    this.wsCtor = opts.wsCtor ?? (typeof WebSocket !== "undefined" ? WebSocket : null);
  }

  setRegion(bbox: FeedBbox): void {
    this.bbox = bbox;
    if (this.ws && this.ws.readyState === 1 /* OPEN */) this.sendSubscribe();
  }

  start(onEvent: (e: FeedEvent) => void): void {
    this.onEvent = onEvent;
    if (!this.apiKey) {
      this.lastReason = "no-key";
      return;
    }
    if (!this.wsCtor) {
      this.lastReason = "no WebSocket impl";
      return;
    }
    this.connect();
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    this.onEvent = null;
  }

  status() {
    return { connected: this.connected, lastUpdateTs: this.lastUpdateTs, reason: this.lastReason };
  }

  private connect() {
    if (!this.apiKey || !this.wsCtor) return;
    try {
      this.ws = new this.wsCtor(this.url);
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
    this.ws.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as string);
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
    if (!this.ws || this.ws.readyState !== 1) return;
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
      const speedMs = sogKnots * 0.5144;
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
      this.lastUpdateTs = Date.now();
      this.onEvent({ type: "update", entity: ent });
    } else if (m.MessageType === "ShipStaticData") {
      const s = msg as ShipStaticMsg;
      this.shipTypes.set(String(s.MetaData.MMSI), s.Message.ShipStaticData.Type);
    }
  }
}
