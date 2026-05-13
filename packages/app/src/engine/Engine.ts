// Vanilla Three.js engine — owns the scene, camera, renderer, animation loop,
// layer registry, tile manager, picking, day/night, shadows, keyboard.
//
// As of the data-core unification, the simulation and feed entities live in
// a single bitECS world owned by @map3d/data-core. Engine drives that world
// each frame and renders out of its component columns.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Renderer } from "./render/Renderer";
import { NearLightPool } from "./render/NearLightPool";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { StreetLightsLayer } from "./layers/StreetLightsLayer";
import { TileManager } from "./TileManager";
import { createAllLayers, ribbonConfigsForWorker } from "./layers";
import type { Layer } from "./Layer";
import type { LayerName } from "../cache/types";
import { tileCache, makeVersion } from "../cache/tileCache";
import { WorkerPool } from "../workers/pool";
import { Sun } from "./time/Sun";
import { SimRenderer } from "./sim/SimRenderer";
import { KeyboardController } from "./controls/KeyboardController";
import type { TileProvider } from "../providers/registry";
import { PoiLayer } from "./layers/PoiLayer";
import { FeedLayerBase } from "./layers/feeds/FeedLayerBase";
import {
  AISStreamFeed,
  FeedManager,
  OpenSkyFeed,
  createMap3dWorld,
  feedCommitRemovalsSystem,
  feedExpireSystem,
  feedRemoveSystem,
  feedUpsertSystem,
  ingestTileSystem,
  lonLatToMeters,
  releaseTileSystem,
  simUpdateSystem,
  type Map3dWorld,
} from "@map3d/data-core";

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

const WORLD_ENTITY_CAP = 8192;
const WORLD_POLYLINE_CAP = 4096;
const WORLD_FEED_STALE_MS = 5 * 60 * 1000;
const WORLD_SEED = 0xc0ffee;

function readAisKey(): string | null {
  try {
    const ls = typeof localStorage !== "undefined"
      ? localStorage.getItem("map3d.aisstream_key")
      : null;
    if (ls && ls.length > 0) return ls;
  } catch {
    // localStorage may be unavailable in some embeddings; ignore.
  }
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_AISSTREAM_KEY ?? null;
}

