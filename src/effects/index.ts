/**
 * obix-effects
 *
 * Scheduler primitives for OBIX effects. State-machine agnostic: the scheduler
 * re-evaluates a declared `while(state, props)` predicate after transitions and
 * stops when it becomes false. It has NO knowledge of component semantics and
 * there is no `quiesces` language feature (Draft 0.2.1 — Problem 9).
 *
 * Level 0: `every` is operational. `after` / `on` throw UnsupportedFeatureError.
 *
 * Implementation: a thin layer over the canonical scheduler of this package (`createScheduler` in ../index.ts). Registered
 * effects are armed by `start()`; each firing checks the predicate BEFORE the tick (`predicateTiming: "pre"`) and a false
 * predicate cancels the interval; `stop`/`stopAll` cancel idempotently and leave the scheduler restartable. Errors thrown by
 * a predicate or a tick propagate to whoever drives the clock (they are not deferred to a microtask).
 */
import { UnsupportedFeatureError, type EffectDescriptor } from "obix-core-spec";
import { createScheduler as createCoreScheduler, systemClock, type Clock as CoreClock, type TimerToken } from "../index.js";
import { defaultClock, type Clock } from "./clock.js";

export { defaultClock, createVirtualClock } from "./clock.js";
export type { Clock, VirtualClock } from "./clock.js";
export { UnsupportedFeatureError } from "obix-core-spec";

/** An effect descriptor plus the runtime predicate/handler the scheduler needs. */
export interface RuntimeEffect extends EffectDescriptor {
  while?: (state: unknown, props: unknown) => boolean;
}

export interface Scheduler {
  every(name: string, ms: number, whileFn: () => boolean, onTick: () => void): void;
  after(name: string, ms: number, run: () => void): never;
  on(name: string, event: string, run: () => void): never;
  start(): void;
  stop(name: string): void;
  stopAll(): void;
  readonly activeCount: number;
  readonly registeredCount: number;
}

/** The canonical scheduler needs a full clock; effects only ever use intervals, so timeouts are refused loudly. */
function toCoreClock(clock: Clock): CoreClock {
  const noTimeouts = (): never => {
    throw new UnsupportedFeatureError("effects clock timeouts (Level 0 effects use intervals only)", 1);
  };
  return {
    now: () => systemClock.now(),
    setTimeout: noTimeouts,
    clearTimeout: noTimeouts,
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (handle) => clock.clearInterval(handle),
  };
}

/**
 * Create a scheduler bound to a clock (real by default, virtual in tests).
 * `every` registers a repeating effect; on each firing the predicate is
 * checked first — false clears the interval, true runs `onTick`.
 */
export function createScheduler(clock: Clock = defaultClock): Scheduler {
  const core = createCoreScheduler({
    clock: toCoreClock(clock),
    // Effects are synchronous and drive-by-clock: a throwing predicate or tick reaches the caller of the clock.
    onError: (error) => {
      throw error;
    },
  });
  const registry = new Map<string, { ms: number; whileFn: () => boolean; onTick: () => void }>();
  const armed = new Map<string, TimerToken>();

  const stop = (name: string): void => {
    const token = armed.get(name);
    if (token === undefined) return;
    armed.delete(name);
    core.cancel(token);
  };

  return {
    every(name, ms, whileFn, onTick) {
      if (registry.has(name)) throw new Error(`[OBIX] effect "${name}" is already registered`);
      registry.set(name, { ms, whileFn, onTick });
    },
    after(name) {
      throw new UnsupportedFeatureError(`effects.after("${name}")`, 1);
    },
    on(name) {
      throw new UnsupportedFeatureError(`effects.on("${name}")`, 1);
    },
    start() {
      // Arm every registered effect that is not already armed. The predicate is checked before each tick and clears the
      // interval when it goes false — so an effect armed before its start condition becomes true still runs once it does.
      for (const [name, effect] of registry) {
        if (armed.has(name)) continue;
        const token = core.scheduleEvery(effect.onTick, effect.ms, {
          predicateTiming: "pre",
          predicate: () => {
            const keepGoing = effect.whileFn();
            if (!keepGoing) armed.delete(name); // the core cancels the interval right after this returns false
            return keepGoing;
          },
        });
        armed.set(name, token);
      }
    },
    stop,
    stopAll() {
      for (const name of [...armed.keys()]) stop(name);
    },
    get activeCount() {
      return armed.size;
    },
    get registeredCount() {
      return registry.size;
    },
  };
}

const IDENT = /^!?\s*[A-Za-z_$][\w$]*$/;

/**
 * Evaluate a Level 0 `while` predicate expressed as source text. Supports a
 * single identifier or its negation (`running`, `!running`). Anything richer
 * should be supplied as a real function on the RuntimeEffect instead.
 */
export function evaluateWhile(
  expr: string | undefined,
  state: Record<string, unknown>,
  props: Record<string, unknown>,
): boolean {
  if (!expr) return false;
  const arrow = expr.match(/=>\s*(.+?)\s*$/);
  const body = (arrow ? arrow[1]! : expr).trim().replace(/[();]/g, "");
  if (!IDENT.test(body)) {
    throw new UnsupportedFeatureError(`effects.while predicate "${expr}" (Level 0: single identifier or its negation)`, 1);
  }
  const negate = body.startsWith("!");
  const key = body.replace(/^!/, "").trim();
  const scope = { ...props, ...state } as Record<string, unknown>;
  const value = Boolean(scope[key]);
  return negate ? !value : value;
}
