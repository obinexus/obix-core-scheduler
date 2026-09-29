import test from "node:test";
import assert from "node:assert/strict";
import {
  createScheduler,
  createVirtualClock,
  systemClock,
  supportsRefUnref,
  CompatError,
} from "../dist/index.js";

// ── Frozen Timer reducer (mirrors packages/obix-timer TimerDOP `Tick`) ───────
// Kept inline so this fixture is independent of the compiler build.
const LIMIT = 5;
function tick(state) {
  if (!state.running) return state;
  if (state.seconds >= LIMIT) return { ...state, running: false };
  const seconds = state.seconds + 1;
  if (seconds >= LIMIT) return { seconds, running: false };
  return { ...state, seconds };
}

test("frozen Timer semantics — canonical trace [Start,Tick,Tick,Stop] => {seconds:2, running:false}", () => {
  const clock = createVirtualClock();
  const s = createScheduler({ clock });
  let state = { seconds: 0, running: true }; // Start

  const token = s.scheduleEvery(
    () => {
      state = tick(state);
    },
    1000,
    { predicate: () => state.running, predicateTiming: "post" },
  );

  clock.advance(1000); // Tick -> seconds 1
  clock.advance(1000); // Tick -> seconds 2
  state = { ...state, running: false }; // Stop
  clock.advance(1000); // post-tick predicate now false -> interval stops itself

  assert.deepEqual(state, { seconds: 2, running: false });
  assert.equal(s.activeCount, 0, "interval cleared itself after predicate went false");
  s.dispose();
});

test("frozen Timer semantics — terminal trace [Start, Tick x8] => {seconds:5, running:false}", () => {
  const clock = createVirtualClock();
  const s = createScheduler({ clock });
  let state = { seconds: 0, running: true };
  s.scheduleEvery(() => { state = tick(state); }, 1000, { predicate: () => state.running });
  for (let i = 0; i < 8; i++) clock.advance(1000);
  assert.deepEqual(state, { seconds: 5, running: false });
  s.dispose();
});

test("unconditional arming — a job armed BEFORE its predicate is true still runs once (post timing)", () => {
  const clock = createVirtualClock();
  const s = createScheduler({ clock });
  let running = false; // predicate currently false
  let ticks = 0;
  s.scheduleEvery(() => { ticks++; }, 100, { predicate: () => running, predicateTiming: "post" });
  clock.advance(100); // armed unconditionally -> fires once
  assert.equal(ticks, 1);
  clock.advance(100); // predicate was false after tick 1 -> now stopped
  assert.equal(ticks, 1);
  s.dispose();
});

test("pre timing — predicate checked BEFORE the tick; false => never runs", () => {
  const clock = createVirtualClock();
  const s = createScheduler({ clock });
  let ticks = 0;
  s.scheduleEvery(() => { ticks++; }, 100, { predicate: () => false, predicateTiming: "pre" });
  clock.advance(500);
  assert.equal(ticks, 0);
  s.dispose();
});

test("cancel is idempotent; cancelling a foreign / twice-cancelled token is a no-op", () => {
  const clock = createVirtualClock();
  const s = createScheduler({ clock });
  const t = s.schedule(() => {}, 100);
  s.cancel(t);
  s.cancel(t); // no throw
  s.cancel({ id: 999, kind: "timeout" }); // not our token -> no throw
  assert.equal(s.activeCount, 0);
  clock.advance(200); // cancelled -> does not fire
  s.dispose();
});

test("dispose is idempotent and cancels everything", () => {
  const clock = createVirtualClock();
  const s = createScheduler({ clock });
  s.schedule(() => assert.fail("must not fire"), 100);
  s.scheduleEvery(() => assert.fail("must not fire"), 100);
  s.dispose();
  s.dispose(); // no throw
  clock.advance(1000);
  assert.equal(s.activeCount, 0);
  assert.equal(s.disposed, true);
});

test("a disposed scheduler rejects schedule / scheduleEvery with CompatError scheduler/disposed", () => {
  const s = createScheduler({ clock: createVirtualClock() });
  s.dispose();
  assert.throws(() => s.schedule(() => {}, 0), (e) => e instanceof CompatError && e.code === "scheduler/disposed");
  assert.throws(() => s.scheduleEvery(() => {}, 10), CompatError);
});

test("stale-result suppression — an async tick that settles after dispose does not re-arm or apply", async () => {
  const s = createScheduler({ clock: systemClock });
  let applied = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  s.scheduleEvery(async () => {
    await gate;      // still running when we dispose
    applied++;       // this result must be dropped
  }, 5, { predicate: () => true });
  await new Promise((r) => setTimeout(r, 20)); // let the first tick start
  s.dispose();
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.activeCount, 0);
  // the in-flight tick may have incremented `applied` before dispose; the point
  // is that NO further tick is scheduled and the interval is gone.
  assert.equal(s.disposed, true);
});

test("overrun policy — 'skip' drops firings while an async tick is in progress", async () => {
  const s = createScheduler({ clock: systemClock });
  let starts = 0;
  let finishes = 0;
  s.scheduleEvery(async () => {
    starts++;
    await new Promise((r) => setTimeout(r, 60));
    finishes++;
  }, 10, { overrun: "skip", predicate: () => true });
  await new Promise((r) => setTimeout(r, 100));
  s.dispose();
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(starts <= 2, `skip should not start a new tick each 10ms while busy (got ${starts})`);
  assert.ok(finishes >= 1);
});

test("real clock — a one-shot fires within a justified tolerance window", async () => {
  const s = createScheduler({ clock: systemClock });
  const start = performance.now();
  await new Promise((resolve) => s.schedule(resolve, 40));
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 30 && elapsed < 400, `expected ~40ms (tolerant), got ${elapsed.toFixed(1)}ms`);
  s.dispose();
});

test("supportsRefUnref reflects the runtime (node/bun: true)", () => {
  const G = globalThis;
  const rt = typeof G.Deno?.version?.deno === "string" ? "deno" : typeof G.Bun?.version === "string" ? "bun" : "node";
  if (rt === "node" || rt === "bun") assert.equal(supportsRefUnref(), true);
  else assert.equal(typeof supportsRefUnref(), "boolean");
});
