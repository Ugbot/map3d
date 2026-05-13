import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { FeedLayerBase } from "./FeedLayerBase";
import { vesselTypeColor } from "../../../cache/classes";
import { KIND_FEED_VESSEL } from "@map3d/data-core";

function vesselGeometry(): THREE.BufferGeometry {
  const hull = new THREE.BoxGeometry(14, 6, 56);
  const prow = new THREE.BoxGeometry(10, 5, 14);
  prow.translate(0, 0, 32);
  const merged = mergeFlat(hull, prow);
  return merged;
}

function mergeFlat(a: THREE.BoxGeometry, b: THREE.BoxGeometry): THREE.BufferGeometry {
  const aPos = a.getAttribute("position") as THREE.BufferAttribute;
  const bPos = b.getAttribute("position") as THREE.BufferAttribute;
  const positions = new Float32Array(aPos.count * 3 + bPos.count * 3);
  positions.set(aPos.array as Float32Array, 0);
  positions.set(bPos.array as Float32Array, aPos.count * 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

const Y_WATER = 1.5;

export class VesselLayer extends FeedLayerBase {
  constructor() {
    const geo = vesselGeometry();
    const mat = new MeshStandardNodeMaterial({
      color: 0xb8c4d4,
      emissive: 0x88aaff,
      emissiveIntensity: 0.05,
      roughness: 0.6,
      metalness: 0.25,
      vertexColors: false,
    });
    super({
      name: "vessels",
      kindCode: KIND_FEED_VESSEL,
      capacity: 256,
      agentGeometry: geo,
      agentMaterial: mat,
      trailMaxSamples: 300,
      trailSampleS: 2.0,
      trailColor: new THREE.Color(0x9ad0ff),
      yOverride: () => Y_WATER + 2.0,
      hideOnGround: false,
    });
    void vesselTypeColor;
  }
}
