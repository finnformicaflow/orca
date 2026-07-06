// Per-workstream preview: spins up each configured service (frontend, backend, …) via `sh -lc`
// so shell scripts + env prefixes work. Services for one workstream are tracked together, keyed by
// the worktree path, and started in the background on OS-verified free ports.
//
// Two hazards this guards against, both of which manifested as "the link works but shows stale
// code / then goes red":
//   1. Orphaned servers. `proc.kill()` on the `sh -lc` wrapper doesn't reap the node (nest/vite)
//      grandchildren, and a bridge restart drops the in-memory map entirely — so servers pile up,
//      holding ports and serving old code. Because the key IS the worktree path, we `pkill -f` that
//      path to reap them before (re)starting.
//   2. Port collisions. Picking a port from the in-memory map alone hands out ports those orphans
//      (or anything else on the machine) still hold, so the new server crashes on bind. We probe
//      the OS for a genuinely free port instead.
import { createServer } from "node:net";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewService } from "./config";

type Svc = { name: string; port: number; open: boolean; proc: Bun.Subprocess; logPath: string; logFd: number; exited: boolean };
export type SvcStatus = { name: string; port: number; url: string; open: boolean; running: boolean; ready: boolean; error?: string };

const previews = new Map<string, Svc[]>();

/** True if nothing is currently bound to `port`, checked against the OS (so an orphaned server from
 *  a prior run counts as taken — the in-memory map can't know about it after a restart). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

async function freePort(range: [number, number], taken: Set<number>): Promise<number> {
  for (let p = range[0]; p <= range[1]; p++) {
    if (!taken.has(p) && (await portFree(p))) return p;
  }
  throw new Error(`no free port in ${range[0]}–${range[1]}`);
}

/** Reap any process still running inside this worktree (nest/vite from a prior preview) — the node
 *  children the sh wrapper's kill misses. Synchronous so it also works during shutdown. Agents run
 *  `claude` without the abs worktree path in argv, so they aren't matched. */
function killWorktree(cwd: string): void {
  try { Bun.spawnSync(["pkill", "-f", cwd]); } catch { /* pkill exits non-zero when nothing matches */ }
}

export async function start(key: string, cwd: string, services: PreviewService[], portRange: [number, number]): Promise<void> {
  stop(key); // reap tracked procs + orphaned servers for this worktree so we never serve stale code
  const ports: Record<string, number> = {};
  const taken = new Set<number>();
  for (const s of services) { ports[s.name] = await freePort(portRange, taken); taken.add(ports[s.name]!); }
  const svcs: Svc[] = services.map((s) => {
    const cmd = s.command
      .replace(/\{port\}/g, String(ports[s.name]))
      .replace(/\{svc:(\w+)\}/g, (_, n) => String(ports[n] ?? ""));
    const logPath = join(tmpdir(), `orca-preview-${key.replace(/[^\w]+/g, "_")}-${s.name}.log`);
    const logFd = openSync(logPath, "w"); // capture output so a failed service is diagnosable
    const proc = Bun.spawn(["sh", "-lc", cmd], { cwd, env: process.env, stdout: logFd, stderr: logFd });
    const svc: Svc = { name: s.name, port: ports[s.name]!, open: s.open ?? false, proc, logPath, logFd, exited: false };
    void proc.exited.then(() => { svc.exited = true; });
    return svc;
  });
  previews.set(key, svcs);
}

async function portReady(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(700) });
    return true; // any HTTP response means the server is up
  } catch {
    return false; // connection refused / timeout — not up yet
  }
}

const tail = async (path: string): Promise<string> => {
  try { return (await Bun.file(path).text()).slice(-1500).trim(); } catch { return ""; }
};

export async function status(key: string): Promise<SvcStatus[]> {
  const svcs = previews.get(key) ?? [];
  return Promise.all(svcs.map(async (s) => {
    const running = !s.exited;
    // Every service binds a port, so readiness = the port actually responds — for the backend too,
    // not just "the process is alive". The link/iframe therefore waits for the full stack (~10s for
    // the backend) instead of appearing the instant the frontend is up.
    const ready = running ? await portReady(s.port) : false;
    return { name: s.name, port: s.port, url: `http://localhost:${s.port}`, open: s.open, running, ready, error: running ? undefined : await tail(s.logPath) };
  }));
}

export function stop(key: string): void {
  for (const s of previews.get(key) ?? []) {
    try { s.proc.kill(); } catch { /* already gone */ }
    try { closeSync(s.logFd); } catch { /* already closed */ }
  }
  killWorktree(key); // key === worktree path; reaps the node children proc.kill() leaves behind
  previews.delete(key);
}

/** Kill all preview services — call on server shutdown. */
export function killAll(): void {
  for (const key of [...previews.keys()]) stop(key);
}
