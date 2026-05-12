import { css, Global } from "@emotion/react";
import { Space } from "../three/Space";
import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Globe,
  Map as MapIcon,
  Database,
  Layers,
  Github,
} from "lucide-react";
import { useAreaStore } from "@/state/areaStore";
import { MapComponent } from "@/components/map/SelectMap";
import { BuildingHeights } from "@/components/map/Processing";
import { useCityStore } from "@/state/cityStore";
import { LayerPanel } from "@/ui/LayerPanel";
import { TimeOfDay } from "@/ui/TimeOfDay";

interface LatLng {
  lat: number;
  lng: number;
}

const App = () => {
  const [step, setStep] = useState(0);
  const isReady = useCityStore((state) => state.isReady);
  const [areaData, setAreaData] = useState<LatLng[]>([]);
  const setCenter = useAreaStore((state) => state.setCenter);

  const steps = [
    { title: "Select Area", icon: <MapIcon size={18} />, description: "Select a location on the map" },
    { title: "Process Data", icon: <Database size={18} />, description: "Lock area for streaming" },
    { title: "View 3D", icon: <Layers size={18} />, description: "Explore the streaming digital twin" },
  ];

  const handleDone = (data: LatLng[]) => {
    setAreaData(data);
    setCenter(data);
  };

  const handleRemove = () => {
    setAreaData([]);
  };

  const prevStep = () => {
    if (step > 0) setStep(step - 1);
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
          }
          .btn-secondary {
            background: white;
            color: #1e293b;
            border: 1px solid rgba(0, 0, 0, 0.1);
            padding: 12px 24px;
          }
        `}
      />

      {/* Wizard sidebar (steps 0/1) */}
      {step < 2 && (
        <div
          className="panel premium-card"
          style={{
            top: "32px",
            left: "32px",
            width: "400px",
            maxHeight: "calc(100vh - 64px)",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "24px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ background: "var(--primary)", padding: "10px", borderRadius: "12px" }}>
                <Globe size={24} color="white" />
              </div>
              <div>
                <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>Map3D Streaming</h1>
                <p style={{ margin: 0, fontSize: "12px", opacity: 0.6 }}>
                  Layered digital-twin viewer
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
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                background: "#f8fafc",
                border: "1px solid rgba(0,0,0,0.05)",
                color: "#1e293b",
              }}
            >
              <Github size={20} />
            </a>
          </div>

          <div className="step-indicator">
            {steps.map((s, i) => (
              <div key={i} className={`step-dot ${i === step ? "active" : ""}`} />
            ))}
          </div>

          <h2 style={{ fontSize: "18px", fontWeight: 600, marginBottom: "8px" }}>
            {steps[step].title}
          </h2>
          <p style={{ fontSize: "14px", opacity: 0.7, marginBottom: "24px" }}>
            {steps[step].description}
          </p>

          <div style={{ marginBottom: "32px" }}>
            {step === 0 && <MapComponent onRemove={handleRemove} onDone={handleDone} />}
            {step === 1 && <BuildingHeights area={areaData} />}
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            {step > 0 && (
              <button className="btn-secondary" onClick={prevStep} style={{ flex: 1 }}>
                <ChevronLeft size={18} /> Back
              </button>
            )}
            <button
              className="btn-premium"
              onClick={() => setStep(step + 1)}
              disabled={(step === 0 && areaData.length === 0) || (step === 1 && !isReady)}
              style={{
                flex: 2,
                opacity: (step === 0 && areaData.length === 0) || (step === 1 && !isReady) ? 0.5 : 1,
              }}
            >
              {step === 1 ? "Enter 3D" : "Continue"} <ChevronRight size={18} />
            </button>
          </div>
        </div>
      )}

      {/* 3D View overlay */}
      {step === 2 && (
        <>
          <div className="panel" style={{ top: "32px", left: "32px" }}>
            <button
              className="btn-secondary premium-card"
              onClick={() => setStep(1)}
              style={{ padding: "12px 20px", display: "flex", alignItems: "center", gap: "8px" }}
            >
              <ChevronLeft size={18} /> Edit Map
            </button>
          </div>

          <div className="panel" style={{ top: "32px", right: "32px" }}>
            <LayerPanel />
          </div>

          <div className="panel" style={{ bottom: "32px", left: "50%", transform: "translateX(-50%)" }}>
            <TimeOfDay />
          </div>
        </>
      )}

      <Space />
    </div>
  );
};

export default App;
