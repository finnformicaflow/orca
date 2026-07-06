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
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewService } from "./config";

// Adopted svcs (re-surfaced after an ungraceful bridge exit) have no proc handle / log fd — we
// only know their port, and reap them via killPort. Owned svcs (started this run) have both.
type Svc = { name: string; port: number; open: boolean; proc?: Bun.Subprocess; logPath: string; logFd?: number; exited: boolean; startedAt: number };
export type SvcStatus = { name: string; port: number; url: string; open: boolean; running: boolean; ready: boolean; error?: string; startedAt: number };

const previews = new Map<string, Svc[]>();

// Registry sidecar: the port↔service map for each worktree, so a crashed/hard-killed bridge (whose
// SIGINT/SIGTERM killAll never ran) can re-adopt its still-running dev servers on the next boot
// instead of orphaning them + forcing a re-spin. Only ports still responding are re-adopted.
const REG = join(tmpdir(), "orca-previews.json");
function persist(): void {
  const data: Record<string, Array<{ name: string; port: number; open: boolean; logPath: string; startedAt: number }>> = {};
  for (const [key, svcs] of previews) data[key] = svcs.map(({ name, port, open, logPath, startedAt }) => ({ name, port, open, logPath, startedAt }));
  try { writeFileSync(REG, JSON.stringify(data)); } catch { /* best effort */ }
}

/** Re-adopt preview servers that outlived an ungraceful bridge exit; drop entries whose ports are
 *  dead. Call once on boot, before serving. */
export async function reattach(): Promise<void> {
  let data: Record<string, Array<{ name: string; port: number; open: boolean; logPath: string; startedAt: number }>>;
  try { data = JSON.parse(readFileSync(REG, "utf8")); } catch { return; } // no registry yet / unreadable
  for (const [key, svcs] of Object.entries(data)) {
    const live: Svc[] = [];
    for (const s of svcs) if (await portReady(s.port)) live.push({ ...s, exited: false });
    if (live.length) previews.set(key, live);
  }
  persist(); // rewrite pruned of the dead
}

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

/** Kill whatever is listening on a port — precise reaping of a tracked service's actual listener
 *  (the node/bun grandchild the sh wrapper's kill misses), regardless of process tree. */
function killPort(port: number): void {
  try {
    // -sTCP:LISTEN is critical: without it lsof also returns clients *connected* to the port —
    // including the bridge itself (its readiness fetch), so we'd kill our own server.
    const out = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout.toString().trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid)); } catch { /* gone */ } }
  } catch { /* lsof missing / nothing listening */ }
}

/** Reap dev servers left running inside this worktree by a PRIOR run (their ports are unknown after
 *  a bridge restart). Deliberately narrow — matches only processes launched from the worktree's
 *  node_modules (vite/nest), NOT a shell/editor/agent that merely has the path in its args. */
function killWorktree(cwd: string): void {
  try { Bun.spawnSync(["pkill", "-f", `${cwd}.*node_modules`]); } catch { /* nothing matched */ }
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
    const svc: Svc = { name: s.name, port: ports[s.name]!, open: s.open ?? false, proc, logPath, logFd, exited: false, startedAt: Date.now() };
    void proc.exited.then(() => { svc.exited = true; });
    return svc;
  });
  previews.set(key, svcs);
  persist();
}

async function portReady(port: number): Promise<boolean> {
  try {
    // 2s (not 700ms): under boot load a healthy dev server can be slow to answer the first request,
    // and a too-tight timeout makes "ready" flap on/off — which reads as flakiness.
    await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) });
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
    const up = await portReady(s.port);
    // Every service binds a port, so readiness = the port actually responds — for the backend too,
    // not just "the process is alive". The link/iframe therefore waits for the full stack (~10s for
    // the backend) instead of appearing the instant the frontend is up. Adopted svcs have no proc
    // handle, so their liveness IS the port responding.
    const running = s.proc ? !s.exited : up;
    const ready = running && up;
    return { name: s.name, port: s.port, url: `http://localhost:${s.port}`, open: s.open, running, ready, error: running ? undefined : await tail(s.logPath), startedAt: s.startedAt };
  }));
}

export function stop(key: string): void {
  for (const s of previews.get(key) ?? []) {
    try { s.proc?.kill(); } catch { /* already gone / adopted, no handle */ }
    killPort(s.port); // precise: reap the actual listener the sh-wrapper kill (or adoption) leaves behind
    if (s.logFd !== undefined) { try { closeSync(s.logFd); } catch { /* already closed */ } }
  }
  killWorktree(key); // key === worktree path; sweeps orphans from a prior run (narrow pattern)
  previews.delete(key);
  persist();
}

/** Kill all preview services — call on server shutdown. */
export function killAll(): void {
  for (const key of [...previews.keys()]) stop(key);
}
