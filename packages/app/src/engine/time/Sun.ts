// Solar lighting + sky. Drives:
//   - directional light position/intensity/colour
//   - hemisphere ambient
//   - Sky.js shader sunPosition uniform
//   - exposes a horizon colour so the engine can sync fog
//
// Hour 0..24, no axial tilt, "high noon" at 12, sunrise/sunset at 6/18.

import * as THREE from "three";

export class Sun {
  readonly dir = new THREE.DirectionalLight(0xffffff, 1.0);
  readonly ambient = new THREE.HemisphereLight(0xb0c4ff, 0x202028, 0.4);
  altitude = 1;
  azimuth = 0;
  horizonColor = new THREE.Color(0x88aacc);
  zenithColor = new THREE.Color(0x6090d0);
  ambientSky = new THREE.Color(0xb0c4ff);

  constructor(scene: THREE.Scene) {
    this.dir.position.set(500, 1000, 200);
    this.dir.target.position.set(0, 0, 0);
    this.dir.castShadow = true;
    this.dir.shadow.mapSize.set(2048, 2048);
    this.dir.shadow.bias = -0.0005;
    this.dir.shadow.normalBias = 0.04;
    this.dir.shadow.camera.near = 0.5;
    this.dir.shadow.camera.far = 3000;
    const SHADOW_HALF = 1800; // metres — 3.6 km square
    this.dir.shadow.camera.left = -SHADOW_HALF;
    this.dir.shadow.camera.right = SHADOW_HALF;
    this.dir.shadow.camera.top = SHADOW_HALF;
    this.dir.shadow.camera.bottom = -SHADOW_HALF;
    scene.add(this.dir);
    scene.add(this.dir.target);
    scene.add(this.ambient);
    // The atmospheric Sky shader is WebGL-only (raw ShaderMaterial). We now
    // drive `scene.background` directly from this Sun's horizon/zenith mix;
    // Stage 1c will reinstate a TSL node-material sky.
    void scene;
  }

  update(hour: number) {
    // Treat solar elevation as a clean sine: noon = up, 6/18 = horizon, night = below.
    const t = ((hour - 6) / 12) * Math.PI;
    const alt = Math.sin(t);
    const az = Math.cos(t);
    this.altitude = alt;
    this.azimuth = az;

    const radius = 2000;
    this.dir.position.set(az * radius, Math.max(0.02, alt) * radius, radius * 0.4);

    const day = Math.max(0, alt);
    const dawnK = Math.max(0, 1 - Math.abs(alt) * 4); // 1 at horizon, 0 high or deep

    // Directional colour: white at noon, warm at golden hour, cool below horizon.
    this.dir.color.setRGB(
      Math.min(1, 1.0 + dawnK * 0.1),
      Math.min(1, 0.95 - dawnK * 0.25),
      Math.min(1, 0.85 - dawnK * 0.55),
    );
    this.dir.intensity = 0.1 + day * 2.6;

    // Hemisphere ambient — sky/ground colours track sun.
    // Night minimum lifted so the scene reads as urban dusk, not lights-out.
    // Sky hex is tinted with a faint warm "city glow" component when the sun
    // is below the horizon (you can see it on overcast nights from any city).
    const cityGlow = (1 - day) * 0.6;
    const skyTopHex = lerpHex(0x161a2a, 0x88b8e8, day);
    const skyTopWithGlow = lerpHex(skyTopHex, 0x9a6a3a, cityGlow * 0.25);
    const skyHorizonHex = lerpHex(0x1a1626, 0xe8c39c, Math.min(1, day + dawnK));
    // Hemisphere ground: cool grey by day, warm sodium-orange at night (the
    // colour real cities reflect back up toward the sky). Lifts the bottoms
    // of buildings without faking real point lights.
    const groundHex = lerpHex(0x2e2922, 0x3a3338, day);
    this.ambient.color.setHex(skyTopWithGlow);
    this.ambient.groundColor.setHex(groundHex);
    // Night floor pushed up so the city reads as twilight, not midnight.
    this.ambient.intensity = 0.7 + day * 0.45;
    this.ambientSky.setHex(skyTopWithGlow);
    this.horizonColor.setHex(skyHorizonHex);
    this.zenithColor.setHex(skyTopWithGlow);
  }
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
