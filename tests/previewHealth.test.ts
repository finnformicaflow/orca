// A preview service is "ready" only when its port answers — but `nest start --watch` (the backend dev
// script) stays alive on a boot failure instead of exiting, so "process alive" alone never clears. Left
// unchecked the card spins on "Starting…" forever. svcHealth caps that: a service that has NEVER bound
// its port past BOOT_TIMEOUT_MS is reported not-running, so the client's crash path (reap + log + Retry)
// fires. Crucially the cap applies ONLY before the service is ever up: once it has been ready, a failed
// probe is a transient blip (event loop blocked on a long request), NOT a boot failure — reaping it then
// would kill a healthy busy server and drop its per-preview DB.
import { expect, test } from "bun:test";
import { BOOT_TIMEOUT_MS, svcHealth } from "../server/preview";

const START = 1_000_000;
const within = START + BOOT_TIMEOUT_MS - 1;
const past = START + BOOT_TIMEOUT_MS + 1;

test("a port that answers is ready regardless of elapsed time", () => {
  expect(svcHealth(true, true, true, START, past)).toEqual({ running: true, ready: true });
});

test("never up yet, still within the boot window → running, not ready (legitimately starting)", () => {
  expect(svcHealth(true, false, false, START, within)).toEqual({ running: true, ready: false });
});

test("never up PAST the boot window → not running, so the client reaps it instead of hanging", () => {
  // The whole point: a wedged `nest --watch` is alive but never binds. Without this it spins forever.
  expect(svcHealth(true, false, false, START, past)).toEqual({ running: false, ready: false });
});

test("already been up then a probe blips past the window → STAYS running (not reaped)", () => {
  // The regression that dropped the master DB: a backend up for minutes, momentarily unresponsive
  // (blocked on a huge streamChat), was flagged wedged → reaped → its DB torn down. everUp guards it.
  expect(svcHealth(true, false, true, START, past)).toEqual({ running: true, ready: false });
});

test("a crashed (exited) process is never running, even before the timeout", () => {
  expect(svcHealth(false, false, false, START, within)).toEqual({ running: false, ready: false });
});
