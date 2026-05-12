import { describe, it, expect } from "vitest";
import {
  lonLatToMeters,
  metersToLonLat,
  lonLatToTile,
  tileToLonLat,
  tileMetersBox,
  tileLocalToMeters,
  bboxToTiles,
  EARTH_CIRCUMFERENCE_M,
} from "../mercator";

const MAX_LAT = 85.05112877980659;
function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

describe("mercator round-trip", () => {
  it("lonLat -> meters -> lonLat is within 1e-9 deg over 5000 random points", () => {
    for (let i = 0; i < 5000; i++) {
      const lon = rand(-180, 180);
      const lat = rand(-MAX_LAT + 0.01, MAX_LAT - 0.01);
      const m = lonLatToMeters(lon, lat);
      const back = metersToLonLat(m.x, m.y);
      expect(Math.abs(back.lon - lon)).toBeLessThan(1e-9);
      expect(Math.abs(back.lat - lat)).toBeLessThan(1e-9);
    }
  });

  it("tile <-> lonLat round-trip across zoom 0..18", () => {
    for (let i = 0; i < 2000; i++) {
      const z = Math.floor(rand(0, 19));
      const n = Math.pow(2, z);
      const tx = rand(0, n);
      const ty = rand(0, n);
      const ll = tileToLonLat(tx, ty, z);
      const back = lonLatToTile(ll.lon, ll.lat, z);
      expect(Math.abs(back.x - tx)).toBeLessThan(1e-6);
      expect(Math.abs(back.y - ty)).toBeLessThan(1e-6);
    }
  });
});

describe("tile boxes", () => {
  it("z=0 single tile spans the full mercator square", () => {
    const b = tileMetersBox(0, 0, 0);
    expect(b.minX).toBeCloseTo(-EARTH_CIRCUMFERENCE_M / 2, 1);
    expect(b.maxX).toBeCloseTo(EARTH_CIRCUMFERENCE_M / 2, 1);
    expect(b.maxY).toBeCloseTo(EARTH_CIRCUMFERENCE_M / 2, 1);
    expect(b.minY).toBeCloseTo(-EARTH_CIRCUMFERENCE_M / 2, 1);
  });

  it("tile boxes at z=10 are contiguous", () => {
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(rand(0, 1023));
      const y = Math.floor(rand(0, 1023));
      const a = tileMetersBox(10, x, y);
      const right = tileMetersBox(10, x + 1, y);
      const below = tileMetersBox(10, x, y + 1);
      expect(a.maxX).toBeCloseTo(right.minX, 3);
      expect(a.minY).toBeCloseTo(below.maxY, 3);
    }
  });

  it("tileLocalToMeters maps (0,0) to NW corner and (extent,extent) to SE corner", () => {
    const box = tileMetersBox(12, 100, 200);
    const nw = tileLocalToMeters(box, 4096, 0, 0);
    const se = tileLocalToMeters(box, 4096, 4096, 4096);
    expect(nw.x).toBeCloseTo(box.minX, 3);
    expect(nw.y).toBeCloseTo(box.maxY, 3);
    expect(se.x).toBeCloseTo(box.maxX, 3);
    expect(se.y).toBeCloseTo(box.minY, 3);
  });
});

describe("bboxToTiles", () => {
  it("covers at least one tile and is rectangular", () => {
    for (let i = 0; i < 100; i++) {
      const w = rand(-179, 179);
      const e = w + rand(0.01, 1);
      const s = rand(-MAX_LAT + 1, MAX_LAT - 2);
      const n = s + rand(0.01, 1);
      const tiles = bboxToTiles({ west: w, south: s, east: e, north: n }, 14);
      expect(tiles.length).toBeGreaterThan(0);
      const xs = new Set(tiles.map((t) => t.x));
      const ys = new Set(tiles.map((t) => t.y));
      expect(tiles.length).toBe(xs.size * ys.size);
    }
  });
});
