/**
 * obix-core-scheduler
 *
 * Injected monotonic clock, opaque timer tokens, idempotent cancellation and
 * disposal, and explicit interval-overrun / async-overlap policy.
 *
 * Portable root: no timer is started at import time. This bridges — not
 * replaces — the frozen OBIX effect model: a repeating job is **armed
 * unconditionally** and its `predicate` is checked **after** each tick by
 * default (`predicateTiming: "post"`), matching `obix-effects`'
 * "armed before its start condition becomes true still runs" behaviour.
 *
 * It introduces no new effect language and no component-state engine.
 */
import { CompatError, probeCapabilities } from "obix-core-capabilities";

export { CompatError } from "obix-core-capabilities";

// ── clock ───────────────────────────────────────────────────────────────────

export interface Clock {
  /** Monotonic milliseconds. Never goes backwards; not wall-clock. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Real clock: `performance.now()` for elapsed time, host timers for scheduling. */
export const systemClock: Clock = {
  now: () =>
    typeof (globalThis as { performance?: { now?: () => number } }).performance?.now === "function"
      ? (globalThis as { performance: { now: () => number } }).performance.now()
      : Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface VirtualClock extends Clock {
  /** Advance virtual time by `ms`, firing every timer due in that window in order. */
  advance(ms: number): void;
  /** Current queued (not-yet-fired) timer count. */
  readonly pending: number;
}

/**
 * Deterministic clock for proving semantics. Time only moves via `advance()`.
 * Intervals re-queue themselves after firing.
 */
export function createVirtualClock(startMs = 0): VirtualClock {
  let t = startMs;
  let seq = 0;
  interface Entry {
    id: number;
    due: number;
    period: number | null; // null = one-shot
    fn: () => void;
    dead: boolean;
  }
  const q: Entry[] = [];
  const add = (fn: () => void, ms: number, period: number | null): number => {
    const id = ++seq;
    q.push({ id, due: t + Math.max(0, ms), period, fn, dead: false });
    return id;
  };
  const kill = (h: unknown) => {
    const e = q.find((x) => x.id === h);
    if (e) e.dead = true;
  };
  return {
    now: () => t,
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: kill,
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms)),
    clearInterval: kill,
    get pending() {
      return q.filter((e) => !e.dead).length;
    },
    advance(ms: number) {
      const target = t + ms;
      // fire in due order, honouring timers scheduled by earlier callbacks
      for (;;) {
        const next = q
          .filter((e) => !e.dead && e.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        t = next.due;
        if (next.period == null) next.dead = true;
        else next.due = t + next.period;
        if (!next.dead || next.period == null) next.fn();
        // clean one-shots
        for (let i = q.length - 1; i >= 0; i--) if (q[i]!.dead) q.splice(i, 1);
      }
      t = target;
    },
  };
}

// ── tokens ──────────────────────────────────────────────────────────────────

const TOKEN = Symbol("obix-core-scheduler/token");

export interface TimerToken {
  readonly [TOKEN]: true;
  readonly id: number;
  readonly kind: "timeout" | "interval";
}

// ── scheduler ───────────────────────────────────────────────────────────────

export type OverrunPolicy = "skip" | "queue" | "concurrent";
export type PredicateTiming = "pre" | "post";

export interface EveryOptions {
  /**
   * What to do when a firing lands while the previous **async** tick is still
   * running:
   *  - `"skip"`       (default) — drop this firing
   *  - `"queue"`      — run exactly one catch-up tick after the current settles
   *  - `"concurrent"` — fire regardless (you accept overlap)
   */
  overrun?: OverrunPolicy;
  /** Optional gate. `false` stops the interval. */
  predicate?: () => boolean;
  /**
   * When to check `predicate`:
   *  - `"post"` (default) — arm unconditionally; check AFTER the tick. This is
   *    the frozen OBIX Timer contract: a job armed before its condition is true
   *    still runs once, then the predicate stops it.
   *  - `"pre"` — check BEFORE the tick; skip (and stop) when false.
   */
  predicateTiming?: PredicateTiming;
  /** Called if `predicate` / `fn` throws, or an async `fn` rejects. */
  onError?: (err: unknown) => void;
}

export interface SchedulerAPI {
  /** One-shot. Returns an opaque token. */
  schedule(fn: () => void | Promise<void>, delayMs: number): TimerToken;
  /** Repeating. See {@link EveryOptions}. */
  scheduleEvery(fn: () => void | Promise<void>, intervalMs: number, opts?: EveryOptions): TimerToken;
  /** Idempotent — cancelling twice, or after dispose, is a no-op. */
  cancel(token: TimerToken): void;
  /** Idempotent. Cancels every owned timer; results of in-flight async ticks are dropped. */
  dispose(): void;
  /** Number of live owned timers. */
  readonly activeCount: number;
  readonly disposed: boolean;
}

export interface SchedulerOptions {
  clock?: Clock;
  /** Fallback error sink for jobs that do not pass their own `onError`. */
  onError?: (err: unknown) => void;
}

export function createScheduler(opts: SchedulerOptions = {}): SchedulerAPI {
  const clock = opts.clock ?? systemClock;
  const fallbackOnError = opts.onError ?? ((e: unknown) => queueMicrotask(() => { throw e; }));
  let disposed = false;
  let seq = 0;

  interface Owned {
    token: TimerToken;
    handle: unknown;
    kind: "timeout" | "interval";
    /** bumped on cancel/dispose so a settling async tick can detect it is stale */
    epoch: number;
    /** async-overlap state for intervals */
    busy: boolean;
    queued: boolean;
  }
  const owned = new Map<number, Owned>();

  function requireLive(op: string): void {
    if (disposed) {
      throw new CompatError({
        code: "scheduler/disposed",
        package: "obix-core-scheduler",
        operation: op,
        reason: "the scheduler has been disposed",
        remediation: "Create a new scheduler; a disposed one cannot be reused.",
      });
    }
  }

  function mkToken(kind: "timeout" | "interval"): TimerToken {
    return Object.freeze({ [TOKEN]: true as const, id: ++seq, kind });
  }

  function schedule(fn: () => void | Promise<void>, delayMs: number): TimerToken {
    requireLive("schedule");
    const token = mkToken("timeout");
    const rec: Owned = { token, handle: null, kind: "timeout", epoch: 0, busy: false, queued: false };
    owned.set(token.id, rec);
    rec.handle = clock.setTimeout(() => {
      const myEpoch = rec.epoch;
      owned.delete(token.id); // one-shot: no longer owned once it fires
      void runOnce(fn, () => rec.epoch === myEpoch && !disposed, fallbackOnError);
    }, Math.max(0, delayMs));
    return token;
  }

  function scheduleEvery(
    fn: () => void | Promise<void>,
    intervalMs: number,
    o: EveryOptions = {},
  ): TimerToken {
    requireLive("scheduleEvery");
    const overrun: OverrunPolicy = o.overrun ?? "skip";
    const timing: PredicateTiming = o.predicateTiming ?? "post";
    const onErr = o.onError ?? fallbackOnError;
    const token = mkToken("interval");
    const rec: Owned = { token, handle: null, kind: "interval", epoch: 0, busy: false, queued: false };
    owned.set(token.id, rec);

    const gate = (): boolean => {
      // returns false when the interval should stop
      if (!o.predicate) return true;
      try {
        return o.predicate() !== false;
      } catch (err) {
        onErr(err);
        return false;
      }
    };

    const postTick = (myEpoch: number): void => {
      // stale-result suppression
      if (rec.epoch !== myEpoch || disposed || !owned.has(token.id)) return;
      if (timing === "post" && !gate()) {
        cancel(token);
        return;
      }
      if (rec.queued) {
        rec.queued = false;
        fire();
      }
    };

    /** Synchronous entry from the host interval. Only async ticks engage `busy`. */
    const fire = (): void => {
      if (disposed || !owned.has(token.id)) return;
      const myEpoch = rec.epoch;

      // async-overlap: `busy` is only ever true when a PRIOR tick returned a
      // pending promise. A synchronous `fn` never sets it.
      if (rec.busy) {
        if (overrun === "skip") return;
        if (overrun === "queue") {
          rec.queued = true;
          return;
        }
        // "concurrent" -> fall through
      }

      // PRE gate
      if (timing === "pre" && !gate()) {
        cancel(token);
        return;
      }

      let ret: void | Promise<void>;
      try {
        ret = fn();
      } catch (err) {
        onErr(err);
        postTick(myEpoch);
        return;
      }

      if (ret && typeof (ret as Promise<void>).then === "function") {
        rec.busy = true;
        (ret as Promise<void>).then(
          () => {
            rec.busy = false;
            postTick(myEpoch);
          },
          (err) => {
            rec.busy = false;
            if (rec.epoch === myEpoch && !disposed) onErr(err);
            postTick(myEpoch);
          },
        );
      } else {
        postTick(myEpoch);
      }
    };

    rec.handle = clock.setInterval(fire, Math.max(1, intervalMs));
    return token;
  }

  function cancel(token: TimerToken): void {
    if (!token || (token as { [TOKEN]?: true })[TOKEN] !== true) return;
    const rec = owned.get(token.id);
    if (!rec) return; // already gone / never ours -> idempotent no-op
    rec.epoch++; // any settling async tick is now stale
    if (rec.kind === "timeout") clock.clearTimeout(rec.handle);
    else clock.clearInterval(rec.handle);
    owned.delete(token.id);
  }

  function dispose(): void {
    if (disposed) return; // idempotent
    disposed = true;
    for (const rec of owned.values()) {
      rec.epoch++;
      if (rec.kind === "timeout") clock.clearTimeout(rec.handle);
      else clock.clearInterval(rec.handle);
    }
    owned.clear();
  }

  return {
    schedule,
    scheduleEvery,
    cancel,
    dispose,
    get activeCount() {
      return owned.size;
    },
    get disposed() {
      return disposed;
    },
  };
}

async function runOnce(
  fn: () => void | Promise<void>,
  stillValid: () => boolean,
  onErr: (e: unknown) => void,
): Promise<void> {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") await r;
  } catch (err) {
    if (stillValid()) onErr(err);
  }
}

/** True when this runtime lets timer handles be `unref()`d — behind a capability. */
export function supportsRefUnref(): boolean {
  return probeCapabilities(["ref-unref"])["ref-unref"].status === "available";
}
