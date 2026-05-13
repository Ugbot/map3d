// Solar lighting + sky. Drives:
//   - directional light position/intensity/colour
//   - hemisphere ambient
//   - Sky.js shader sunPosition uniform
//   - exposes a horizon colour so the engine can sync fog
//
// Hour 0..24, no axial tilt, "high noon" at 12, sunrise/sunset at 6/18.

import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

export class Sun {
  readonly dir = new THREE.DirectionalLight(0xffffff, 1.0);
  readonly ambient = new THREE.HemisphereLight(0xb0c4ff, 0x202028, 0.4);
  readonly sky: Sky;
  altitude = 1;
  azimuth = 0;
  horizonColor = new THREE.Color(0x88aacc);
  ambientSky = new THREE.Color(0xb0c4ff);

  private sunVec = new THREE.Vector3();

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

    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 8;
    u.rayleigh.value = 2.2;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    scene.add(this.sky);
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
    const skyTopHex = lerpHex(0x0a1024, 0x88b8e8, day);
    const skyHorizonHex = lerpHex(0x0a1024, 0xe8c39c, Math.min(1, day + dawnK));
    this.ambient.color.setHex(skyTopHex);
    this.ambient.groundColor.setHex(day > 0 ? 0x303338 : 0x080812);
    this.ambient.intensity = 0.18 + day * 0.85;
    this.ambientSky.setHex(skyTopHex);
    this.horizonColor.setHex(skyHorizonHex);

    // Sky shader sunPosition (unit vector).
    // Sky.js uses Y-up world space.
    this.sunVec.set(Math.cos(t), Math.sin(t), 0.4).normalize();
    this.sky.material.uniforms.sunPosition.value.copy(this.sunVec);

    // Dynamic Sky tuning: at night, drop turbidity so we get a dark sky.
    this.sky.material.uniforms.turbidity.value = 6 + day * 4;
    this.sky.material.uniforms.rayleigh.value = 1.2 + day * 1.6;
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
