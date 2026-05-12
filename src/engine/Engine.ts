// Vanilla Three.js engine — owns the scene, camera, renderer, animation loop,
// layer registry, tile manager, picking. R3F is *not* used inside; the React
// side just hands us a host div and we attach our own canvas.
//
// Composability hooks:
//   - Layers come in as a `Record<LayerName, Layer>` so you can swap any one.
//   - Tile data comes from a TileStore + WorkerPool; both are interfaces.
//   - Sim and selection are pluggable add-ons.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TileManager } from "./TileManager";
import { createAllLayers } from "./layers";
import type { Layer } from "./Layer";
import type { LayerName } from "../cache/types";
import { tileCache } from "../cache/tileCache";
import { WorkerPool } from "../workers/pool";
import { Sun } from "./time/Sun";
import { Simulation } from "./sim/Simulation";

export interface EngineConfig {
  pmtilesUrl: string;
  bbox: { west: number; south: number; east: number; north: number };
  onSelect?: (layer: LayerName, featureGlobalId: string, screenX: number, screenY: number) => void;
  onProgress?: (loaded: number, inflight: number) => void;
}

export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly layers: Record<LayerName, Layer>;
  readonly tiles: TileManager;
  readonly sun: Sun;
  readonly sim: Simulation;

  private host: HTMLDivElement;
  private workers: WorkerPool;
  private cfg: EngineConfig;
  private raf = 0;
  private last = 0;
  private timeSec = 0;
  private sunAltitude = 1;
  private layerSettings: Record<LayerName, { visible: boolean; opacity: number; glow: number }>;
  private sceneOrigin: { x: number; y: number };

  constructor(host: HTMLDivElement, cfg: EngineConfig) {
    this.host = host;
    this.cfg = cfg;
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.fog = new THREE.Fog(0x0b1020, 1500, 8000);

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 30000);
    this.camera.position.set(600, 500, 600);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    host.appendChild(this.renderer.domElement);
    Object.assign(this.renderer.domElement.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    });

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 12000;
    this.controls.minDistance = 50;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    // Ground reference plane (so empty tiles aren't a void).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(50000, 50000),
      new THREE.MeshStandardMaterial({ color: 0x080a14, roughness: 1.0, metalness: 0.0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = false;
    this.scene.add(ground);

    // Lights — sun manages the directional + ambient.
    this.sun = new Sun(this.scene);

    // Layers
    this.layers = createAllLayers();
    for (const ln in this.layers) {
      this.scene.add(this.layers[ln as LayerName].root);
    }
    this.layerSettings = Object.fromEntries(
      (Object.keys(this.layers) as LayerName[]).map((n) => [n, { visible: true, opacity: 1, glow: 0.5 }]),
    ) as typeof this.layerSettings;

    // Workers
    this.workers = new WorkerPool(
      () => new Worker(new URL("../workers/tileFetch.worker.ts", import.meta.url), { type: "module" }),
    );

    // Scene origin = bbox centre in mercator metres.
    this.sceneOrigin = TileManager.computeSceneOrigin(cfg.bbox);

    // Tile manager
    this.tiles = new TileManager({
      pmtilesUrl: cfg.pmtilesUrl,
      sceneOrigin: this.sceneOrigin,
      layers: this.layers,
      store: tileCache(),
      workers: this.workers,
      onProgress: cfg.onProgress,
      onSelect: (layer, id) => {
        const evt = this.lastPointer;
        cfg.onSelect?.(layer, id, evt.x, evt.y);
      },
      onTileLoaded: (tile) => this.sim.ingestTile(tile, this.sceneOrigin),
      onTileEvicted: (tk) => this.sim.releaseTile(tk),
    });
    this.tiles.setBBox(cfg.bbox);

    // Simulation
    this.sim = new Simulation(this.scene, this.sceneOrigin);

    // Selection picking.
    this.renderer.domElement.addEventListener("pointerdown", (e) => this.handlePick(e));
    this.renderer.domElement.addEventListener("pointermove", (e) => {
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
    });

    this.resize();
    window.addEventListener("resize", this.resize);
  }

  async start(): Promise<void> {
    await this.tiles.init();
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.timeSec += dt;
      this.controls.update();
      this.tiles.poll(this.camera.position.x, this.camera.position.z);
      this.sun.update(this.hour);
      this.sunAltitude = this.sun.altitude;
      this.sim.update(dt);
      this.sim.setNight(Math.max(0, -this.sunAltitude));
      for (const ln in this.layers) {
        const layer = this.layers[ln as LayerName];
        layer.update?.(this.timeSec, this.sunAltitude, this.layerSettings[ln as LayerName].glow);
      }
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private hour = 14;
  setHour(h: number) {
    this.hour = h;
  }
  setLayerVisible(name: LayerName, v: boolean) {
    this.layerSettings[name].visible = v;
    this.layers[name].setVisible(v);
  }
  setLayerOpacity(name: LayerName, v: number) {
    this.layerSettings[name].opacity = v;
    this.layers[name].setOpacity(v);
  }
  setLayerGlow(name: LayerName, v: number) {
    this.layerSettings[name].glow = v;
  }

  highlight(layer: LayerName | null, id: string | null) {
    for (const ln in this.layers) {
      const l = this.layers[ln as LayerName];
      l.highlight?.(layer === ln ? id : null);
    }
  }

  private lastPointer = { x: 0, y: 0 };
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  private handlePick(e: PointerEvent) {
    if (e.button !== 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);
    // Buildings are the primary selectable layer.
    const intersects = this.raycaster.intersectObject(this.layers.buildings.root, true);
    if (intersects.length === 0) {
      this.cfg.onSelect?.("buildings", "", e.clientX, e.clientY);
      this.highlight(null, null);
      return;
    }
    const hit = intersects[0];
    const mesh = hit.object as THREE.Mesh;
    const buildings = this.layers.buildings as unknown as {
      pickFeature: (m: THREE.Mesh, faceIndex: number) => string | null;
    };
    if (typeof hit.faceIndex !== "number") return;
    const globalId = buildings.pickFeature(mesh, hit.faceIndex);
    if (globalId) {
      this.highlight("buildings", globalId);
      this.cfg.onSelect?.("buildings", globalId, e.clientX, e.clientY);
    }
  }

  /** Look up attributes for a feature by walking loaded tiles. */
  getAttributes(layer: LayerName, globalId: string): Record<string, string | number> | null {
    const sep = globalId.lastIndexOf(":");
    const tileKey = globalId.slice(0, sep);
    const featureId = parseInt(globalId.slice(sep + 1), 10);
    const lt = this.tiles.getLoadedTile(tileKey);
    if (!lt) return null;
    // Attributes live on the parsed tile; we don't keep them in handles to save
    // memory. Re-read from the IndexedDB cache (which we just wrote).
    void lt;
    void layer;
    void featureId;
    return null; // resolved asynchronously by caller via getAttributesAsync
  }
  async getAttributesAsync(
    layer: LayerName,
    globalId: string,
  ): Promise<Record<string, string | number> | null> {
    const sep = globalId.lastIndexOf(":");
    const tileKey = globalId.slice(0, sep);
    const featureId = parseInt(globalId.slice(sep + 1), 10);
    const [z, x, y] = tileKey.split("/").map(Number);
    const parsed = await tileCache().getParsed(z, x, y, 1);
    if (!parsed) return null;
    return parsed.attributes[`${layer}:${featureId}`] ?? null;
  }

  resize = () => {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.tiles.dispose();
    this.workers.terminate();
    this.renderer.dispose();
    this.host.removeChild(this.renderer.domElement);
  }
}
