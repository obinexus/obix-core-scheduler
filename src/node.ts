/**
 * obix-core-scheduler/node
 *
 * A `Clock` whose timer handles are `unref()`d so a pending interval does not
 * keep the CLI process alive — used for background watch/poll loops. Importing
 * this touches `node:timers` semantics (via the global timer objects); do not
 * import it from a portable context.
 */
import type { Clock } from "./index.js";
import { supportsRefUnref } from "./index.js";

export interface NodeClockOptions {
  /** `false` (default) → `unref()` handles so they never block process exit. */
  keepAlive?: boolean;
}

export function createNodeClock(opts: NodeClockOptions = {}): Clock {
  const keepAlive = opts.keepAlive === true;
  const canUnref = !keepAlive && supportsRefUnref();
  const tune = (h: unknown): unknown => {
    if (canUnref && h && typeof (h as { unref?: () => void }).unref === "function") {
      (h as { unref: () => void }).unref();
    }
    return h;
  };
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => tune(setTimeout(fn, ms)),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => tune(setInterval(fn, ms)),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
}

export type { Clock } from "./index.js";
