// Composes with OrbitControls: pans camera + target together so WASD/arrow
// keys feel like a game-style fly-through instead of orbiting. Speed scales
// with altitude so panning at 500 m feels as snappy as at 50 m.

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface KeyboardBindings {
  forward: string[];
  back: string[];
  left: string[];
  right: string[];
  up: string[];
  down: string[];
  rotL: string[];
  rotR: string[];
  zoomIn: string[];
  zoomOut: string[];
  sprint: string[];
  home: string[];
}

export const DEFAULT_BINDINGS: KeyboardBindings = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  up: ["KeyR", "PageUp"],
  down: ["KeyF", "PageDown"],
  rotL: ["KeyQ"],
  rotR: ["KeyE"],
  zoomIn: ["KeyZ"],
  zoomOut: ["KeyX"],
  sprint: ["ShiftLeft", "ShiftRight"],
  home: ["Space"],
};

export class KeyboardController {
  private held = new Set<string>();
  private bindings: KeyboardBindings;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private domTarget: HTMLElement;
  private home: THREE.Vector3;

  constructor(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    domTarget: HTMLElement,
    home: THREE.Vector3,
    bindings: KeyboardBindings = DEFAULT_BINDINGS,
  ) {
    this.camera = camera;
    this.controls = controls;
    this.domTarget = domTarget;
    this.home = home.clone();
    this.bindings = bindings;
    addEventListener("keydown", this.onDown);
    addEventListener("keyup", this.onUp);
    addEventListener("blur", this.onBlur);
    // Ensure the canvas can receive focus for keystrokes to register everywhere.
    domTarget.setAttribute("tabindex", "0");
    domTarget.style.outline = "none";
  }

  dispose() {
    removeEventListener("keydown", this.onDown);
    removeEventListener("keyup", this.onUp);
    removeEventListener("blur", this.onBlur);
  }

  private onDown = (e: KeyboardEvent) => {
    if (this.isMatch(e, this.bindings.home)) {
      // Snap camera back to home (preserving its current offset from target).
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      this.controls.target.copy(this.home);
      this.camera.position.copy(this.home).add(offset);
      e.preventDefault();
      return;
    }
    if (this.isAnyBinding(e.code)) {
      this.held.add(e.code);
      e.preventDefault();
    }
  };
  private onUp = (e: KeyboardEvent) => {
    if (this.held.has(e.code)) {
      this.held.delete(e.code);
      e.preventDefault();
    }
  };
  private onBlur = () => {
    this.held.clear();
  };

  private isMatch(e: KeyboardEvent, codes: string[]): boolean {
    return codes.includes(e.code);
  }
  private isAnyBinding(code: string): boolean {
    const b = this.bindings;
    return (
      b.forward.includes(code) ||
      b.back.includes(code) ||
      b.left.includes(code) ||
      b.right.includes(code) ||
      b.up.includes(code) ||
      b.down.includes(code) ||
      b.rotL.includes(code) ||
      b.rotR.includes(code) ||
      b.zoomIn.includes(code) ||
      b.zoomOut.includes(code) ||
      b.sprint.includes(code)
    );
  }
  private isHeldAny(codes: string[]): boolean {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  setHome(p: THREE.Vector3) {
    this.home.copy(p);
  }

  /** Called per frame from the engine loop. */
  update(dt: number) {
    if (this.held.size === 0) return;

    // Speed scales with altitude. Floor of 30 m/s, climbs to 300 at altitude.
    const altitude = Math.max(20, this.camera.position.y);
    const sprintMul = this.isHeldAny(this.bindings.sprint) ? 3 : 1;
    const speed = Math.min(300, 30 + altitude * 0.6) * sprintMul;
    const rotSpeed = 1.4 * sprintMul; // rad/s

    // Forward vector projected onto XZ plane.
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const up = new THREE.Vector3(0, 1, 0);
    const move = new THREE.Vector3();

    if (this.isHeldAny(this.bindings.forward)) move.add(fwd);
    if (this.isHeldAny(this.bindings.back)) move.sub(fwd);
    if (this.isHeldAny(this.bindings.right)) move.add(right);
    if (this.isHeldAny(this.bindings.left)) move.sub(right);
    if (this.isHeldAny(this.bindings.up)) move.add(up);
    if (this.isHeldAny(this.bindings.down)) move.sub(up);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      this.camera.position.add(move);
      this.controls.target.add(move);
    }

    // Yaw: rotate camera around target.
    let yaw = 0;
    if (this.isHeldAny(this.bindings.rotL)) yaw += rotSpeed * dt;
    if (this.isHeldAny(this.bindings.rotR)) yaw -= rotSpeed * dt;
    if (yaw !== 0) {
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      const nx = offset.x * cos - offset.z * sin;
      const nz = offset.x * sin + offset.z * cos;
      offset.x = nx;
      offset.z = nz;
      this.camera.position.copy(this.controls.target).add(offset);
    }

    // Zoom: move camera along its forward direction. OrbitControls clamps distance.
    let zoom = 0;
    if (this.isHeldAny(this.bindings.zoomIn)) zoom -= 1;
    if (this.isHeldAny(this.bindings.zoomOut)) zoom += 1;
    if (zoom !== 0) {
      const dirToTarget = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
      const distanceStep = speed * dt;
      this.camera.position.addScaledVector(dirToTarget, -zoom * distanceStep);
    }
  }
}
