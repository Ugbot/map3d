import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { FeedLayerBase } from "./FeedLayerBase";

function aircraftGeometry(): THREE.BufferGeometry {
  // Stylised plane, intentionally large so it reads from camera altitude.
  // Real planes (~70 m wingspan) viewed at 10 km would be a sub-pixel; we
  // scale up for legibility, this is a sim display.
  const body = new THREE.BoxGeometry(8, 4, 36);
  const wings = new THREE.BoxGeometry(64, 1.6, 10);
  wings.translate(0, 0, -2);
  const tail = new THREE.BoxGeometry(2.4, 9, 8);
  tail.translate(0, 4, -14);
  const merged = mergeGeometries([body, wings, tail], false);
  return merged ?? body;
}

export class AircraftLayer extends FeedLayerBase {
  constructor() {
    const geo = aircraftGeometry();
    const mat = new MeshStandardNodeMaterial({
      color: 0xe6e2d4,
      emissive: 0xffd58a,
      emissiveIntensity: 0.1,
      roughness: 0.5,
      metalness: 0.4,
    });
    super({
      name: "aircraft",
      capacity: 256,
      agentGeometry: geo,
      agentMaterial: mat,
      // 5 min of trail @ 1 Hz — the line stays visible long after the plane
      // passes, so you can see where it came from.
      trailMaxSamples: 300,
      trailSampleS: 1.0,
      trailColor: new THREE.Color(0xffe48a),
      // Keep planes alive (dead-reckoning along last known heading) for
      // 5 minutes past the most recent observation. Lets them "fly by"
      // smoothly while we wait for the next poll.
      inactiveAfterS: 300,
      // Altitude clamp tuned for visibility — real cruising altitudes (10–12 km)
      // would put planes off-screen at our default camera height. Compress the
      // sky.
      yForEntity: (e) => {
        const real = e.altM ?? 0;
        // Linear remap: 0..12 000 m → 200..3 000 m of scene Y.
        return 200 + Math.min(1, real / 12000) * 2800;
      },
      shouldRender: (e) => !e.onGround,
    });
  }
}
