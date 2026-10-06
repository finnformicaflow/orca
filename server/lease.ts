// Durable per-worktree run leases. A lease says "provider X, run Y, pid Z is live in this worktree",
// and it survives a bridge restart — so after a crash/restart a second Fix-CI/Follow-up won't launch
// over an agent that's still running (the in-memory run map is gone, but the lease file isn't).
//
// A lease is honoured only while it's genuinely live: its pid is still alive AND it hasn't passed its
// expiry (tied to the run's timeout). A dead or expired lease is reclaimable — we never wedge a
// worktree on a stale file. PID reuse is bounded by expiry: if the bridge dies without releasing and
// the OS later recycles the pid, the lease self-heals at expiry rather than lingering forever.
import { createHash } from "crypto";
import { readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { statePath, stateDir, writeJsonSync, readJsonSync } from "./state";
import type { AgentProvider } from "../shared/agent";

export type Lease = {
  key: string; // the run key — the worktree path for feature/fix runs
  worktreePath: string;
  branch?: string;
  provider: AgentProvider;
  runId: string;
  sessionId?: string; // the provider session the run is on — two live runs must never share one
  pid: number;
  startedAt: number;
  expiry: number; // ms epoch after which the lease is reclaimable even if the pid looks alive
};

// A lease with no explicit timeout still can't wedge a worktree forever.
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

const leaseFile = (key: string) =>
  statePath("leases", `${createHash("sha1").update(key).digest("hex")}.json`);

/** Is a pid still a running process? `kill(pid, 0)` sends no signal — it just probes existence.
 *  A zombie passes that probe: a child that exited after the bridge that spawned it restarted is
 *  never reaped, so it sits `<defunct>` and its lease read as live until expiry — 45 minutes of a
 *  card saying "running" about a run that had finished. `ps` tells a zombie (state Z) from a live one. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const out = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return !out.stdout.toString().trim().startsWith("Z");
  } catch { return true; } // no ps: the probe is all we have
}

function isLive(lease: Lease | undefined): lease is Lease {
  return Boolean(lease) && Date.now() < lease!.expiry && pidAlive(lease!.pid);
}

/** A live lease exists for this key (blocks an overlapping launch). */
export function leased(key: string): boolean {
  return isLive(readJsonSync<Lease>(leaseFile(key)));
}

/** Record a live run. Callers gate on `leased(key)` first; this just persists the claim. */
export function acquire(input: {
  key: string; worktreePath: string; branch?: string; provider: AgentProvider;
  runId: string; sessionId?: string; pid: number; startedAt: number; timeoutMs?: number;
}): void {
  const lease: Lease = {
    key: input.key, worktreePath: input.worktreePath, branch: input.branch, provider: input.provider,
    runId: input.runId, sessionId: input.sessionId, pid: input.pid, startedAt: input.startedAt,
    expiry: input.startedAt + (input.timeoutMs ?? DEFAULT_TTL_MS),
  };
  writeJsonSync(leaseFile(input.key), lease);
}

/** Drop a lease. With `runId`, only if it still owns the key — so a re-run's fresh lease isn't
 *  cleared by the previous run's completion handler. */
export function release(key: string, runId?: string): void {
  const path = leaseFile(key);
  if (runId) {
    const current = readJsonSync<Lease>(path);
    if (current && current.runId !== runId) return; // superseded — leave the new owner's lease
  }
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Is a live run already on this provider session? Two runs resuming one session at once each
 *  append to the same transcript and end with the same reply — the orchestrator's "one message
 *  behind" bug. Read from the lease files, so it holds across a bridge restart as well. */
export function sessionBusy(sessionId: string): boolean {
  let files: string[];
  try { files = readdirSync(join(stateDir(), "leases")); } catch { return false; }
  return files.some((file) => {
    if (!file.endsWith(".json")) return false;
    const lease = readJsonSync<Lease>(join(stateDir(), "leases", file));
    return isLive(lease) && lease.sessionId === sessionId;
  });
}

/** Every live lease — what a restarted bridge adopts (see agent.adoptLeases). */
export function live(): Lease[] {
  let files: string[];
  try { files = readdirSync(join(stateDir(), "leases")); } catch { return []; }
  return files.filter((f) => f.endsWith(".json")).map((f) => readJsonSync<Lease>(join(stateDir(), "leases", f))).filter(isLive);
}

/** The lease a key currently holds, live or not (a dead one is what tells adoption the run ended). */
export const current = (key: string): Lease | undefined => readJsonSync<Lease>(leaseFile(key));

/** Run ids that currently hold a live lease. Lets a restart tell a genuinely still-running turn from
 *  one whose process died with the previous bridge (see db.reconcileRunning). */
export function liveRunIds(): Set<string> {
  const found = new Set<string>();
  let files: string[];
  try { files = readdirSync(join(stateDir(), "leases")); } catch { return found; }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const lease = readJsonSync<Lease>(join(stateDir(), "leases", file));
    if (isLive(lease)) found.add(lease.runId);
  }
  return found;
}

/** Branches that currently hold a live lease — restart recovery that doesn't depend on the branch
 *  name appearing in the process's argv (a Claude follow-up's argv carries only the session id). */
export function liveBranches(branches: string[]): Set<string> {
  const wanted = new Set(branches.filter(Boolean));
  const found = new Set<string>();
  let files: string[];
  try { files = readdirSync(join(stateDir(), "leases")); } catch { return found; }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const lease = readJsonSync<Lease>(join(stateDir(), "leases", file));
    if (!isLive(lease)) continue;
    if (lease.branch && wanted.has(lease.branch)) found.add(lease.branch);
  }
  return found;
}
