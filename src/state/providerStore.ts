import { create } from "zustand";
import { defaultProviderId, persistProvider, getProvider, PROVIDERS, type TileProvider } from "@/providers/registry";

interface ProviderStoreShape {
  id: string;
  provider: TileProvider;
  setId: (id: string) => void;
}

export const useProviderStore = create<ProviderStoreShape>((set) => {
  const id = defaultProviderId();
  return {
    id,
    provider: getProvider(id),
    setId: (newId) => {
      persistProvider(newId);
      set({ id: newId, provider: getProvider(newId) });
    },
  };
});

export const ALL_PROVIDERS = PROVIDERS;
