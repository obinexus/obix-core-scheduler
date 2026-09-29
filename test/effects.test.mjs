import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler, createVirtualClock, evaluateWhile, UnsupportedFeatureError } from "../dist/effects/index.js";

test("every fires until the while predicate goes false (quiescence)", () => {
  const vc = createVirtualClock();
  const sched = createScheduler(vc.clock);
  let ticks = 0;
  let running = true;
  sched.every("tick", 1000, () => running, () => {
    ticks++;
    if (ticks >= 5) running = false;
  });
  sched.start();
  vc.advance(20000);
  assert.equal(ticks, 5);
  assert.equal(sched.activeCount, 0);
});

test("after / on are Level 1 — they throw UnsupportedFeatureError", () => {
  const sched = createScheduler(createVirtualClock().clock);
  assert.throws(() => sched.after("x", 10, () => {}), UnsupportedFeatureError);
  assert.throws(() => sched.on("y", "z", () => {}), UnsupportedFeatureError);
});

test("evaluateWhile supports identifier + negation only", () => {
  assert.equal(evaluateWhile("({ running }) => running", { running: true }, {}), true);
  assert.equal(evaluateWhile("!running", { running: true }, {}), false);
  assert.throws(() => evaluateWhile("running && seconds < limitSeconds", {}, {}), UnsupportedFeatureError);
});
