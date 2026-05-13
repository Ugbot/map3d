// Ambient declarations for the Emscripten runtime that city.js installs as
// `window.Module`. The actual glue may be MODULARIZE=1 (returning a factory)
// or a plain script. We support the plain script path: caller sets
// `window.Module = { onRuntimeInitialized: () => ... }` BEFORE injecting the
// city.js <script> tag, then awaits the callback.
//
// Only the surface we actually use is declared here. Keep this list narrow —
// every entry here is an implicit trust boundary with the wasm module.

export {};

export type CType =
  | "number"
  | "string"
  | "boolean"
  | "array"
  | "null"
  | undefined;

export interface EmscriptenModule {
  // Runtime lifecycle
  onRuntimeInitialized?: () => void;
  onAbort?: (what: any) => void;
  noInitialRun?: boolean;
  noExitRuntime?: boolean;
  print?: (msg: string) => void;
  printErr?: (msg: string) => void;

  // Canvas wiring expected by sokol_app's Emscripten backend.
  canvas?: HTMLCanvasElement;

  // Heaps
  HEAP8: Int8Array;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAPU16: Uint16Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;

  // C ABI
  ccall: (
    ident: string,
    returnType: CType,
    argTypes: CType[],
    args: ReadonlyArray<unknown>,
  ) => any;
  cwrap: <F extends (...args: any[]) => any = (...args: any[]) => any>(
    ident: string,
    returnType: CType,
    argTypes: CType[],
  ) => F;

  _malloc: (n: number) => number;
  _free: (ptr: number) => void;

  // Direct underscored exports (fallback if ccall isn't desired).
  [exportName: `_${string}`]: ((...args: any[]) => any) | undefined;
}

declare global {
  interface Window {
    Module?: Partial<EmscriptenModule>;
  }
}
