import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Moon, Droplet, Settings2 } from "lucide-react";
import {
  useLayerStore,
  LAYER_GROUPS,
  type GroupName,
  type PresetName,
} from "@/state/layerStore";
import type { LayerName } from "@/cache/types";

// Friendlier labels. Internal LayerName remains for code; this is what users see.
const LABELS: Record<LayerName, string> = {
  earth: "Ground",
  landcover: "Vegetation",
  landuse: "Districts",
  water: "Water",
  waterway: "Rivers & canals",
  paths: "Walkways",
  roads: "Roads",
  rail: "Rail",
  buildings: "Buildings",
  streetlights: "Street lights",
  pois: "Points of interest",
  aircraft: "Aircraft",
  vessels: "Vessels",
};

const SWATCH: Record<LayerName, string> = {
  earth: "#2c2826",
  landcover: "#5c8a5a",
  landuse: "#44503a",
  water: "#1e3a5f",
  waterway: "#3877be",
  paths: "#a89880",
  roads: "#e6e2d4",
  rail: "#c8b8d4",
  buildings: "#c3c8d0",
  streetlights: "#ffd28a",
  pois: "#ffd166",
  aircraft: "#fff0c8",
  vessels: "#9ad0ff",
};

const GROUP_LABELS: Record<GroupName, string> = {
  surface: "Surface",
  water: "Water",
  network: "Network",
  structures: "Structures",
  pois: "Points",
  live: "Live feeds",
};

const PRESETS: { id: PresetName; label: string; title: string }[] = [
  { id: "all", label: "All", title: "Show every layer" },
  { id: "network", label: "Network", title: "Roads, rail, walkways and buildings only" },
  { id: "surface", label: "Surface", title: "Ground, vegetation, districts and water only" },
  { id: "night", label: "Dark", title: "Only the network, ground and points (no surface fill)" },
];

export function LayerPanel() {
  const layers = useLayerStore((s) => s.layers);
  const groupOpen = useLayerStore((s) => s.groupOpen);
  const toggle = useLayerStore((s) => s.toggle);
  const isolate = useLayerStore((s) => s.isolate);
  const toggleGroup = useLayerStore((s) => s.toggleGroup);
  const applyPreset = useLayerStore((s) => s.applyPreset);
  const setAllGlow = useLayerStore((s) => s.setAllGlow);
  const setSurfaceOpacity = useLayerStore((s) => s.setSurfaceOpacity);
  const globalGlow = layers.roads.glow;
  const surfaceOpacity = layers.earth.opacity;

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const isolatedLayer = (() => {
    const visible = (Object.keys(layers) as LayerName[]).filter((n) => layers[n].visible);
    return visible.length === 1 ? visible[0] : null;
  })();

  return (
    <div
      className="premium-card"
      style={{
        width: 280,
        maxHeight: "75vh",
        overflowY: "auto",
        padding: 14,
        background: "rgba(20, 22, 34, 0.92)",
        color: "#f1f5f9",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, opacity: 0.8, textTransform: "uppercase" }}>
          Layers
        </div>
        <div style={{ fontSize: 10, opacity: 0.5 }} title="Click a layer to toggle. Right-click to isolate.">
          click • right-click
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => applyPreset(p.id)}
            title={p.title}
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "#e2e8f0",
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {(Object.keys(LAYER_GROUPS) as GroupName[]).map((group) => {
        const layerNames = LAYER_GROUPS[group];
        const open = groupOpen[group];
        return (
          <div key={group} style={{ marginBottom: 6 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 2px",
                cursor: "pointer",
                userSelect: "none",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
              }}
              onClick={() => toggleGroup(group)}
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, opacity: 0.7, textTransform: "uppercase" }}>
                {GROUP_LABELS[group]}
              </div>
            </div>
            {open && (
              <div style={{ paddingTop: 4 }}>
                {layerNames.map((n) => (
                  <LayerRow
                    key={n}
                    name={n}
                    visible={layers[n].visible}
                    isOnlyVisible={isolatedLayer === n}
                    onToggle={() => toggle(n)}
                    onIsolate={() => isolate(isolatedLayer === n ? null : n)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>
        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            color: "#94a3b8",
            border: "none",
            cursor: "pointer",
            padding: 0,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            opacity: 0.7,
          }}
        >
          {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Settings2 size={11} /> Advanced
        </button>
        {advancedOpen && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <SliderRow
              icon={<Moon size={12} color="#fbbf24" />}
              label="Night glow"
              value={globalGlow}
              onChange={setAllGlow}
              title="Brightness boost for roads, rail and points when the sun is below the horizon"
            />
            <SliderRow
              icon={<Droplet size={12} color="#7dd3fc" />}
              label="Surface opacity"
              value={surfaceOpacity}
              onChange={setSurfaceOpacity}
              title="Transparency of ground, vegetation, districts and water"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LayerRow({
  name,
  visible,
  isOnlyVisible,
  onToggle,
  onIsolate,
}: {
  name: LayerName;
  visible: boolean;
  isOnlyVisible: boolean;
  onToggle: () => void;
  onIsolate: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault();
        onIsolate();
      }}
      title={`Click: ${visible ? "hide" : "show"} ${LABELS[name]} • Right-click: ${isOnlyVisible ? "show all again" : "show only this"}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 6px",
        borderRadius: 4,
        cursor: "pointer",
        userSelect: "none",
        background: isOnlyVisible ? "rgba(125, 211, 252, 0.08)" : "transparent",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", color: visible ? "#7dd3fc" : "#475569" }}>
        {visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </span>
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          background: SWATCH[name],
          border: "1px solid rgba(255,255,255,0.1)",
          opacity: visible ? 1 : 0.35,
        }}
      />
      <span style={{ flex: 1, fontSize: 13, opacity: visible ? 1 : 0.55 }}>{LABELS[name]}</span>
    </div>
  );
}

function SliderRow({
  icon,
  label,
  value,
  onChange,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  onChange: (v: number) => void;
  title: string;
}) {
  return (
    <div title={title} style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {icon}
      <span style={{ fontSize: 11, width: 90, opacity: 0.75 }}>{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={{ fontSize: 10, opacity: 0.55, width: 30, textAlign: "right" }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}
