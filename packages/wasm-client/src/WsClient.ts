// WsClient — binary WebSocket client for the map3d data-server.
//
// Tiger style:
//   * Reconnect with capped exponential backoff (250ms → 8s) + jitter.
//   * HELLO is sent on every successful open; BBOX is replayed if set.
//   * Static frame encoder buffers (no per-message allocation).
//   * All inbound payloads are forwarded as Uint8Array to a single callback;
//     parse failures are isolated to that callback and never break the loop.
//
// Wire spec: see packages/data-core/src/codec/FrameCodec.ts.

import {
  FRAME_KIND_BBOX,
  FRAME_KIND_HELLO,
  FrameEncoder,
  assertFinite,
  assertInRange,
} from "@map3d/data-core";

export type WsState = "connecting" | "open" | "closed" | "error";

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface WsClientOptions {
  url: string;
  onFrame: (frame: Uint8Array) => void;
  onState?: (state: WsState, detail?: string) => void;
  /** Optional clock for HELLO timestamps; defaults to Date.now. */
  now?: () => number;
}

const HELLO_CAPACITY = 64;
const BBOX_CAPACITY = 128;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 8000;

export class WsClient {
  private readonly opts: WsClientOptions;
  private ws: WebSocket | null = null;
  private bbox: Bbox | null = null;
  private tickSeq = 0;
  private reconnectMs = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly helloEnc = new FrameEncoder(HELLO_CAPACITY);
  private readonly bboxEnc = new FrameEncoder(BBOX_CAPACITY);
  private state: WsState = "closed";

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws != null) {
      try {
        this.ws.close(1000, "client stop");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setState("closed");
  }

  /** Set the viewport bbox sent to the server on connect and re-sent now if
   *  the socket is open. Coordinates are WGS84 degrees. */
  setBbox(bbox: Bbox): void {
    assertInRange(bbox.minLat, -90, 90, "bbox.minLat");
    assertInRange(bbox.maxLat, -90, 90, "bbox.maxLat");
    assertInRange(bbox.minLon, -180, 180, "bbox.minLon");
    assertInRange(bbox.maxLon, -180, 180, "bbox.maxLon");
    this.bbox = { ...bbox };
    if (this.ws != null && this.ws.readyState === WebSocket.OPEN) {
      this.sendBbox(this.bbox);
    }
  }

  getState(): WsState {
    return this.state;
  }

  private connect(): void {
    if (this.closedByUser) return;
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.setState("error", String(err));
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectMs = RECONNECT_MIN_MS;
      this.setState("open");
      this.sendHello();
      if (this.bbox != null) this.sendBbox(this.bbox);
    });

    ws.addEventListener("message", (ev) => {
      // Binary frames only. We accept ArrayBuffer (binaryType="arraybuffer").
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        const view = new Uint8Array(data);
        try {
          this.opts.onFrame(view);
        } catch (err) {
          // Don't kill the socket on parse error — log and continue.
          console.error("[WsClient] onFrame threw:", err);
        }
      } else {
        // Server should never send text. Ignore but log once.
        console.warn("[WsClient] non-binary message ignored");
      }
    });

    ws.addEventListener("error", () => {
      this.setState("error");
      // 'error' is always followed by 'close'; do reconnect work there.
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      if (this.closedByUser) {
        this.setState("closed");
        return;
      }
      this.setState("closed");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectTimer != null) return;
    const jitter = Math.floor(Math.random() * 100);
    const delay = this.reconnectMs + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
      this.connect();
    }, delay);
  }

  private sendHello(): void {
    const ws = this.ws;
    if (ws == null || ws.readyState !== WebSocket.OPEN) return;
    const now = this.opts.now?.() ?? Date.now();
    assertFinite(now, "now()");
    this.helloEnc.beginFrame(FRAME_KIND_HELLO, this.nextTick(), now);
    this.helloEnc.writeHelloSection(0);
    const buf = this.helloEnc.endFrame();
    // Copy out — the encoder buffer is reused on the next call.
    ws.send(buf.slice().buffer);
  }

  private sendBbox(bbox: Bbox): void {
    const ws = this.ws;
    if (ws == null || ws.readyState !== WebSocket.OPEN) return;
    const now = this.opts.now?.() ?? Date.now();
    this.bboxEnc.beginFrame(FRAME_KIND_BBOX, this.nextTick(), now);
    this.bboxEnc.writeBboxSection(
      bbox.minLat,
      bbox.minLon,
      bbox.maxLat,
      bbox.maxLon,
    );
    const buf = this.bboxEnc.endFrame();
    ws.send(buf.slice().buffer);
  }

  private nextTick(): number {
    this.tickSeq = (this.tickSeq + 1) >>> 0;
    return this.tickSeq;
  }

  private setState(state: WsState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state, detail);
  }
}
