// OpenSky Network REST feed for aircraft.
//
// GET /api/states/all?lamin=&lomin=&lamax=&lomax=
//
// CORS: OpenSky restricts Access-Control-Allow-Origin to its own domain. In a
// browser, route through a dev proxy (the app uses /feeds/opensky). In Node
// the server can hit the real URL directly.

import type { FeedBbox, FeedEntity, FeedEvent, FeedSource } from "./types";

const POLL_MS = 12_000;

export interface OpenSkyOptions {
  /** Base URL for the OpenSky API. Default is the public host (works in Node). */
  baseUrl?: string;
  /** Override poll interval in ms. */
  pollMs?: number;
}

export class OpenSkyFeed implements FeedSource {
  readonly id = "opensky";
  readonly kind = "aircraft" as const;
  private bbox: FeedBbox | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onEvent: ((e: FeedEvent) => void) | null = null;
  private knownIds = new Set<string>();
  private lastUpdateTs = 0;
  private connected = false;
  private lastReason: string | undefined;
  private inflight: AbortController | null = null;
  private readonly baseUrl: string;
  private readonly pollMs: number;

  constructor(opts: OpenSkyOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://opensky-network.org";
    this.pollMs = opts.pollMs ?? POLL_MS;
  }

  setRegion(bbox: FeedBbox): void {
    this.bbox = bbox;
    if (this.onEvent) this.poll().catch(() => {});
  }

  start(onEvent: (e: FeedEvent) => void): void {
    this.onEvent = onEvent;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
    if (this.bbox) this.poll().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inflight?.abort();
    this.inflight = null;
    this.onEvent = null;
    this.connected = false;
  }

  status() {
    return { connected: this.connected, lastUpdateTs: this.lastUpdateTs, reason: this.lastReason };
  }

  private async poll(): Promise<void> {
    if (!this.onEvent || !this.bbox) return;
    this.inflight?.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const url =
      `${this.baseUrl}/api/states/all` +
      `?lamin=${this.bbox.minLat.toFixed(4)}` +
      `&lomin=${this.bbox.minLon.toFixed(4)}` +
      `&lamax=${this.bbox.maxLat.toFixed(4)}` +
      `&lomax=${this.bbox.maxLon.toFixed(4)}`;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { time: number; states: unknown[][] | null };
      this.connected = true;
      this.lastReason = undefined;
      this.lastUpdateTs = Date.now();
      const seen = new Set<string>();
      if (json.states) {
        const ts = json.time * 1000;
        for (const s of json.states) {
          const e = decodeState(s, ts);
          if (e) {
            seen.add(e.id);
            this.onEvent({ type: "update", entity: e });
          }
        }
      }
      this.knownIds = seen;
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      this.connected = false;
      this.lastReason = (err as Error).message;
    }
  }
}

function decodeState(arr: unknown[], pollTs: number): FeedEntity | null {
  const icao = typeof arr[0] === "string" ? arr[0] : null;
  if (!icao) return null;
  const callsign = typeof arr[1] === "string" ? arr[1].trim() : "";
  const lon = typeof arr[5] === "number" ? arr[5] : null;
  const lat = typeof arr[6] === "number" ? arr[6] : null;
  if (lat === null || lon === null) return null;
  const baroAlt = typeof arr[7] === "number" ? arr[7] : null;
  const onGround = arr[8] === true;
  const velocity = typeof arr[9] === "number" ? arr[9] : 0;
  const track = typeof arr[10] === "number" ? arr[10] : 0;
  const vRate = typeof arr[11] === "number" ? arr[11] : 0;
  const geoAlt = typeof arr[13] === "number" ? arr[13] : null;
  const altM = baroAlt ?? geoAlt ?? 0;
  return {
    id: icao,
    kind: "aircraft",
    lat,
    lon,
    altM,
    headingDeg: track,
    speedMs: velocity,
    verticalMs: vRate,
    onGround,
    label: callsign || icao,
    ts: pollTs,
  };
}
