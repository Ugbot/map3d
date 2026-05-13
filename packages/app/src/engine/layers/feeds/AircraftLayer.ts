import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { FeedLayerBase } from "./FeedLayerBase";
import { KIND_FEED_AIRCRAFT } from "@map3d/data-core";

function aircraftGeometry(): THREE.BufferGeometry {
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
      kindCode: KIND_FEED_AIRCRAFT,
      capacity: 256,
      agentGeometry: geo,
      agentMaterial: mat,
      trailMaxSamples: 300,
      trailSampleS: 1.0,
      trailColor: new THREE.Color(0xffe48a),
      // Compress altitude: world.y carries altitude in metres (scale 1.0).
      // Remap 0..12 000 m to 200..3 000 m of scene Y.
      yOverride: (worldY) => 200 + Math.min(1, Math.max(0, worldY) / 12000) * 2800,
      hideOnGround: true,
    });
  }
}
