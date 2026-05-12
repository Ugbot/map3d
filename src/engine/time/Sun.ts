// Crude solar lighting model. Good enough to sell day/night.
// Hour 0..24 → sun azimuth + altitude, drives directional light + ambient.

import * as THREE from "three";

export class Sun {
  readonly dir = new THREE.DirectionalLight(0xffffff, 1.0);
  readonly ambient = new THREE.HemisphereLight(0xb0c4ff, 0x202028, 0.4);
  altitude = 1;

  constructor(scene: THREE.Scene) {
    this.dir.position.set(500, 1000, 200);
    this.dir.target.position.set(0, 0, 0);
    scene.add(this.dir);
    scene.add(this.dir.target);
    scene.add(this.ambient);
  }

  update(hour: number) {
    // Map hour 0..24 to angle so noon = up. Solstice-ish, no axial tilt.
    const t = ((hour - 6) / 12) * Math.PI; // 6am = 0, 6pm = π
    const alt = Math.sin(t); // -1..1
    const az = Math.cos(t); // east-west
    this.altitude = alt;
    const radius = 2000;
    this.dir.position.set(az * radius, alt * radius, radius * 0.4);
    const dayStrength = Math.max(0, alt);
    const dawnK = Math.max(0, 1 - Math.abs(alt) * 4); // golden hour bump
    this.dir.color.setRGB(
      1 - dawnK * 0.1,
      0.95 - dawnK * 0.3,
      0.85 - dawnK * 0.6,
    );
    this.dir.intensity = 0.05 + dayStrength * 1.4;
    this.ambient.intensity = 0.15 + dayStrength * 0.5;
    this.ambient.groundColor.setHex(alt > 0 ? 0x202028 : 0x070710);
  }
}
