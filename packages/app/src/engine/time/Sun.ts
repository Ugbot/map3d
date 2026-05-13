// Solar lighting + sky. Three.js wrapper around data-core's pure `computeSun`
// math. Exposes the directional + hemisphere lights and the horizon/zenith
// colours the engine syncs to fog and background.

import * as THREE from "three";
import { computeSun } from "@map3d/data-core";

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
    const SHADOW_HALF = 1800;
    this.dir.shadow.camera.left = -SHADOW_HALF;
    this.dir.shadow.camera.right = SHADOW_HALF;
    this.dir.shadow.camera.top = SHADOW_HALF;
    this.dir.shadow.camera.bottom = -SHADOW_HALF;
    scene.add(this.dir);
    scene.add(this.dir.target);
    scene.add(this.ambient);
  }

  update(hour: number) {
    const s = computeSun(hour);
    this.altitude = s.altitude;
    this.azimuth = s.azimuth;
    this.dir.position.set(s.position.x, s.position.y, s.position.z);
    this.dir.color.setRGB(s.directional.r, s.directional.g, s.directional.b);
    this.dir.intensity = s.directionalIntensity;
    this.ambient.color.setRGB(s.ambientSky.r, s.ambientSky.g, s.ambientSky.b);
    this.ambient.groundColor.setRGB(
      s.ambientGround.r,
      s.ambientGround.g,
      s.ambientGround.b,
    );
    this.ambient.intensity = s.ambientIntensity;
    this.ambientSky.setRGB(s.ambientSky.r, s.ambientSky.g, s.ambientSky.b);
    this.horizonColor.setRGB(s.horizon.r, s.horizon.g, s.horizon.b);
    this.zenithColor.setRGB(s.zenith.r, s.zenith.g, s.zenith.b);
  }
}
