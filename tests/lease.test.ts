import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lease from "../server/lease";
import * as agent from "../server/agent";

// Isolate the operational-state dir so leases land in a scratch dir, never the real ~/.orca.
beforeAll(() => { process.env.ORCA_STATE_DIR = mkdtempSync(join(tmpdir(), "orca-state-")); });

const base = { worktreePath: "/wt/feat", branch: "feat", provider: "claude" as const, startedAt: Date.now() };
afterEach(() => { lease.release("/wt/feat"); lease.release("/wt/other"); });

describe("durable run leases", () => {
  test("a live lease blocks an overlapping run and clears on release", () => {
    expect(lease.leased("/wt/feat")).toBe(false);
    lease.acquire({ key: "/wt/feat", ...base, runId: "r1", pid: process.pid, timeoutMs: 60_000 });
    expect(lease.leased("/wt/feat")).toBe(true);
    lease.release("/wt/feat");
    expect(lease.leased("/wt/feat")).toBe(false);
  });

  test("an expired lease is reclaimable even while its pid is alive", () => {
    lease.acquire({ key: "/wt/feat", ...base, startedAt: Date.now() - 10_000, runId: "r1", pid: process.pid, timeoutMs: 1 });
    expect(lease.leased("/wt/feat")).toBe(false); // past expiry → reclaimable, no wedged worktree
  });

  test("a lease whose process has died is reclaimable", () => {
    lease.acquire({ key: "/wt/feat", ...base, runId: "r1", pid: 2 ** 30, timeoutMs: 60_000 });
    expect(lease.leased("/wt/feat")).toBe(false);
  });

  test("release only frees the lease when the runId still owns it (re-run protection)", () => {
    lease.acquire({ key: "/wt/feat", ...base, runId: "r2", pid: process.pid, timeoutMs: 60_000 });
    lease.release("/wt/feat", "r1"); // the superseded run's completion handler
    expect(lease.leased("/wt/feat")).toBe(true); // r2 still owns it
    lease.release("/wt/feat", "r2");
    expect(lease.leased("/wt/feat")).toBe(false);
  });

  test("liveBranches recovers leased branches after a restart lost the run map", () => {
    lease.acquire({ key: "/wt/feat", ...base, runId: "r1", pid: process.pid, timeoutMs: 60_000 });
    lease.acquire({ key: "/wt/other", worktreePath: "/wt/other", branch: "dead", provider: "claude", startedAt: Date.now(), runId: "r2", pid: 2 ** 30, timeoutMs: 60_000 });
    expect(lease.liveBranches(["feat", "dead", "absent"])).toEqual(new Set(["feat"]));
  });

  test("agent.isRunning and launch honour a lease left by a prior bridge", () => {
    lease.acquire({ key: "/wt/feat", ...base, runId: "r1", pid: process.pid, timeoutMs: 60_000 });
    expect(agent.isRunning("/wt/feat")).toBe(true);
    expect(() => agent.launch("/wt/feat", "/wt/feat", "go")).toThrow("already running");
    lease.release("/wt/feat");
    expect(agent.isRunning("/wt/feat")).toBe(false);
  });
});
