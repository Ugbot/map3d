// Streaming mode: the engine fetches tiles directly when it mounts at step 2,
// so this step is just a UI courtesy that confirms the area selection and
// flips isReady. We deliberately do NOT pre-fetch — that defeats the whole
// point of camera-driven streaming.

import { useAreaStore } from "@/state/areaStore";
import { useCityStore } from "@/state/cityStore";
import { CheckCircle2, Info } from "lucide-react";
import { useEffect } from "react";

export function BuildingHeights({ area }: { area: { lat: number; lng: number }[] }) {
  const { isReady, setReady, setStatus, setProgress } = useCityStore();
  const center = useAreaStore((s) => s.center);

  useEffect(() => {
    if (!area || area.length < 2) return;
    if (isReady) return;
    setStatus("Area locked. Streaming will begin in 3D view.");
    setProgress(100);
    setReady(true);
  }, [area, isReady, setReady, setStatus, setProgress]);

  const w = center?.[1]?.lng;
  const s = center?.[1]?.lat;
  const e = center?.[0]?.lng;
  const n = center?.[0]?.lat;

  return (
    <div className="premium-card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <CheckCircle2 color="#22c55e" />
        <span style={{ fontWeight: 700, fontSize: 16 }}>Area locked</span>
      </div>
      {Number.isFinite(w) && (
        <div style={{ fontSize: 12, opacity: 0.7, fontFamily: "monospace" }}>
          W {w!.toFixed(4)} &nbsp; S {s!.toFixed(4)}
          <br />
          E {e!.toFixed(4)} &nbsp; N {n!.toFixed(4)}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.65, fontSize: 13 }}>
        <Info size={14} />
        <span>
          Tiles stream around the camera at zoom 15. Nothing is downloaded until you enter the 3D
          view. Cached tiles stay in your browser; clear them via DevTools → Application → IndexedDB.
        </span>
      </div>
    </div>
  );
}
