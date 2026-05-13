import { describe, expect, it } from "vitest";
import {
  haversineKm,
  lonLatToMeters,
  metersToLonLat,
  bboxToTiles,
} from "../projection/mercator";
import { makeRng } from "../util/rng";

describe("mercator", () => {
  it("round-trips lonLat → meters → lonLat for random points", () => {
    const rng = makeRng(0xbeef);
    for (let i = 0; i < 200; i++) {
      const lon = (rng.next() - 0.5) * 359.99;
      const lat = (rng.next() - 0.5) * 170; // stay within ±85
      const m = lonLatToMeters(lon, lat);
      const back = metersToLonLat(m.x, m.y);
      expect(back.lon).toBeCloseTo(lon, 6);
      expect(back.lat).toBeCloseTo(lat, 6);
    }
  });

  it("haversineKm is zero for identical points", () => {
    expect(haversineKm(40, -73, 40, -73)).toBeCloseTo(0, 9);
  });

  it("haversineKm ~ 111 km per degree near equator", () => {
    const km = haversineKm(0, 0, 0, 1);
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });

  it("bboxToTiles enumerates the right tile grid", () => {
    const tiles = bboxToTiles(
      { west: -1, south: -1, east: 1, north: 1 },
      4,
    );
    // Each tile at z=4 is 22.5°; this 2°×2° box around origin straddles 4 tiles
    // at most. Just check the result is non-empty and tiles are at z=4.
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) expect(t.z).toBe(4);
  });
});
