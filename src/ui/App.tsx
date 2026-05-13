import { css, Global } from "@emotion/react";
import { Space } from "../three/Space";
import { useState } from "react";
import { ChevronRight, Globe, MapPin, Github, X } from "lucide-react";
import { useAreaStore, type PickedLocation } from "@/state/areaStore";
import { MapComponent } from "@/components/map/SelectMap";
import { useCityStore } from "@/state/cityStore";
import { LayerPanel } from "@/ui/LayerPanel";
import { TimeOfDay } from "@/ui/TimeOfDay";
import { ProviderPicker } from "@/ui/ProviderPicker";

const App = () => {
  const isReady = useCityStore((s) => s.isReady);
  const pick = useAreaStore((s) => s.pick);
  const setPick = useAreaStore((s) => s.setPick);
  const setReady = useCityStore((s) => s.setReady);
  const [overlayOpen, setOverlayOpen] = useState(false);

  const handleDone = (p: PickedLocation) => {
    setPick(p);
  };
  const handleRemove = () => {
    setPick(null);
  };

  const enter3D = () => {
    if (pick) setReady(true);
  };

  return (
    <div style={{ height: "100vh", width: "100vw", position: "relative", background: "#0b1020" }}>
      <Global
        styles={css`
          .panel {
            position: absolute;
            z-index: 100;
            pointer-events: all;
          }
          .btn-premium {
            background: var(--primary);
            color: white;
            border: none;
            padding: 12px 24px;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 4px 12px rgba(0, 122, 255, 0.2);
            cursor: pointer;
          }
          .btn-secondary {
            background: rgba(20, 22, 34, 0.92);
            color: #e2e8f0;
            border: 1px solid rgba(255, 255, 255, 0.12);
            padding: 10px 16px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            backdrop-filter: blur(12px);
            font-size: 13px;
          }
          .btn-secondary:hover {
            background: rgba(30, 34, 50, 0.95);
          }
        `}
      />

      {/* Pick mode — picker fills the viewport. */}
      {!isReady && (
        <div
          className="panel premium-card"
          style={{
            top: 32,
            left: 32,
            width: 480,
            maxHeight: "calc(100vh - 64px)",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ background: "var(--primary)", padding: 10, borderRadius: 12 }}>
                <Globe size={22} color="white" />
              </div>
              <div>
                <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>Map3D</h1>
                <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }}>
                  Streaming digital-twin viewer
                </p>
              </div>
            </div>
            <a
              href="https://github.com/cartesiancs/map3d"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: "#f8fafc",
                border: "1px solid rgba(0,0,0,0.05)",
                color: "#1e293b",
              }}
            >
              <Github size={18} />
            </a>
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
            <MapPin size={16} /> Pick a starting location
          </h2>
          <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
            Click anywhere on the map or search for a place. The 3D scene will stream around it.
          </p>

          <MapComponent onRemove={handleRemove} onDone={handleDone} />

          <div style={{ marginTop: 16 }}>
            <ProviderPicker />
          </div>

          <button
            className="btn-premium"
            onClick={enter3D}
            disabled={!pick}
            style={{
              width: "100%",
              marginTop: 16,
              padding: "14px 24px",
              borderRadius: 10,
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 14,
              opacity: pick ? 1 : 0.5,
              cursor: pick ? "pointer" : "not-allowed",
            }}
          >
            Enter 3D <ChevronRight size={18} />
          </button>
        </div>
      )}

      {/* Viewing mode — engine renders, overlays around it. */}
      {isReady && (
        <>
          <div className="panel" style={{ top: 32, left: 32 }}>
            <button
              className="btn-secondary"
              onClick={() => setOverlayOpen(true)}
              title="Pick a new location"
            >
              <MapPin size={14} /> New location
            </button>
          </div>

          <div className="panel" style={{ top: 32, right: 32 }}>
            <LayerPanel />
          </div>

          <div
            className="panel"
            style={{ bottom: 32, left: "50%", transform: "translateX(-50%)" }}
          >
            <TimeOfDay />
          </div>

          {overlayOpen && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(11, 16, 32, 0.75)",
                backdropFilter: "blur(8px)",
                zIndex: 200,
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                paddingTop: 80,
              }}
            >
              <div
                className="premium-card"
                style={{
                  width: 520,
                  padding: 20,
                  position: "relative",
                  pointerEvents: "all",
                }}
              >
                <button
                  onClick={() => setOverlayOpen(false)}
                  style={{
                    position: "absolute",
                    top: 12,
                    right: 12,
                    background: "transparent",
                    border: "none",
                    color: "#64748b",
                    cursor: "pointer",
                  }}
                  aria-label="close"
                >
                  <X size={18} />
                </button>
                <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
                  Pick a new location
                </h2>
                <MapComponent onRemove={handleRemove} onDone={handleDone} />
                <button
                  className="btn-premium"
                  onClick={() => setOverlayOpen(false)}
                  style={{
                    width: "100%",
                    marginTop: 14,
                    padding: "12px 18px",
                    borderRadius: 10,
                    justifyContent: "center",
                  }}
                >
                  Go <ChevronRight size={18} />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <Space />
    </div>
  );
};

export default App;
