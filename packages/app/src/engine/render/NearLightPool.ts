// Pragmatic "deferred-lite" near-camera light pool.
//
// We don't yet have a clustered / G-buffer pipeline that could light thousands
// of lamps at once. What we do have is Three's regular forward shading, which
// happily takes a small number of dynamic PointLights. So we maintain a small
// fixed pool of real PointLights and, each frame, snap them onto the nearest
// streetlight positions to the camera. Distant lamps stay as plain emissive
// heads (the StreetLightsLayer mesh) — the eye accepts that because you can
// only really *see* light pools nearby anyway.
//
// Stage 3 replaces this with a real clustered pass that drives every lamp at
// once. Until then this is the cheapest way to see real light fall on the
// ground around the camera.

import * as THREE from "three";

const COLOUR = 0xffbf6e; // warm sodium-amber

export class NearLightPool {
  readonly lights: THREE.PointLight[] = [];
  readonly scratchPos = new THREE.Vector3();
  private intensity = 0;
  private radius = 110;

  constructor(scene: THREE.Scene, count = 20) {
    for (let i = 0; i < count; i++) {
      // Decay = 1.6 gives a soft realistic falloff over the full distance.
      const l = new THREE.PointLight(COLOUR, 0, this.radius, 1.6);
      l.castShadow = false;
      l.visible = false;
      scene.add(l);
      this.lights.push(l);
    }
  }

  /** Engine drives intensity (and ramps it with night). */
  setNightIntensity(nightFactor: number) {
    // Punchy lamps — we have fewer of them now, so each one needs to throw
    // a visible pool of light onto the road and adjacent walls.
    this.intensity = nightFactor * 28.0;
  }

  /**
   * @param cameraPos scene-local camera position
   * @param lampLists arrays of (x, y, z) triples — one per loaded tile
   */
  update(cameraPos: THREE.Vector3, lampLists: readonly Float32Array[]) {
    if (this.intensity <= 0) {
      for (const l of this.lights) l.visible = false;
      return;
    }
    // Collect the N closest lamps to the camera. With ~30k lamps in the ring
    // a naive scan is O(n) per frame and cheap — < 0.5ms.
    const cx = cameraPos.x;
    const cz = cameraPos.z;
    const radiusSqCutoff = 4000 * 4000; // ignore lamps beyond this
    // Min-heap-of-N would be tighter; for N≤64 a linear-insertion ring is
    // simpler and equally fast.
    const N = this.lights.length;
    const bestDist = new Float32Array(N).fill(Infinity);
    const bestX = new Float32Array(N);
    const bestY = new Float32Array(N);
    const bestZ = new Float32Array(N);
    let worst = Infinity;
    let worstSlot = 0;

    for (const list of lampLists) {
      for (let i = 0; i < list.length; i += 3) {
        const dx = list[i] - cx;
        const dz = list[i + 2] - cz;
        const d = dx * dx + dz * dz;
        if (d > radiusSqCutoff) continue;
        if (d >= worst) continue;
        // Replace the current worst slot.
        bestDist[worstSlot] = d;
        bestX[worstSlot] = list[i];
        bestY[worstSlot] = list[i + 1];
        bestZ[worstSlot] = list[i + 2];
        // Re-find worst slot.
        worst = -Infinity;
        for (let j = 0; j < N; j++) {
          if (bestDist[j] > worst) {
            worst = bestDist[j];
            worstSlot = j;
          }
        }
      }
    }

    for (let i = 0; i < N; i++) {
      const l = this.lights[i];
      if (bestDist[i] === Infinity) {
        l.visible = false;
        continue;
      }
      l.position.set(bestX[i], bestY[i], bestZ[i]);
      l.intensity = this.intensity;
      l.distance = this.radius;
      l.color.setHex(COLOUR);
      l.visible = true;
    }
  }
}
