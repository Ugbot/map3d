import { Database } from "lucide-react";
import { ALL_PROVIDERS, useProviderStore } from "@/state/providerStore";

export function ProviderPicker() {
  const id = useProviderStore((s) => s.id);
  const setId = useProviderStore((s) => s.setId);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <Database size={11} style={{ opacity: 0.6 }} />
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, opacity: 0.7, textTransform: "uppercase" }}>
          Tile source
        </span>
      </div>
      <select
        value={id}
        onChange={(e) => setId(e.target.value)}
        style={{
          width: "100%",
          background: "rgba(255,255,255,0.06)",
          color: "#e2e8f0",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 6,
          padding: "6px 8px",
          fontSize: 12,
          outline: "none",
        }}
      >
        {ALL_PROVIDERS.map((p) => (
          <option key={p.id} value={p.id} style={{ background: "#1a1d28", color: "#e2e8f0" }}>
            {p.label}
          </option>
        ))}
      </select>
    </div>
  );
}
