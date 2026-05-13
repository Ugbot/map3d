// Vanilla Three.js engine — owns the scene, camera, renderer, animation loop,
// layer registry, tile manager, picking, day/night, shadows, keyboard.
//
// Composability:
//   - Layers come in as a Record<LayerName,Layer> (swappable per layer).
//   - Tiles come via WorkerPool + TileStore + a TileProvider config.
//   - Sim is a separate module that consumes tile lines and renders agents.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { TileManager } from "./TileManager";
import { createAllLayers, ribbonConfigsForWorker } from "./layers";
import type { Layer } from "./Layer";
import type { LayerName } from "../cache/types";
import { tileCache, makeVersion } from "../cache/tileCache";
import { WorkerPool } from "../workers/pool";
import { Sun } from "./time/Sun";
import { Simulation } from "./sim/Simulation";
import { lonLatToMeters } from "../projection/mercator";
import { KeyboardController } from "./controls/KeyboardController";
import type { TileProvider } from "../providers/registry";
import { PoiLayer } from "./layers/PoiLayer";
import { FeedManager } from "../feeds/FeedManager";
import { FeedLayerBase } from "./layers/feeds/FeedLayerBase";

export interface EngineConfig {
  provider: TileProvider;
  center: { lat: number; lng: number };
  ringRadius?: number;
  onSelect?: (
    layer: LayerName,
    featureGlobalId: string,
    screenX: number,
    screenY: number,
  ) => void;
  onProgress?: (loaded: number, inflight: number) => void;
}

