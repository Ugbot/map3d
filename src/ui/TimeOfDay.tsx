import { Play, Pause, Sun, Moon } from "lucide-react";
import { useTimeStore } from "@/state/timeStore";

export function TimeOfDay() {
  const hour = useTimeStore((s) => s.hour);
  const set = useTimeStore((s) => s.set);
  const autoplay = useTimeStore((s) => s.autoplay);
  const toggle = useTimeStore((s) => s.toggleAutoplay);
  const speed = useTimeStore((s) => s.speed);
  const setSpeed = useTimeStore((s) => s.setSpeed);

  const isDay = hour > 6 && hour < 18;
  const hh = Math.floor(hour);
  const mm = Math.floor((hour - hh) * 60);

  return (
    <div
      className="premium-card"
      style={{
        width: 280,
        padding: 14,
        background: "rgba(20, 22, 34, 0.92)",
        color: "#f1f5f9",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        {isDay ? <Sun size={14} color="#fbbf24" /> : <Moon size={14} color="#a5b4fc" />}
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          {String(hh).padStart(2, "0")}:{String(mm).padStart(2, "0")}
        </div>
        <button
          onClick={toggle}
          style={{
            marginLeft: "auto",
            background: "transparent",
            color: "#cbd5e1",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 6,
            padding: "4px 8px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
          }}
        >
          {autoplay ? <Pause size={12} /> : <Play size={12} />}
          {autoplay ? "Pause" : "Auto"}
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={24}
        step={0.05}
        value={hour}
        onChange={(e) => set(parseFloat(e.target.value))}
        style={{ width: "100%" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11, opacity: 0.7 }}>
        <span>Speed</span>
        <input
          type="range"
          min={0.05}
          max={4}
          step={0.05}
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
        <span>{speed.toFixed(2)}×</span>
      </div>
    </div>
  );
}
