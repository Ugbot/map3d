// WebSocket transport adapter for @map3d/data-core. One Node server, many
// browser clients. Tiger style: every client send is bounds-checked; failures
// detach the client rather than crash the server.

import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  FRAME_KIND_BBOX,
  FRAME_KIND_HELLO,
  FrameDecoder,
  SECTION_BBOX,
  SECTION_HELLO,
  readBboxSection,
  type ClientHandle,
  type Transport,
} from "@map3d/data-core";

export interface WsTransportOptions {
  port: number;
  host?: string;
}

export interface ClientBbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export class WsTransport implements Transport {
  private server: WebSocketServer;
  private clientMap: Map<string, WsClientHandle> = new Map();
  private onClientCb: ((c: WsClientHandle) => void) | null = null;

  constructor(opts: WsTransportOptions) {
    this.server = new WebSocketServer({ port: opts.port, host: opts.host });
    this.server.on("connection", (ws) => this.acceptClient(ws));
  }

  publish(frame: Uint8Array): void {
    // Defensive copy in case the encoder reuses its buffer between frames.
    const owned = new Uint8Array(frame);
    for (const c of this.clientMap.values()) c.send(owned);
  }

  /** Iterate currently-connected client handles (for per-client encoding). */
  clients(): Iterable<WsClientHandle> {
    return this.clientMap.values();
  }

  onClient(cb: (c: ClientHandle) => void): void {
    this.onClientCb = cb as (c: WsClientHandle) => void;
  }

  close(): void {
    for (const c of this.clientMap.values()) c.close();
    this.server.close();
  }

  private acceptClient(ws: WebSocket): void {
    const handle = new WsClientHandle(ws);
    this.clientMap.set(handle.id, handle);
    ws.on("close", () => {
      this.clientMap.delete(handle.id);
      handle.fireClose();
    });
    if (this.onClientCb) this.onClientCb(handle);
  }
}

export class WsClientHandle implements ClientHandle {
  readonly id: string;
  private ws: WebSocket;
  private msgCb: ((m: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private bboxCb: ((b: ClientBbox) => void) | null = null;
  bbox: ClientBbox | null = null;

  constructor(ws: WebSocket) {
    this.id = randomUUID();
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.on("message", (data: ArrayBuffer | Buffer) => {
      const u8 =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.handleInbound(u8);
      if (this.msgCb) this.msgCb(u8);
    });
  }

  send(frame: Uint8Array): void {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(frame, { binary: true });
    } catch {
      // Treat as dropped — server will reap on close.
    }
  }

  onMessage(cb: (m: Uint8Array) => void): void {
    this.msgCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  /** Fires whenever a SECTION_BBOX is decoded from inbound traffic. */
  onBbox(cb: (b: ClientBbox) => void): void {
    this.bboxCb = cb;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  fireClose(): void {
    if (this.closeCb) this.closeCb();
  }

  private handleInbound(frame: Uint8Array): void {
    if (frame.byteLength < 20) return;
    let dec: FrameDecoder;
    try {
      dec = new FrameDecoder(frame);
    } catch {
      return;
    }
    const hdr = dec.header();
    if (hdr.kind !== FRAME_KIND_BBOX && hdr.kind !== FRAME_KIND_HELLO) return;
    dec.forEachSection((type, payload) => {
      if (type === SECTION_HELLO) {
        // HELLO is informational for v1.
      } else if (type === SECTION_BBOX) {
        try {
          this.bbox = readBboxSection(payload);
          if (this.bboxCb) this.bboxCb(this.bbox);
        } catch {
          // bad section — ignore
        }
      }
    });
  }
}
