// A preview service is "ready" only when its port answers — but `nest start --watch` (the backend dev
// script) stays alive on a boot failure instead of exiting, so "process alive" alone never clears. Left
// unchecked the card spins on "Starting…" forever. svcHealth caps that: a service alive-but-not-up past
// BOOT_TIMEOUT_MS is reported not-running, so the client's crash path (reap + log + Retry) fires.
import { expect, test } from "bun:test";
import { BOOT_TIMEOUT_MS, svcHealth } from "../server/preview";

const START = 1_000_000;
const within = START + BOOT_TIMEOUT_MS - 1;
const past = START + BOOT_TIMEOUT_MS + 1;

test("a port that answers is ready regardless of elapsed time", () => {
  expect(svcHealth(true, true, START, past)).toEqual({ running: true, ready: true });
});

test("alive but not up yet, still within the boot window → running, not ready (legitimately starting)", () => {
  expect(svcHealth(true, false, START, within)).toEqual({ running: true, ready: false });
});

test("alive but not up PAST the boot window → not running, so the client reaps it instead of hanging", () => {
  // The whole point: a wedged `nest --watch` is alive but never binds. Without this it spins forever.
  expect(svcHealth(true, false, START, past)).toEqual({ running: false, ready: false });
});

test("a crashed (exited) process is never running, even before the timeout", () => {
  expect(svcHealth(false, false, START, within)).toEqual({ running: false, ready: false });
});
