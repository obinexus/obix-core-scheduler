# Frozen Timer semantics

`obix-core-scheduler` must reproduce the terminal behaviour of
`packages/obix-timer`'s `TimerDOP`. Those semantics are **frozen** — a gate in
`scripts/check-core-graph.mjs` fails if `packages/obix-timer` changes.

## The two rules

1. **Unconditional arming.** `scheduleEvery` starts the interval immediately. The
   predicate does not gate whether the interval is created.
2. **Post-tick predicate.** After each tick runs, the predicate (`while` / the
   reducer's `running` flag) is evaluated. If it is now false, the interval is
   cleared. The check happens *after* the tick, never before.

`predicateTiming` defaults to `"post"` for exactly this reason. `"pre"` is
available for callers that want the other order, but it is not the frozen model.

## Canonical traces

| Trace | Result |
|-------|--------|
| `[Start, Tick, Tick, Stop]` | `{ seconds: 2, running: false }` |
| `[Start, Tick ×8]` with `LIMIT = 5` | `{ seconds: 5, running: false }` |

The second trace shows the post-tick check: ticks 1–5 increment to 5, the tick
that reaches 5 sets `running: false`, and the interval is cleared afterwards —
ticks 6–8 never run even though `advance()` was called 8 times.

## Sync vs async ticks

`fire()` calls the user function **synchronously** and only inspects the return
value afterwards. A thenable return engages the `busy` flag so the chosen
`overrun` policy (`skip` / `queue` / `concurrent`) applies. A plain synchronous
function never sets `busy` — so the frozen traces above, whose reducer is
synchronous, are unaffected by overlap handling.

## Virtual clock

`createVirtualClock()` makes all of this deterministic in tests: `advance(ms)`
fires every due timer synchronously, `pending` counts armed timers, and no real
`setTimeout` is involved. The production path uses `systemClock` (or
`createNodeClock` when the CLI wants `unref`ed handles).
