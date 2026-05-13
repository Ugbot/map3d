// Tile-provider registry. A provider bundles:
//   - how to fetch a tile (PMTiles range read, or a slippy MVT URL template)
//   - which schema the bytes use (so the worker picks the right classifier)
//   - max zoom and a human label for the UI
//
// Composability: a backend service that proxies tiles can register itself as
// another entry here without touching the engine or the worker schema code.

export type Schema = "protomaps-v4" | "openmaptiles";

export type TileSource =
  | { kind: "pmtiles"; url: string }
  | { kind: "mvt"; urlTemplate: string };

export interface TileProvider {
  id: string;
  label: string;
  source: TileSource;
  schema: Schema;
  maxZoom: number;
  minZoom?: number;
  attribution: string;
  notes?: string;
}

export const PROVIDERS: TileProvider[] = [
  {
    id: "openfreemap",
    label: "OpenFreeMap (OpenMapTiles)",
    source: {
      kind: "mvt",
      // Date-stamped path published in the TileJSON at https://tiles.openfreemap.org/planet.
      // Stable until the operator rolls a new build; if it 404s, fetch /planet for the latest.
      urlTemplate: "https://tiles.openfreemap.org/planet/20260506_001001_pt/{z}/{x}/{y}.pbf",
    },
    schema: "openmaptiles",
    maxZoom: 14,
    minZoom: 0,
    attribution: "© OpenStreetMap, © OpenMapTiles, © OpenFreeMap",
    notes: "Buildings carry render_height; landcover + waterway present; CORS-open.",
  },
  {
    id: "protomaps-demo",
    label: "Protomaps planet demo",
    source: {
      // Routed through the vite dev proxy (upstream has no CORS). In production
      // self-host a .pmtiles on a CORS-enabled bucket and add a new entry here.
      kind: "pmtiles",
      url: "/pmtiles/protomaps/v4.pmtiles",
    },
    schema: "protomaps-v4",
    maxZoom: 15,
    minZoom: 0,
    attribution: "© OpenStreetMap, © Protomaps",
    notes: "No building heights in this build; sparse subtype info.",
  },
];

const STORAGE_KEY = "map3d.provider";

export function defaultProviderId(): string {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && PROVIDERS.some((p) => p.id === stored)) return stored;
  }
  return "openfreemap";
}

export function getProvider(id: string): TileProvider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export function persistProvider(id: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, id);
}
