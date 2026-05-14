import { create } from "zustand";
import type { LayerName } from "@map3d/data-core";

export interface LayerState {
  visible: boolean;
  opacity: number;
  glow: number;
}

export type GroupName = "surface" | "water" | "network" | "structures" | "pois" | "live";

export interface LayerStoreShape {
  layers: Record<LayerName, LayerState>;
  groupOpen: Record<GroupName, boolean>;
  selection: { layer: LayerName; featureGlobalId: string } | null;
  toggle: (name: LayerName) => void;
  setVisible: (name: LayerName, v: boolean) => void;
  setOpacity: (name: LayerName, v: number) => void;
  setGlow: (name: LayerName, v: number) => void;
  isolate: (name: LayerName | null) => void;
  setSelection: (s: LayerStoreShape["selection"]) => void;
  toggleGroup: (g: GroupName) => void;
  applyPreset: (preset: PresetName) => void;
  /** Global "night glow" for every emissive layer. */
  setAllGlow: (v: number) => void;
  /** Scales opacity of the surface group only. */
  setSurfaceOpacity: (v: number) => void;
  /** Get the current global night-glow value (uniform across emissive layers). */
  getGlobalGlow: () => number;
  /** Get the current surface-overlay opacity. */
  getSurfaceOpacity: () => number;
}

const ALL: LayerName[] = [
  "earth",
  "landcover",
  "landuse",
  "water",
  "waterway",
  "paths",
  "roads",
  "rail",
  "buildings",
  "streetlights",
  "pois",
  "aircraft",
  "vessels",
];

export const LAYER_ORDER = ALL;

export const LAYER_GROUPS: Record<GroupName, LayerName[]> = {
  surface: ["earth", "landcover", "landuse"],
  water: ["water", "waterway"],
  network: ["paths", "roads", "rail"],
  structures: ["buildings", "streetlights"],
  pois: ["pois"],
  live: ["aircraft", "vessels"],
};

export const EMISSIVE_LAYERS: ReadonlySet<LayerName> = new Set([
  "roads",
  "rail",
  "paths",
  "pois",
  "buildings",
  "streetlights",
  "aircraft",
  "vessels",
]);

// Glow makes sense only for emissive layers.
export function hasGlow(n: LayerName): boolean {
  return EMISSIVE_LAYERS.has(n);
}

const DEFAULT_GLOW: Record<LayerName, number> = {
  earth: 0,
  landcover: 0,
  landuse: 0,
  water: 0,
  waterway: 0,
  paths: 0.1,
  roads: 0.4,
  rail: 0.7,
  buildings: 0.15,
  streetlights: 0.9,
  pois: 0.6,
  aircraft: 0.5,
  vessels: 0.5,
};

const defaults: Record<LayerName, LayerState> = Object.fromEntries(
  ALL.map((n) => [n, { visible: true, opacity: 1, glow: DEFAULT_GLOW[n] }]),
) as Record<LayerName, LayerState>;

export type PresetName = "all" | "network" | "surface" | "night";

const PRESETS: Record<PresetName, Partial<Record<LayerName, boolean>>> = {
  all: Object.fromEntries(ALL.map((n) => [n, true])),
  network: {
    earth: true,
    landcover: false,
    landuse: false,
    water: true,
    waterway: true,
    paths: true,
    roads: true,
    rail: true,
    buildings: true,
    pois: false,
  },
  surface: {
    earth: true,
    landcover: true,
    landuse: true,
    water: true,
    waterway: true,
    paths: false,
    roads: false,
    rail: false,
    buildings: false,
    pois: false,
  },
  night: {
    earth: true,
    landcover: false,
    landuse: false,
    water: true,
    waterway: false,
    paths: false,
    roads: false,
    rail: true,
    buildings: true,
    pois: true,
  },
};

export const useLayerStore = create<LayerStoreShape>((set) => ({
  layers: defaults,
  groupOpen: { surface: true, water: true, network: true, structures: true, pois: true },
  selection: null,
  toggle: (name) =>
    set((s) => ({
      layers: { ...s.layers, [name]: { ...s.layers[name], visible: !s.layers[name].visible } },
    })),
  setVisible: (name, v) =>
    set((s) => ({ layers: { ...s.layers, [name]: { ...s.layers[name], visible: v } } })),
  setOpacity: (name, v) =>
    set((s) => ({ layers: { ...s.layers, [name]: { ...s.layers[name], opacity: v } } })),
  setGlow: (name, v) =>
    set((s) => ({ layers: { ...s.layers, [name]: { ...s.layers[name], glow: v } } })),
  isolate: (name) =>
    set((s) => {
      const next: Record<LayerName, LayerState> = { ...s.layers };
      for (const n of ALL) next[n] = { ...next[n], visible: name === null || n === name };
      return { layers: next };
    }),
  setSelection: (selection) => set({ selection }),
  toggleGroup: (g) =>
    set((s) => ({ groupOpen: { ...s.groupOpen, [g]: !s.groupOpen[g] } })),
  applyPreset: (preset) =>
    set((s) => {
      const p = PRESETS[preset];
      const next: Record<LayerName, LayerState> = { ...s.layers };
      for (const n of ALL) next[n] = { ...next[n], visible: p[n] ?? next[n].visible };
      return { layers: next };
    }),
  setAllGlow: (v) =>
    set((s) => {
      const next: Record<LayerName, LayerState> = { ...s.layers };
      for (const n of ALL) {
        if (EMISSIVE_LAYERS.has(n)) next[n] = { ...next[n], glow: v };
      }
      return { layers: next };
    }),
  setSurfaceOpacity: (v) =>
    set((s) => {
      const next: Record<LayerName, LayerState> = { ...s.layers };
      for (const n of LAYER_GROUPS.surface) next[n] = { ...next[n], opacity: v };
      // Water also benefits from a single opacity knob.
      for (const n of LAYER_GROUPS.water) next[n] = { ...next[n], opacity: v };
      return { layers: next };
    }),
  getGlobalGlow: () => {
    const s = useLayerStore.getState();
    return s.layers.roads.glow;
  },
  getSurfaceOpacity: () => {
    const s = useLayerStore.getState();
    return s.layers.earth.opacity;
  },
}));
