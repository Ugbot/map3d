import { create } from "zustand";

export interface TimeStoreShape {
  hour: number; // 0..24
  autoplay: boolean;
  speed: number; // hours/sec
  set: (h: number) => void;
  toggleAutoplay: () => void;
  setSpeed: (v: number) => void;
}

export const useTimeStore = create<TimeStoreShape>((set) => ({
  hour: 14,
  autoplay: false,
  speed: 0.5,
  set: (hour) => set({ hour }),
  toggleAutoplay: () => set((s) => ({ autoplay: !s.autoplay })),
  setSpeed: (speed) => set({ speed }),
}));
