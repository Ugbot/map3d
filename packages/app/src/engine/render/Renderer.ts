// Façade over Three.js' WebGPURenderer. The engine talks to this through a
// stable surface (mount, render, resize, dispose) so the rendering backend
// can be swapped without touching layer code.
//
// WebGPU's renderer is async — it needs an adapter + device handshake before
// it can render. The façade hides that behind an `init()` promise.

import * as THREE from "three";
import {
  WebGPURenderer,
  PostProcessing,
  PassNode,
} from "three/webgpu";
import { pass, mrt, output, emissive, add } from "three/tsl";
import type { Node } from "three/webgpu";

export interface RendererOpts {
  host: HTMLDivElement;
  /** Optional — overrides automatic pixel ratio. */
  pixelRatio?: number;
  /** Optional — turn shadow map on. */
  shadows?: boolean;
}

export class Renderer {
  readonly gpu: WebGPURenderer;
  readonly post: PostProcessing;
  private host: HTMLDivElement;
  private ready: Promise<void>;
  private isReady = false;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private bloomEnabled = true;

  // Bloom controls — driven by the engine each frame.
  bloomStrength = 0.3;
  bloomThreshold = 0.85;

  constructor(opts: RendererOpts) {
    this.host = opts.host;
    this.gpu = new WebGPURenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.gpu.outputColorSpace = THREE.SRGBColorSpace;
    this.gpu.toneMapping = THREE.ACESFilmicToneMapping;
    this.gpu.toneMappingExposure = 1.25;
    if (opts.shadows !== false) {
      this.gpu.shadowMap.enabled = true;
      this.gpu.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.gpu.setPixelRatio(opts.pixelRatio ?? Math.min(devicePixelRatio, 2));
    this.host.appendChild(this.gpu.domElement);
    Object.assign(this.gpu.domElement.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    });

    this.post = new PostProcessing(this.gpu);
    this.ready = this.gpu
      .init()
      .then(() => {
        this.isReady = true;
        // PostProcessing graph is configured by `attachScene` once we have a
        // scene + camera to pass to the scene pass node.
      })
      .catch((e) => {
        console.error("[Renderer] WebGPU init failed", e);
        throw e;
      });
  }

  static webgpuAvailable(): boolean {
    return typeof navigator !== "undefined" && !!(navigator as Navigator & { gpu?: unknown }).gpu;
  }

  /** Wire the post chain to render this scene/camera. Call once after construction. */
  attachScene(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
    const scenePass = pass(scene, camera);
    // MRT outputs — Stage 1 we only consume `output` and `emissive` for
    // bloom. Stage 2 will read full G-buffer here.
    scenePass.setMRT(
      mrt({
        output,
        emissive,
      }),
    );
    const colour = scenePass.getTextureNode("output");
    const emi = scenePass.getTextureNode("emissive");
    // Bloom on the emissive channel only — keeps daytime clean and lets the
    // emissive pass through bright at night when our materials boost it.
    const bloomed = bloomOnEmissive(colour, emi, () => this.bloomStrength, () => this.bloomThreshold);
    this.post.outputNode = bloomed;
  }

  async init(): Promise<void> {
    await this.ready;
  }

  render() {
    if (!this.isReady || !this.scene || !this.camera) return;
    if (this.bloomEnabled) this.post.render();
    else this.gpu.render(this.scene, this.camera);
  }

  setSize(w: number, h: number) {
    this.gpu.setSize(w, h, false);
  }

  get domElement() {
    return this.gpu.domElement;
  }

  dispose() {
    this.host.removeChild(this.gpu.domElement);
    this.gpu.dispose();
  }
}

/**
 * Cheap bloom built from TSL: blur the emissive channel and add it to colour.
 * Three's full UnrealBloom is also available as a node — we'll switch to it
 * in Stage 2 once we know our G-buffer is stable.
 */
function bloomOnEmissive(
  colour: Node,
  emi: Node,
  _strength: () => number,
  _threshold: () => number,
): Node {
  // Minimal placeholder — add emissive on top of colour. Stage 2/4 will swap
  // this for the real bloom node graph; this stub keeps the pipeline alive
  // so we can validate parity first.
  return add(colour, emi) as Node;
}
