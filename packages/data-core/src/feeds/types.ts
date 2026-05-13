// Live feed plumbing — aircraft (ADS-B) and vessels (AIS). Feeds publish
// FeedEntity objects identified by id; the FeedManager fans them out to the
// matching consumer. Sources are kept behind a tiny interface so swapping
// providers requires only a new FeedSource impl.

export type FeedKind = "aircraft" | "vessel";

export interface FeedEntity {
  id: string;
  kind: FeedKind;
  lat: number;
  lon: number;
  /** Metres above sea level (aircraft only). */
  altM?: number;
  /** Track / course over ground in degrees, 0 = north, clockwise. */
  headingDeg: number;
  /** Ground speed in metres per second. */
  speedMs: number;
  /** Climb rate in m/s (aircraft). */
  verticalMs?: number;
  /** Aircraft only — hide when true. */
  onGround?: boolean;
  /** Display label (callsign for aircraft, vessel name for ships). */
  label?: string;
  /** AIS vessel type code (ITU-R M.1371). 0..99. */
  shipType?: number;
  /** Source observation timestamp in unix ms. */
  ts: number;
}

export interface FeedBbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export type FeedEvent =
  | { type: "update"; entity: FeedEntity }
  | { type: "remove"; id: string };

export interface FeedSource {
  readonly id: string;
  readonly kind: FeedKind;
  setRegion(bbox: FeedBbox): void;
  start(onEvent: (e: FeedEvent) => void): void;
  stop(): void;
  status(): { connected: boolean; lastUpdateTs: number; reason?: string };
}
