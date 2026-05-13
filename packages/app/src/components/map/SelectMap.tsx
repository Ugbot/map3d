import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  Marker,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Crosshair, Search } from "lucide-react";
import { useAreaStore, type PickedLocation } from "@/state/areaStore";

// Fix Leaflet default-icon issue under Vite.
const pinIcon = L.divIcon({
  className: "map3d-pin",
  html: `<div style="
    width: 22px; height: 22px;
    border-radius: 50% 50% 50% 0;
    background: #ff7849;
    border: 3px solid #fff;
    box-shadow: 0 4px 10px rgba(0,0,0,0.35);
    transform: rotate(-45deg);
    transform-origin: 50% 50%;
  "></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 22],
});

function ClickHandler({ onPick }: { onPick: (p: PickedLocation) => void }) {
  useMapEvents({
    click(e) {
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

function FlyTo({ target }: { target: PickedLocation | null }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    map.flyTo([target.lat, target.lng], Math.max(13, map.getZoom()), { duration: 0.6 });
  }, [target, map]);
  return null;
}

export function MapComponent({
  onDone,
  onRemove,
}: {
  onDone: (p: PickedLocation) => void;
  onRemove: () => void;
}) {
  const pick = useAreaStore((s) => s.pick);
  const setPick = useAreaStore((s) => s.setPick);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);

  // Emit the default pin so the wizard "next" button enables immediately.
  useEffect(() => {
    if (pick) onDone(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePick = (p: PickedLocation) => {
    setPick(p);
    onDone(p);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`,
        { signal: controller.signal, headers: { Accept: "application/json" } },
      );
      const arr = (await res.json()) as { lat: string; lon: string; display_name: string }[];
      if (arr.length > 0) {
        const r = arr[0];
        handlePick({
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lon),
          label: r.display_name,
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.warn("geocode failed", err);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <form
        onSubmit={handleSearch}
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 10,
          alignItems: "center",
        }}
      >
        <div style={{ position: "relative", flex: 1 }}>
          <Search
            size={14}
            style={{ position: "absolute", left: 10, top: 11, color: "#94a3b8" }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a place (e.g. 'Yas Island', 'Tokyo')"
            style={{
              width: "100%",
              padding: "8px 8px 8px 30px",
              borderRadius: 8,
              border: "1px solid rgba(0,0,0,0.1)",
              fontSize: 13,
              outline: "none",
            }}
          />
        </div>
        <button
          type="submit"
          disabled={searching}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "none",
            background: "var(--primary)",
            color: "white",
            cursor: searching ? "wait" : "pointer",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {searching ? "…" : "Go"}
        </button>
      </form>

      <MapContainer
        center={pick ? [pick.lat, pick.lng] : [24.4539, 54.3773]}
        zoom={13}
        style={{
          height: 360,
          width: "100%",
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid rgba(0,0,0,0.1)",
        }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickHandler onPick={handlePick} />
        <FlyTo target={pick} />
        {pick && <Marker position={[pick.lat, pick.lng]} icon={pinIcon} />}
      </MapContainer>

      <div
        style={{
          marginTop: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          opacity: 0.75,
        }}
      >
        <Crosshair size={14} />
        {pick ? (
          <span>
            {pick.label ?? "Pinned"} &nbsp;
            <code style={{ fontSize: 11, opacity: 0.7 }}>
              {pick.lat.toFixed(5)}, {pick.lng.toFixed(5)}
            </code>
          </span>
        ) : (
          <span>Click anywhere on the map to drop a pin.</span>
        )}
        {pick && (
          <button
            onClick={() => {
              setPick(null);
              onRemove();
            }}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "1px solid rgba(0,0,0,0.1)",
              borderRadius: 6,
              padding: "3px 8px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
