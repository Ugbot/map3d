import { create } from "zustand";

export interface PickedLocation {
  lat: number;
  lng: number;
  label?: string;
}

type AreaStore = {
  pick: PickedLocation | null;
  setPick: (p: PickedLocation | null) => void;
};

export const useAreaStore = create<AreaStore>((set) => ({
  pick: { lat: 24.4539, lng: 54.3773, label: "Abu Dhabi" },
  setPick: (pick) => set({ pick }),
}));
