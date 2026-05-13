// Procedural road & rail surface textures. Generated once at engine init
// from a 2D canvas. The U axis spans the road's width (clamped, no repeat);
// the V axis is repeated along the road's length so dashes recur naturally.
//
// One texture covers every road class — physical width (motorway 48 m vs
// residential 14 m) does the hierarchy work. Edges and centre line scale
// proportionally with the road width.

import * as THREE from "three";

function ctx2d(w: number, h: number) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  return { cv, ctx: cv.getContext("2d")! };
}

// One V period of the texture = 8 m of road length. Dashes recur every 4 m.
export const ROAD_TEXTURE_LENGTH_M = 8;
export const ROAD_SIDE_UV = { u: 0.5, v: 0.0 };

let _roadCache: THREE.CanvasTexture | null = null;
export function roadTexture(): THREE.CanvasTexture {
  if (_roadCache) return _roadCache;
  const W = 256;
  const H = 64;
  const { cv, ctx } = ctx2d(W, H);

  // Asphalt base
  ctx.fillStyle = "#1f2024";
  ctx.fillRect(0, 0, W, H);

  // Subtle asphalt grain (random darker pixels)
  ctx.fillStyle = "#181a1d";
  for (let i = 0; i < W * H * 0.04; i++) {
    const x = Math.floor(Math.random() * W);
    const y = Math.floor(Math.random() * H);
    ctx.fillRect(x, y, 1, 1);
  }

  // White edge stripes — 4 px each
  const edgePx = 5;
  ctx.fillStyle = "#e6e2d4";
  ctx.fillRect(0, 0, edgePx, H);
  ctx.fillRect(W - edgePx, 0, edgePx, H);

  // Double yellow centre (4 px gap between two 2 px stripes)
  const cx = W / 2;
  ctx.fillStyle = "#f6c43c";
  ctx.fillRect(cx - 4, 0, 2, H);
  ctx.fillRect(cx + 2, 0, 2, H);

  // One dashed white lane divider each side of centre, halfway between
  // centre and edge. Dash 32 px, gap 32 px.
  ctx.fillStyle = "#e6e2d4";
  const halfBody = (W - edgePx * 2) / 2;
  const divOffsets = [-halfBody / 2, halfBody / 2];
  for (const off of divOffsets) {
    const ux = Math.round(cx + off) - 1;
    for (let y = 0; y < H; y += 32) {
      ctx.fillRect(ux, y, 2, 16);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  _roadCache = tex;
  return tex;
}

// ────────────────────────────────────────────────────────────────────────────
// Rail texture — two parallel pale rails on dark ballast with wooden sleepers.
// ────────────────────────────────────────────────────────────────────────────

export const RAIL_TEXTURE_LENGTH_M = 4;
export const RAIL_SIDE_UV = { u: 0.5, v: 0.0 };

let _railCache: THREE.CanvasTexture | null = null;
export function railTexture(): THREE.CanvasTexture {
  if (_railCache) return _railCache;
  const W = 128;
  const H = 64;
  const { cv, ctx } = ctx2d(W, H);

  // Ballast base
  ctx.fillStyle = "#1d1924";
  ctx.fillRect(0, 0, W, H);
  // Ballast grain
  ctx.fillStyle = "#15101c";
  for (let i = 0; i < W * H * 0.05; i++) {
    const x = Math.floor(Math.random() * W);
    const y = Math.floor(Math.random() * H);
    ctx.fillRect(x, y, 1, 1);
  }
  // Lateral wood sleepers — full width, repeating
  ctx.fillStyle = "#382f2c";
  const sleeperH = 8;
  const sleeperGap = 16;
  for (let y = 0; y < H; y += sleeperH + sleeperGap) {
    ctx.fillRect(0, y, W, sleeperH);
  }
  // Two parallel rails (pale steel)
  ctx.fillStyle = "#c8b8d4";
  const railW = 4;
  const lU = Math.round(W * 0.3) - railW / 2;
  const rU = Math.round(W * 0.7) - railW / 2;
  ctx.fillRect(lU, 0, railW, H);
  ctx.fillRect(rU, 0, railW, H);
  // Subtle highlight along the top of each rail
  ctx.fillStyle = "#e6dcf0";
  ctx.fillRect(lU + 1, 0, 2, H);
  ctx.fillRect(rU + 1, 0, 2, H);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  _railCache = tex;
  return tex;
}
