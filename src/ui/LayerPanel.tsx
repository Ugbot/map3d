import { Eye, EyeOff, Sparkles } from "lucide-react";
import { useLayerStore, LAYER_ORDER } from "@/state/layerStore";
import type { LayerName } from "@/cache/types";

const LABELS: Record<LayerName, string> = {
  buildings: "Buildings",
  roads: "Roads",
  rail: "Rail",
  water: "Water",
  landuse: "Landuse",
  paths: "Paths",
  pois: "Transit POIs",
};

const SWATCH: Record<LayerName, string> = {
  buildings: "#9aa3ad",
  roads: "#ffc66b",
  rail: "#c18bff",
  water: "#3a7fd5",
  landuse: "#5fa05a",
  paths: "#ffd49a",
  pois: "#ffd166",
};

export function LayerPanel() {
  const layers = useLayerStore((s) => s.layers);
  const toggle = useLayerStore((s) => s.toggle);
  const setOpacity = useLayerStore((s) => s.setOpacity);
  const setGlow = useLayerStore((s) => s.setGlow);
  const isolate = useLayerStore((s) => s.isolate);

  return (
    <div
      className="premium-card"
      style={{
        width: 280,
        padding: 16,
        background: "rgba(20, 22, 34, 0.92)",
        color: "#f1f5f9",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, opacity: 0.85 }}>Layers</div>
        <button
          onClick={() => isolate(null)}
          style={{
            background: "transparent",
            color: "#cbd5e1",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          All on
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {LAYER_ORDER.map((n) => {
          const l = layers[n];
          return (
            <div key={n} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={() => toggle(n)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: l.visible ? "#7dd3fc" : "#475569",
                    cursor: "pointer",
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                  }}
                  title={l.visible ? "Hide" : "Show"}
                >
                  {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: SWATCH[n],
                    opacity: l.visible ? 1 : 0.35,
                  }}
                />
                <div style={{ flex: 1, fontSize: 13, opacity: l.visible ? 1 : 0.55 }}>{LABELS[n]}</div>
                <button
                  onClick={() => isolate(n)}
                  style={{
                    background: "transparent",
                    color: "#94a3b8",
                    border: "none",
                    padding: 2,
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                  title="Isolate"
                >
                  solo
                </button>
              </div>
              {l.visible && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 24 }}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={l.opacity}
                    onChange={(e) => setOpacity(n, parseFloat(e.target.value))}
                    style={{ flex: 1 }}
                    title="Opacity"
                  />
                  <Sparkles size={12} style={{ color: "#fbbf24", opacity: 0.7 }} />
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={l.glow}
                    onChange={(e) => setGlow(n, parseFloat(e.target.value))}
                    style={{ flex: 1 }}
                    title="Glow"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
