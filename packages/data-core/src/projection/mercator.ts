// Web Mercator (EPSG:3857) metric utilities.
// Pure functions, no state, safe in workers, main thread, and Node.

export const EARTH_RADIUS_M = 6378137;
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;
export const ORIGIN_SHIFT = EARTH_CIRCUMFERENCE_M / 2;

export interface LonLat {
  lon: number;
  lat: number;
}

export interface Meters {
  x: number;
  y: number;
}

export interface TileXY {
  z: number;
  x: number;
  y: number;
}

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MetersBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MAX_LAT = 85.05112877980659;

export function clampLat(lat: number): number {
  if (lat > MAX_LAT) return MAX_LAT;
  if (lat < -MAX_LAT) return -MAX_LAT;
  return lat;
}

export function lonLatToMeters(lon: number, lat: number): Meters {
  const x = lon * D2R * EARTH_RADIUS_M;
  const clamped = clampLat(lat);
  const y = Math.log(Math.tan(Math.PI / 4 + (clamped * D2R) / 2)) * EARTH_RADIUS_M;
  return { x, y };
}

export function metersToLonLat(x: number, y: number): LonLat {
  const lon = (x / EARTH_RADIUS_M) * R2D;
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * R2D;
  return { lon, lat };
}

export function tileSizeMeters(z: number): number {
  return EARTH_CIRCUMFERENCE_M / Math.pow(2, z);
}

export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  const x = ((lon + 180) / 360) * n;
  const latRad = clampLat(lat) * D2R;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function tileToLonLat(x: number, y: number, z: number): LonLat {
  const n = Math.pow(2, z);
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: latRad * R2D };
}

export function tileMetersBox(z: number, x: number, y: number): MetersBox {
  const n = Math.pow(2, z);
  const size = EARTH_CIRCUMFERENCE_M / n;
  const minX = -ORIGIN_SHIFT + x * size;
  const maxX = minX + size;
  const maxY = ORIGIN_SHIFT - y * size;
  const minY = maxY - size;
  return { minX, minY, maxX, maxY };
}

export function tileLocalToMeters(
  tileBox: MetersBox,
  extent: number,
  lx: number,
  ly: number,
): Meters {
  const size = tileBox.maxX - tileBox.minX;
  const x = tileBox.minX + (lx / extent) * size;
  const y = tileBox.maxY - (ly / extent) * size;
  return { x, y };
}

export function bboxToTiles(bbox: BBox, z: number): TileXY[] {
  const nw = lonLatToTile(bbox.west, bbox.north, z);
  const se = lonLatToTile(bbox.east, bbox.south, z);
  const minX = Math.floor(Math.min(nw.x, se.x));
  const maxX = Math.floor(Math.max(nw.x, se.x));
  const minY = Math.floor(Math.min(nw.y, se.y));
  const maxY = Math.floor(Math.max(nw.y, se.y));
  const out: TileXY[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      out.push({ z, x, y });
    }
  }
  return out;
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

export function parseTileKey(key: string): TileXY {
  const [z, x, y] = key.split("/").map(Number);
  return { z, x, y };
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
