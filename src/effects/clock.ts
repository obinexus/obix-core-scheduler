/**
 * The Level-0 clock surface of the effects layer, implemented on the canonical clocks of this package
 * (`systemClock`, `createVirtualClock` in ../index.ts) — there is one timer implementation, not two.
 */
import { createVirtualClock as createCoreVirtualClock, systemClock } from "../index.js";

/** Minimal clock abstraction so effects are environment-agnostic and testable (a subset of the canonical `Clock`). */
export interface Clock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const defaultClock: Clock = {
  setInterval: (fn, ms) => systemClock.setInterval(fn, ms),
  clearInterval: (h) => systemClock.clearInterval(h),
};

export interface VirtualClock {
  readonly clock: Clock;
  advance(ms: number): void;
  readonly now: number;
}

/** Deterministic clock for tests — no real timers. Time moves only through `advance()`. */
export function createVirtualClock(): VirtualClock {
  const virtual = createCoreVirtualClock(0);
  return {
    clock: virtual,
    advance: (ms: number) => virtual.advance(ms),
    get now() {
      return virtual.now();
    },
  };
}