export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: Renderer;
  readonly controls: OrbitControls;
  readonly layers: Record<LayerName, Layer>;
  readonly tiles: TileManager;
  readonly sun: Sun;
  readonly world: Map3dWorld;
  readonly sim: SimRenderer;
  readonly keyboard: KeyboardController;
  readonly feeds: FeedManager;
  readonly nearLights: NearLightPool;

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

    if (!Renderer.webgpuAvailable()) {
      throw new Error(
        "WebGPU is not available in this browser. Try Chrome / Edge / Firefox / Safari with WebGPU enabled.",
      );
    }
    this.renderer = new Renderer({ host });

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 30000);
    this.camera.position.set(0, 350, 500);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 8000;
    this.controls.minDistance = 30;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.sun = new Sun(this.scene);
    this.scene.background = new THREE.Color(this.sun.horizonColor);
    this.scene.fog = new THREE.FogExp2(this.sun.horizonColor.getHex(), 0.00009);

    const stage = new THREE.Mesh(
      new THREE.PlaneGeometry(80000, 80000),
      new MeshStandardNodeMaterial({
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

    this.workers = new WorkerPool(
      () =>
        new Worker(new URL("../workers/tileFetch.worker.ts", import.meta.url), {
          type: "module",
        }),
    );

    this.sceneOrigin = lonLatToMeters(cfg.center.lng, cfg.center.lat);

    // Single ECS world for sim agents + live feed entities.
    this.world = createMap3dWorld({
      entityCap: WORLD_ENTITY_CAP,
      polylineCap: WORLD_POLYLINE_CAP,
      feedStaleMs: WORLD_FEED_STALE_MS,
      seed: WORLD_SEED,
    });

    this.tiles = new TileManager({
      pmtilesUrl: "<unused>",
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
      onTileLoaded: (tile) =>
        ingestTileSystem(this.world, tile, { sceneOrigin: this.sceneOrigin }),
      onTileEvicted: (tk) => releaseTileSystem(this.world, tk),
    });

    this.sim = new SimRenderer(this.scene, this.world);

    this.nearLights = new NearLightPool(this.scene, 20);

    // Wire feed layers to the world for rendering.
    const aircraftLayer = this.layers.aircraft as unknown as FeedLayerBase | undefined;
    const vesselLayer = this.layers.vessels as unknown as FeedLayerBase | undefined;
    if (aircraftLayer) aircraftLayer.setWorld(this.world);
    if (vesselLayer) vesselLayer.setWorld(this.world);

    // Live feeds — sources owned by data-core; sinks route into the ECS world.
    this.feeds = new FeedManager(this.sceneOrigin, [
      new OpenSkyFeed({ baseUrl: "/feeds/opensky" }),
      new AISStreamFeed({ apiKey: readAisKey() }),
    ]);
    this.feeds.registerSink("aircraft", {
      onUpdate: (e) =>
        feedUpsertSystem(this.world, e, {
          sceneOrigin: this.sceneOrigin,
          altitudeScale: 1.0,
        }),
      onRemove: (id) => feedRemoveSystem(this.world, id),
    });
    this.feeds.registerSink("vessel", {
      onUpdate: (e) =>
        feedUpsertSystem(this.world, e, {
          sceneOrigin: this.sceneOrigin,
          altitudeScale: 1.0,
        }),
      onRemove: (id) => feedRemoveSystem(this.world, id),
    });
    this.feeds.start();

    this.renderer.domElement.addEventListener("pointerdown", (e) => this.handlePick(e));
    this.renderer.domElement.addEventListener("pointermove", (e) => {
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
    });

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
    await this.renderer.init();
    this.renderer.attachScene(this.scene, this.camera);
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

      const night = Math.max(0, -this.sunAltitude);
      this.nearLights.setNightIntensity(night);
      const streetLights = this.layers.streetlights;
      if (streetLights instanceof StreetLightsLayer) {
        this.nearLights.update(this.camera.position, streetLights.allHeadPositions());
      }
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.scene.fog.color.copy(this.sun.horizonColor);
      }
      if (this.scene.background instanceof THREE.Color) {
        this.scene.background.copy(this.sun.horizonColor);
      }

      // Advance ECS world.
      simUpdateSystem(this.world, dt);
      feedExpireSystem(this.world, Date.now());

      // Render out of the world.
      this.sim.update();
      this.sim.setNight(night);
      for (const ln in this.layers) {
        const layer = this.layers[ln as LayerName];
        layer.update?.(this.timeSec, this.sunAltitude, this.layerSettings[ln as LayerName].glow);
      }

      // Commit feed removals after layers have read the world for this frame.
      feedCommitRemovalsSystem(this.world);

      const pois = this.layers.pois;
      if (pois instanceof PoiLayer)
        pois.cullByCamera(this.camera.position.x, this.camera.position.z);

      this.renderer.bloomStrength = 0.3 + night * 1.1;
      this.renderer.bloomThreshold = 0.85 - night * 0.55;
      this.renderer.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private updateShadowCamera() {
    const shadow = this.sun.dir.shadow.camera as THREE.OrthographicCamera;
    const target = this.controls.target;
    const size = shadow.right - shadow.left;
    const map = this.sun.dir.shadow.mapSize.x;
    const texel = size / map;
    const tx = Math.round(target.x / texel) * texel;
    const tz = Math.round(target.z / texel) * texel;
    this.sun.dir.target.position.set(tx, 0, tz);
    this.sun.dir.target.updateMatrixWorld();
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
    this.renderer.setSize(w, h);
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
  }
}
