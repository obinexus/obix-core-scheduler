/**
 * The effects layer was re-implemented on the canonical scheduler (KD-04: one timer implementation, not two).
 * This suite keeps the OLD implementation as a test-only reference model (a transcription of Level-0 `obix-effects`
 * @ obix-monorepo-2026@4e5295a, `packages/obix-effects/src/{index,clock}.ts`) and checks, on seeded random schedules, that the
 * new layer produces the same tick log, the same active/registered counts and the same clock time after every step.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler, createVirtualClock, UnsupportedFeatureError } from "../dist/effects/index.js";

// ── reference model: the Level-0 implementation ────────────────────────────────────────────────────
function legacyVirtualClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map();
  const clock = {
    setInterval(fn, ms) { const id = seq++; timers.set(id, { at: now + ms, every: Math.max(1, ms), fn }); return id; },
    clearInterval(handle) { timers.delete(handle); },
  };
  return {
    clock,
    get now() { return now; },
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      while (guard++ < 1_000_000) {
        let dueId = -1, dueAt = Infinity;
        for (const [id, t] of timers) if (t.at <= target && t.at < dueAt) { dueAt = t.at; dueId = id; }
        if (dueId === -1) break;
        const t = timers.get(dueId);
        now = t.at;
        t.fn();
        if (timers.has(dueId)) t.at += t.every;
      }
      now = target;
    },
  };
}
function legacyScheduler(clock) {
  const registry = new Map();
  const handles = new Map();
  const stop = (name) => { if (handles.has(name)) { clock.clearInterval(handles.get(name)); handles.delete(name); } };
  return {
    every(name, ms, whileFn, onTick) { if (registry.has(name)) throw new Error(`[OBIX] effect "${name}" is already registered`); registry.set(name, { ms, whileFn, onTick }); },
    start() {
      for (const [name, e] of registry) {
        if (handles.has(name)) continue;
        handles.set(name, clock.setInterval(() => { if (!e.whileFn()) { stop(name); return; } e.onTick(); }, e.ms));
      }
    },
    stop,
    stopAll() { for (const name of [...handles.keys()]) stop(name); },
    get activeCount() { return handles.size; },
    get registeredCount() { return registry.size; },
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Run one random scenario against an implementation; return the full observable log. */
function runScenario(seed, make) {
  const rnd = mulberry32(seed);
  const vc = make.clock();
  const sched = make.scheduler(vc.clock);
  const log = [];
  const counters = {};
  const names = ["a", "b", "c", "d"].slice(0, 1 + Math.floor(rnd() * 4));
  const limits = {};
  for (const name of names) {
    counters[name] = 0;
    limits[name] = 1 + Math.floor(rnd() * 6);
    const ms = [1, 7, 250, 1000, 1000, 1500][Math.floor(rnd() * 6)];
    const mode = Math.floor(rnd() * 3); // 0: stop after `limit` ticks, 1: external switch, 2: always true
    sched.every(name, ms, () => (mode === 0 ? counters[name] < limits[name] : mode === 1 ? (counters.__on ?? true) : true), () => { counters[name]++; log.push(`tick ${name} @${vc.now}`); });
  }
  counters.__on = true;
  const steps = 4 + Math.floor(rnd() * 12);
  for (let i = 0; i < steps; i++) {
    const r = rnd();
    if (r < 0.25) sched.start();
    else if (r < 0.4) sched.stop(names[Math.floor(rnd() * names.length)]);
    else if (r < 0.48) sched.stopAll();
    else if (r < 0.6) counters.__on = !counters.__on;
    else vc.advance(Math.floor(rnd() * 3000));
    log.push(`step ${i}: now=${vc.now} active=${sched.activeCount} registered=${sched.registeredCount}`);
  }
  vc.advance(20000);
  log.push(`end: now=${vc.now} active=${sched.activeCount} ticks=${JSON.stringify(counters)}`);
  return log;
}

test("500 seeded random schedules give the same observable log as the Level-0 reference model", () => {
  const legacy = { clock: legacyVirtualClock, scheduler: legacyScheduler };
  const layered = { clock: createVirtualClock, scheduler: createScheduler };
  for (let seed = 1; seed <= 500; seed++) {
    assert.deepEqual(runScenario(seed, layered), runScenario(seed, legacy), `divergence at seed ${seed}`);
  }
});

test("the comparison is not vacuous: the scenarios really tick, stop and restart", () => {
  let ticks = 0, withStops = 0, restarted = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const log = runScenario(seed, { clock: createVirtualClock, scheduler: createScheduler });
    ticks += log.filter((l) => l.startsWith("tick")).length;
    if (log.some((l) => /active=0/.test(l)) && log.some((l) => l.startsWith("tick"))) withStops++;
    if (log.filter((l) => /step \d+:.*active=[1-9]/.test(l)).length && log.some((l) => /active=0/.test(l))) restarted++;
  }
  assert.ok(ticks > 2000, `only ${ticks} ticks observed`);
  assert.ok(withStops > 100 && restarted > 100, `stops ${withStops}, restarts ${restarted}`);
});

test("a throwing tick or predicate reaches whoever advances the virtual clock (as before), and the scheduler stays usable", () => {
  const vc = createVirtualClock();
  const sched = createScheduler(vc.clock);
  let n = 0;
  sched.every("boom", 10, () => true, () => { if (++n === 2) throw new Error("tick failed"); });
  sched.start();
  assert.throws(() => vc.advance(100), /tick failed/);
  sched.stopAll();
  assert.equal(sched.activeCount, 0);
  assert.doesNotThrow(() => vc.advance(1000));
});

test("stopAll is restartable, stop is idempotent, and duplicate names are rejected", () => {
  const vc = createVirtualClock();
  const sched = createScheduler(vc.clock);
  let ticks = 0;
  sched.every("t", 100, () => true, () => { ticks++; });
  assert.throws(() => sched.every("t", 1, () => true, () => {}), /already registered/);
  sched.start(); sched.start();
  assert.equal(sched.activeCount, 1);
  vc.advance(300);
  sched.stop("t"); sched.stop("t"); sched.stop("never-registered");
  vc.advance(300);
  assert.equal(ticks, 3);
  sched.start();
  vc.advance(200);
  assert.equal(ticks, 5);
  sched.stopAll(); sched.stopAll();
  assert.equal(sched.activeCount, 0);
  assert.equal(vc.now, 800);
});

test("the effects layer uses no real timers: a virtual clock with pending effects leaves nothing scheduled on the host", () => {
  const vc = createVirtualClock();
  const sched = createScheduler(vc.clock);
  sched.every("t", 5, () => true, () => {});
  sched.start();
  sched.stopAll();
  assert.equal(vc.clock.pending, 0);
});

test("timeouts are refused loudly (Level 0 effects are interval-only)", () => {
  const fakeClock = { setInterval: () => 1, clearInterval: () => {} };
  const sched = createScheduler(fakeClock);
  assert.throws(() => sched.after("x", 1, () => {}), UnsupportedFeatureError);
});
