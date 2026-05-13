// Pure solar lighting math. No three.js or DOM dependencies — renderers wrap
// this to drive their own light objects.
//
// Hour 0..24, no axial tilt: noon at 12, sunrise/sunset at 6/18.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface SunState {
  /** sin(elevation) in [-1, 1]. >0 = above horizon. */
  altitude: number;
  /** cos(elevation) used as a horizontal sun direction component. */
  azimuth: number;
  /** Sun world position (scene metres) for renderers that want to place a light. */
  position: { x: number; y: number; z: number };
  /** Directional-light colour in linear 0..1 floats. */
  directional: RGB;
  /** Directional-light intensity (renderer-relative). */
  directionalIntensity: number;
  /** Ambient hemisphere top colour. */
  ambientSky: RGB;
  /** Ambient hemisphere bottom colour. */
  ambientGround: RGB;
  /** Ambient hemisphere intensity (renderer-relative). */
  ambientIntensity: number;
  /** Horizon colour useful for fog / sky bottom. */
  horizon: RGB;
  /** Zenith colour useful for sky top. */
  zenith: RGB;
}

const SHADOW_LIGHT_RADIUS = 2000;

export function computeSun(hour: number): SunState {
  const t = ((hour - 6) / 12) * Math.PI;
  const alt = Math.sin(t);
  const az = Math.cos(t);
  const day = Math.max(0, alt);
  const dawnK = Math.max(0, 1 - Math.abs(alt) * 4);
  const cityGlow = (1 - day) * 0.6;

  const directional: RGB = {
    r: Math.min(1, 1.0 + dawnK * 0.1),
    g: Math.min(1, 0.95 - dawnK * 0.25),
    b: Math.min(1, 0.85 - dawnK * 0.55),
  };

  const skyTopHex = lerpHex(0x161a2a, 0x88b8e8, day);
  const skyTopWithGlow = lerpHex(skyTopHex, 0x9a6a3a, cityGlow * 0.25);
  const skyHorizonHex = lerpHex(0x1a1626, 0xe8c39c, Math.min(1, day + dawnK));
  const groundHex = lerpHex(0x2e2922, 0x3a3338, day);

  return {
    altitude: alt,
    azimuth: az,
    position: {
      x: az * SHADOW_LIGHT_RADIUS,
      y: Math.max(0.02, alt) * SHADOW_LIGHT_RADIUS,
      z: SHADOW_LIGHT_RADIUS * 0.4,
    },
    directional,
    directionalIntensity: 0.1 + day * 2.6,
    ambientSky: hexToRgb(skyTopWithGlow),
    ambientGround: hexToRgb(groundHex),
    ambientIntensity: 0.7 + day * 0.45,
    horizon: hexToRgb(skyHorizonHex),
    zenith: hexToRgb(skyTopWithGlow),
  };
}

export function hexToRgb(hex: number): RGB {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
  };
}

export function rgbToHex(c: RGB): number {
  const r = Math.max(0, Math.min(255, Math.round(c.r * 255)));
  const g = Math.max(0, Math.min(255, Math.round(c.g * 255)));
  const b = Math.max(0, Math.min(255, Math.round(c.b * 255)));
  return (r << 16) | (g << 8) | b;
}

function lerpHex(aHex: number, bHex: number, t: number): number {
  const ar = (aHex >> 16) & 0xff;
  const ag = (aHex >> 8) & 0xff;
  const ab = aHex & 0xff;
  const br = (bHex >> 16) & 0xff;
  const bg = (bHex >> 8) & 0xff;
  const bb = bHex & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | b;
}
