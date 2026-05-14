// Tiger Style assertion core.
//
// Philosophy:
//  * Assert positive AND negative conditions.
//  * Assert on entry AND exit of every non-trivial function.
//  * Assertions check invariants, never user input.
//  * Cheap enough to leave on in production for hot loops; for ultra-hot
//    inner loops use `dassert` which compiles out via DATA_CORE_NDEBUG.
//
// All assertions throw — they never silently log. Failure means a bug.

export class AssertionError extends Error {
  constructor(message: string) {
    super(`assertion failed: ${message}`);
    this.name = "AssertionError";
  }
}

const NDEBUG = (() => {
  // Browser builds don't see `process`; Node + Vite-defined envs do. Read
  // through globalThis so the check works in either environment without
  // requiring @types/node in consumers.
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.DATA_CORE_NDEBUG === "1";
})();

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

/** Debug-only assertion — stripped when DATA_CORE_NDEBUG=1. */
export function dassert(cond: unknown, msg: string): void {
  if (NDEBUG) return;
  if (!cond) throw new AssertionError(msg);
}

export function assertFinite(n: number, msg: string): void {
  if (!Number.isFinite(n)) throw new AssertionError(`${msg}: not finite (${n})`);
}

export function assertInRange(
  n: number,
  lo: number,
  hi: number,
  msg: string,
): void {
  if (!Number.isFinite(n) || n < lo || n > hi) {
    throw new AssertionError(`${msg}: ${n} not in [${lo}, ${hi}]`);
  }
}

export function assertU32(n: number, msg: string): void {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new AssertionError(`${msg}: ${n} not u32`);
  }
}

export function assertEq<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new AssertionError(`${msg}: ${String(a)} !== ${String(b)}`);
}

/** Bounded loop guard. Throws if iterations would exceed `max`.
 *  Wrap any loop whose bound is derived from external data. */
export function checkLoopBound(i: number, max: number, msg: string): void {
  if (i >= max) throw new AssertionError(`${msg}: loop exceeded ${max}`);
}
