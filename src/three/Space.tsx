// Thin React shell that mounts the vanilla-Three Engine and forwards layer/
// time-of-day toggles from the zustand stores. Selection events surface here
// and bubble up via `onSelect` so the InfoPopup can show attributes.
//
// This file deliberately contains no Three.js calls — everything Three-side
// lives in `src/engine/`. That's the composability boundary.

import { useEffect, useRef, useState } from "react";
import { useAreaStore } from "@/state/areaStore";
import { useCityStore } from "@/state/cityStore";
import { useLayerStore } from "@/state/layerStore";
import { useTimeStore } from "@/state/timeStore";
import { Engine } from "@/engine/Engine";
import type { LayerName } from "@/cache/types";
import { InfoPopup } from "@/ui/InfoPopup";

// Composability: PMTiles source resolved at runtime so a future backend can
// stand in (a thin proxy that returns MVTs on the same URL shape works).
function resolvePmtilesUrl(): string {
  const fromLocal = typeof localStorage !== "undefined" && localStorage.getItem("map3d.pmtiles_url");
  if (fromLocal) return fromLocal;
  const fromEnv = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_PMTILES_URL;
  if (fromEnv) return fromEnv;
  // Public Protomaps sample (NYC region, older daily build).
  return "https://r2-public.protomaps.com/protomaps-sample-datasets/protomaps-basemap-opensource-20230408.pmtiles";
}

export function Space() {
  const isReady = useCityStore((s) => s.isReady);
  const center = useAreaStore((s) => s.center);
  const layers = useLayerStore((s) => s.layers);
  const setSelection = useLayerStore((s) => s.setSelection);
  const hour = useTimeStore((s) => s.hour);
  const autoplay = useTimeStore((s) => s.autoplay);
  const speed = useTimeStore((s) => s.speed);
  const setHour = useTimeStore((s) => s.set);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const [popup, setPopup] = useState<{
    layer: LayerName;
    globalId: string;
    screenX: number;
    screenY: number;
  } | null>(null);

  // Mount engine when entering 3D view (isReady becomes true + center set).
  useEffect(() => {
    if (!isReady) return;
    if (!hostRef.current) return;
    if (!center || center.length < 2) return;
    const bbox = {
      west: center[1].lng,
      south: center[1].lat,
      east: center[0].lng,
      north: center[0].lat,
    };
    const engine = new Engine(hostRef.current, {
      pmtilesUrl: resolvePmtilesUrl(),
      bbox,
      onSelect: (layer, globalId, x, y) => {
        if (!globalId) {
          setPopup(null);
          setSelection(null);
          return;
        }
        setPopup({ layer, globalId, screenX: x, screenY: y });
        setSelection({ layer, featureGlobalId: globalId });
      },
    });
    engineRef.current = engine;
    engine.start();
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [isReady, center, setSelection]);

  // Forward layer state to engine.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    for (const name in layers) {
      const ln = name as LayerName;
      eng.setLayerVisible(ln, layers[ln].visible);
      eng.setLayerOpacity(ln, layers[ln].opacity);
      eng.setLayerGlow(ln, layers[ln].glow);
    }
  }, [layers]);

  // Forward hour + autoplay.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.setHour(hour);
  }, [hour]);

  useEffect(() => {
    if (!autoplay) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      let h = useTimeStore.getState().hour + dt * speed;
      if (h >= 24) h -= 24;
      setHour(h);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoplay, speed, setHour]);

  if (!isReady) {
    return null;
  }
  return (
    <>
      <div
        ref={hostRef}
        style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#0b1020" }}
      />
      {popup && (
        <InfoPopup
          layer={popup.layer}
          globalId={popup.globalId}
          screenX={popup.screenX}
          screenY={popup.screenY}
          engine={engineRef.current}
          onClose={() => {
            setPopup(null);
            setSelection(null);
            engineRef.current?.highlight(null, null);
          }}
        />
      )}
    </>
  );
}

export default Space;
