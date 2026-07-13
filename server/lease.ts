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
  pid: number;
  startedAt: number;
  expiry: number; // ms epoch after which the lease is reclaimable even if the pid looks alive
};

// A lease with no explicit timeout still can't wedge a worktree forever.
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

const leaseFile = (key: string) =>
  statePath("leases", `${createHash("sha1").update(key).digest("hex")}.json`);

/** Is a pid still a running process? `kill(pid, 0)` sends no signal — it just probes existence. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  runId: string; pid: number; startedAt: number; timeoutMs?: number;
}): void {
  const lease: Lease = {
    key: input.key, worktreePath: input.worktreePath, branch: input.branch, provider: input.provider,
    runId: input.runId, pid: input.pid, startedAt: input.startedAt,
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
