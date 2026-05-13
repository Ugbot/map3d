import { useEffect, useState } from "react";
import type { Engine } from "@/engine/Engine";
import { useProviderStore } from "@/state/providerStore";

interface Stats {
  tilesLoaded: number;
  tilesInflight: number;
  hour: number;
  sunAltitude: number;
  cameraY: number;
  aircraftCount: number;
  vesselCount: number;
  feedStatus: Record<string, { connected: boolean; lastUpdateTs: number; reason?: string }>;
}

export function DebugHUD({ engine }: { engine: Engine | null }) {
  const provider = useProviderStore((s) => s.provider);
  const [stats, setStats] = useState<Stats>({
    tilesLoaded: 0,
    tilesInflight: 0,
    hour: 12,
    sunAltitude: 0,
    cameraY: 0,
    aircraftCount: 0,
    vesselCount: 0,
    feedStatus: {},
  });
  useEffect(() => {
    if (!engine) return;
    // 4 Hz — anything faster is HUD jitter, and 60 Hz setState was a chunky
    // chunk of per-frame React reconciliation.
    const id = setInterval(() => setStats(engine.stats()), 250);
    return () => clearInterval(id);
  }, [engine]);

  const aisStatus = stats.feedStatus.aisstream;
  const vesselsLine =
    aisStatus?.reason === "no-key"
      ? "vessels (no key)"
      : `vessels ${stats.vesselCount}`;

  return (
    <div
      style={{
        position: "absolute",
        top: 32,
        left: 200,
        padding: "8px 12px",
        background: "rgba(20, 22, 34, 0.88)",
        color: "#cbd5e1",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        fontSize: 11,
        fontFamily: "ui-monospace, monospace",
        lineHeight: 1.6,
        zIndex: 100,
        pointerEvents: "none",
        backdropFilter: "blur(10px)",
      }}
    >
      <div style={{ opacity: 0.7 }}>{provider.label}</div>
      <div>
        tiles {stats.tilesLoaded} loaded · {stats.tilesInflight} inflight
      </div>
      <div>
        sun {(stats.sunAltitude * 90).toFixed(0)}° · cam y {stats.cameraY.toFixed(0)} m
      </div>
      <div>
        aircraft {stats.aircraftCount} · {vesselsLine}
      </div>
    </div>
  );
}