export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly controls: OrbitControls;
  readonly layers: Record<LayerName, Layer>;
  readonly tiles: TileManager;
  readonly sun: Sun;
  readonly sim: Simulation;
  readonly keyboard: KeyboardController;
  readonly feeds: FeedManager;

  private host: HTMLDivElement;
  private workers: WorkerPool;
  private cfg: EngineConfig;
  private raf = 0;
  private last = 0;
  private timeSec = 0;
  private sunAltitude = 1;
  private layerSettings: Record<LayerName, { visible: boolean; opacity: number; glow: number }>;
  private sceneOrigin: { x: number; y: number };
  private hour = 14;

  constructor(host: HTMLDivElement, cfg: EngineConfig) {
    this.host = host;
    this.cfg = cfg;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    Object.assign(this.renderer.domElement.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    });

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 30000);
    this.camera.position.set(0, 350, 500);

    // OrbitControls
    // Post-processing — bloom over emissive surfaces. This is our pragmatic
    // substitute for a full deferred pipeline: the visual impact (lights pop
    // against the night sky) without rewriting the renderer.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      0.6,   // strength
      0.6,   // radius
      0.85,  // threshold — only really-bright emissive pixels bloom
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 8000;
    this.controls.minDistance = 30;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    // Sun + sky (sky mesh provides background, no scene.background needed).
    this.sun = new Sun(this.scene);
    this.scene.fog = new THREE.FogExp2(this.sun.horizonColor.getHex(), 0.00009);

    // Permanent dark stage plate so the sky-ground hemisphere never shows
    // through when the user toggles surface layers off. Not a Layer — engine
    // owns it.
    const stage = new THREE.Mesh(
      new THREE.PlaneGeometry(80000, 80000),
      new THREE.MeshStandardMaterial({
        color: 0x141821,
        roughness: 1,
        metalness: 0,
      }),
    );
    stage.rotation.x = -Math.PI / 2;
    stage.position.y = -5;
    stage.receiveShadow = false;
    stage.renderOrder = -10;
    this.scene.add(stage);

    // Layers
    this.layers = createAllLayers(cfg.center.lat);
    for (const ln in this.layers) {
      this.scene.add(this.layers[ln as LayerName].root);
    }
    this.layerSettings = Object.fromEntries(
      (Object.keys(this.layers) as LayerName[]).map((n) => [
        n,
        { visible: true, opacity: 1, glow: 0.5 },
      ]),
    ) as typeof this.layerSettings;

    // Workers
    this.workers = new WorkerPool(
      () =>
        new Worker(new URL("../workers/tileFetch.worker.ts", import.meta.url), {
          type: "module",
        }),
    );

    // Scene origin = the picked location, in Web Mercator metres.
    this.sceneOrigin = lonLatToMeters(cfg.center.lng, cfg.center.lat);

    // TileManager — no bbox clamp, streaming follows camera.
    this.tiles = new TileManager({
      pmtilesUrl: "<unused>", // legacy field — TileManager now uses worker init instead
      sceneOrigin: this.sceneOrigin,
      ringRadius: cfg.ringRadius ?? 4,
      bufferRings: 1,
      baseZoom: Math.min(15, cfg.provider.maxZoom),
      cacheVersion: makeVersion(cfg.provider.id, cfg.provider.schema),
      layers: this.layers,
      store: tileCache(),
      workers: this.workers,
      workerInitPayload: {
        source: cfg.provider.source,
        schema: cfg.provider.schema,
        cacheVersion: makeVersion(cfg.provider.id, cfg.provider.schema),
        sceneOrigin: this.sceneOrigin,
        ribbonConfigs: ribbonConfigsForWorker(),
      },
      onProgress: cfg.onProgress,
      onSelect: (layer, id) => {
        cfg.onSelect?.(layer, id, this.lastPointer.x, this.lastPointer.y);
      },
      onTileLoaded: (tile) => this.sim.ingestTile(tile, this.sceneOrigin),
      onTileEvicted: (tk) => this.sim.releaseTile(tk),
    });

    // Simulation
    this.sim = new Simulation(this.scene, this.sceneOrigin);

    // Live feeds — aircraft (OpenSky) + vessels (AISStream).
    this.feeds = new FeedManager(this.sceneOrigin);
    const aircraftLayer = this.layers.aircraft as unknown as FeedLayerBase | undefined;
    const vesselLayer = this.layers.vessels as unknown as FeedLayerBase | undefined;
    if (aircraftLayer) {
      aircraftLayer.setSceneOrigin(this.sceneOrigin);
      this.feeds.registerSink("aircraft", {
        onUpdate: (e) => aircraftLayer.pushUpdate(e),
        onRemove: (id) => aircraftLayer.remove(id),
      });
    }
    if (vesselLayer) {
      vesselLayer.setSceneOrigin(this.sceneOrigin);
      this.feeds.registerSink("vessel", {
        onUpdate: (e) => vesselLayer.pushUpdate(e),
        onRemove: (id) => vesselLayer.remove(id),
      });
    }
    this.feeds.start();

    // Selection picking.
    this.renderer.domElement.addEventListener("pointerdown", (e) => this.handlePick(e));
    this.renderer.domElement.addEventListener("pointermove", (e) => {
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
    });

    // Keyboard controller composes with OrbitControls.
    this.keyboard = new KeyboardController(
      this.camera,
      this.controls,
      this.renderer.domElement,
      new THREE.Vector3(0, 0, 0),
    );

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
      this.keyboard.update(dt);
      this.controls.update();
      this.tiles.poll(this.camera.position.x, this.camera.position.z);
      this.feeds.tickCamera(this.camera.position.x, this.camera.position.z);
      this.sun.update(this.hour);
      this.sunAltitude = this.sun.altitude;
      this.updateShadowCamera();
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.scene.fog.color.copy(this.sun.horizonColor);
      }
      this.sim.update(dt);
      this.sim.setNight(Math.max(0, -this.sunAltitude));
      for (const ln in this.layers) {
        const layer = this.layers[ln as LayerName];
        layer.update?.(this.timeSec, this.sunAltitude, this.layerSettings[ln as LayerName].glow);
      }
      // POI distance cull (engine-level because it needs camera coords).
      const pois = this.layers.pois;
      if (pois instanceof PoiLayer)
        pois.cullByCamera(this.camera.position.x, this.camera.position.z);

      // Bloom strength rises as the sun drops below the horizon — night
      // lights punch, daytime is realistic. Threshold falls too so dimmer
      // emissives also pick up some glow.
      const night = Math.max(0, -this.sunAltitude);
      this.bloom.strength = 0.3 + night * 1.1;
      this.bloom.threshold = 0.85 - night * 0.55;
      this.composer.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private updateShadowCamera() {
    // Shadow camera follows the orbit target (camera focus). Snap to texel grid
    // to avoid shimmer on slow pans.
    const shadow = this.sun.dir.shadow.camera as THREE.OrthographicCamera;
    const target = this.controls.target;
    const size = shadow.right - shadow.left;
    const map = this.sun.dir.shadow.mapSize.x;
    const texel = size / map;
    const tx = Math.round(target.x / texel) * texel;
    const tz = Math.round(target.z / texel) * texel;
    this.sun.dir.target.position.set(tx, 0, tz);
    this.sun.dir.target.updateMatrixWorld();
    // Re-position the light relative to the target so the shadow camera
    // doesn't lose the visible region as we fly.
    const offset = new THREE.Vector3()
      .copy(this.sun.dir.position)
      .sub(this.sun.dir.target.position);
    this.sun.dir.position.set(tx + offset.x, this.sun.dir.position.y, tz + offset.z);
  }

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

  async getAttributesAsync(
    layer: LayerName,
    globalId: string,
  ): Promise<Record<string, string | number> | null> {
    const sep = globalId.lastIndexOf(":");
    const tileKey = globalId.slice(0, sep);
    const featureId = parseInt(globalId.slice(sep + 1), 10);
    const [z, x, y] = tileKey.split("/").map(Number);
    const v = makeVersion(this.cfg.provider.id, this.cfg.provider.schema);
    const parsed = await tileCache().getParsed(z, x, y, v);
    if (!parsed) return null;
    return parsed.attributes[`${layer}:${featureId}`] ?? null;
  }

  /** For DebugHUD. */
  stats() {
    const ac = this.layers.aircraft as unknown as FeedLayerBase | undefined;
    const ve = this.layers.vessels as unknown as FeedLayerBase | undefined;
    return {
      tilesLoaded: this.tiles.loadedKeys.length,
      tilesInflight: this.workers.inflight,
      hour: this.hour,
      sunAltitude: this.sunAltitude,
      cameraY: this.camera.position.y,
      aircraftCount: ac?.countActive() ?? 0,
      vesselCount: ve?.countActive() ?? 0,
      feedStatus: this.feeds.status(),
    };
  }

  resize = () => {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.keyboard.dispose();
    this.feeds.stop();
    this.tiles.dispose();
    this.workers.terminate();
    this.renderer.dispose();
    this.host.removeChild(this.renderer.domElement);
  }
}
