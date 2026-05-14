import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { LayerName } from "@map3d/data-core";
import type { Engine } from "@/engine/Engine";

interface Props {
  layer: LayerName;
  globalId: string;
  screenX: number;
  screenY: number;
  engine: Engine | null;
  onClose: () => void;
}

export function InfoPopup({ layer, globalId, screenX, screenY, engine, onClose }: Props) {
  const [attrs, setAttrs] = useState<Record<string, string | number> | null>(null);

  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    engine
      .getAttributesAsync(layer, globalId)
      .then((a) => {
        if (!cancelled) setAttrs(a);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [engine, layer, globalId]);

  const title = (attrs?.name as string) ?? humanizeLayer(layer);
  const subtitle = globalId;
  const entries = attrs ? Object.entries(attrs).filter(([k]) => k !== "name") : [];

  return (
    <div
      className="premium-card"
      style={{
        position: "absolute",
        left: Math.min(screenX + 12, window.innerWidth - 280),
        top: Math.min(screenY + 12, window.innerHeight - 240),
        width: 260,
        zIndex: 200,
        padding: 16,
        pointerEvents: "auto",
        background: "rgba(20, 22, 34, 0.92)",
        color: "#f1f5f9",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2, fontFamily: "monospace" }}>
            {subtitle}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "#cbd5e1",
            cursor: "pointer",
            padding: 4,
          }}
          aria-label="close"
        >
          <X size={16} />
        </button>
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        {entries.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.6 }}>No attributes for this feature.</div>
        )}
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: "flex", fontSize: 12, gap: 8 }}>
            <div style={{ flex: "0 0 90px", opacity: 0.55 }}>{k}</div>
            <div style={{ flex: 1, color: "#e2e8f0", wordBreak: "break-word" }}>{String(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function humanizeLayer(l: LayerName) {
  if (l === "buildings") return "Building";
  if (l === "roads") return "Road";
  if (l === "rail") return "Rail";
  if (l === "water") return "Water";
  if (l === "landuse") return "Landuse";
  if (l === "paths") return "Path";
  if (l === "pois") return "POI";
  return l;
}
