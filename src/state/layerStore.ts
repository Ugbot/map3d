import { create } from "zustand";
import type { LayerName } from "../cache/types";

export interface LayerState {
  visible: boolean;
  opacity: number;
  glow: number; // 0..1 — multiplier on emissive intensity
}

export interface LayerStoreShape {
  layers: Record<LayerName, LayerState>;
  selection: { layer: LayerName; featureGlobalId: string } | null;
  toggle: (name: LayerName) => void;
  setVisible: (name: LayerName, v: boolean) => void;
  setOpacity: (name: LayerName, v: number) => void;
  setGlow: (name: LayerName, v: number) => void;
  isolate: (name: LayerName | null) => void;
  setSelection: (s: LayerStoreShape["selection"]) => void;
}

const ALL: LayerName[] = ["buildings", "roads", "rail", "water", "landuse", "paths", "pois"];

const defaults: Record<LayerName, LayerState> = Object.fromEntries(
  ALL.map((n) => [n, { visible: true, opacity: 1, glow: n === "rail" ? 0.6 : 0.2 }]),
) as Record<LayerName, LayerState>;

export const useLayerStore = create<LayerStoreShape>((set) => ({
  layers: defaults,
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
}));

export const LAYER_ORDER = ALL;
