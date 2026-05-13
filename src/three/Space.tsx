// Thin React shell. Mounts the vanilla-Three engine, forwards layer/time
// settings, surfaces selection events. Re-mounts the engine on provider switch.

import { useEffect, useRef, useState } from "react";
import { useAreaStore } from "@/state/areaStore";
import { useCityStore } from "@/state/cityStore";
import { useLayerStore } from "@/state/layerStore";
import { useTimeStore } from "@/state/timeStore";
import { useProviderStore } from "@/state/providerStore";
import { Engine } from "@/engine/Engine";
import type { LayerName } from "@/cache/types";
import { InfoPopup } from "@/ui/InfoPopup";
import { DebugHUD } from "@/ui/DebugHUD";

export function Space() {
  const isReady = useCityStore((s) => s.isReady);
  const pick = useAreaStore((s) => s.pick);
  const provider = useProviderStore((s) => s.provider);
  const layers = useLayerStore((s) => s.layers);
  const setSelection = useLayerStore((s) => s.setSelection);
  const hour = useTimeStore((s) => s.hour);
  const autoplay = useTimeStore((s) => s.autoplay);
  const speed = useTimeStore((s) => s.speed);
  const setHour = useTimeStore((s) => s.set);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [popup, setPopup] = useState<{
    layer: LayerName;
    globalId: string;
    screenX: number;
    screenY: number;
  } | null>(null);

  useEffect(() => {
    if (!isReady) return;
    if (!hostRef.current) return;
    if (!pick) return;
    const eng = new Engine(hostRef.current, {
      provider,
      center: { lat: pick.lat, lng: pick.lng },
      ringRadius: 4,
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
    setEngine(eng);
    eng.start();
    return () => {
      eng.dispose();
      setEngine(null);
    };
    // Re-mount when provider changes so the worker schema is reinit'd cleanly.
  }, [isReady, pick, provider, setSelection]);

  useEffect(() => {
    if (!engine) return;
    for (const name in layers) {
      const ln = name as LayerName;
      engine.setLayerVisible(ln, layers[ln].visible);
      engine.setLayerOpacity(ln, layers[ln].opacity);
      engine.setLayerGlow(ln, layers[ln].glow);
    }
  }, [layers, engine]);

  useEffect(() => {
    if (!engine) return;
    engine.setHour(hour);
  }, [hour, engine]);

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
      <DebugHUD engine={engine} />
      {popup && (
        <InfoPopup
          layer={popup.layer}
          globalId={popup.globalId}
          screenX={popup.screenX}
          screenY={popup.screenY}
          engine={engine}
          onClose={() => {
            setPopup(null);
            setSelection(null);
            engine?.highlight(null, null);
          }}
        />
      )}
    </>
  );
}

export default Space;
