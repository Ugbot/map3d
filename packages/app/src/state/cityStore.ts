import { create } from 'zustand';

type CityState = {
  isGenerating: boolean;
  isReady: boolean;
  progress: number;
  status: string;
  
  startGeneration: () => void;
  setReady: (ready: boolean) => void;
  setGenerating: (gen: boolean) => void;
  setProgress: (p: number) => void;
  setStatus: (s: string) => void;
};

export const useCityStore = create<CityState>((set) => ({
  isGenerating: false,
  isReady: false,
  progress: 0,
  status: 'Ready to generate',
  
  startGeneration: () => set({ isGenerating: true, isReady: false, progress: 0, status: 'Initializing...' }),
  setReady: (ready) => set({ isReady: ready, isGenerating: !ready }),
  setGenerating: (gen) => set({ isGenerating: gen }),
  setProgress: (p) => set({ progress: p }),
  setStatus: (s) => set({ status: s }),
}));
