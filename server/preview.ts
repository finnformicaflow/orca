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
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portFree } from "./net";
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

/** cwd of the process listening on `port`, via lsof — used to verify a re-adopted server is really
 *  the one we think it is (not a different worktree's server that reused the port). */
function listenerCwd(port: number): string | null {
  try {
    const pid = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout.toString().trim().split("\n").filter(Boolean)[0];
    if (!pid) return null;
    const line = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"]).stdout.toString().split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch { return null; }
}

/** Re-adopt preview servers that outlived an ungraceful bridge exit; drop entries whose ports are
 *  dead. Call once on boot, before serving. */
export async function reattach(): Promise<void> {
  let data: Record<string, Array<{ name: string; port: number; open: boolean; logPath: string; startedAt: number }>>;
  try { data = JSON.parse(readFileSync(REG, "utf8")); } catch { return; } // no registry yet / unreadable
  for (const [key, svcs] of Object.entries(data)) {
    const live: Svc[] = [];
    for (const s of svcs) {
      if (!(await portReady(s.port))) continue; // dead → drop
      // Only re-adopt if the server on that port is actually running IN this worktree. Ports get
      // reassigned across restarts, so a responding port may now be a DIFFERENT worktree's server —
      // adopting it would make this card serve someone else's code ("none of my changes"). If it's
      // foreign, leave it alone (its own key will re-adopt it) rather than adopt or kill it.
      const cwd = listenerCwd(s.port);
      if (cwd && cwd.startsWith(key)) live.push({ ...s, exited: false });
    }
    if (live.length) previews.set(key, live);
  }
  persist(); // rewrite pruned of the dead / foreign
}

// Pick a random port in the range. With a wide range (~90k) two previews launched close together
// colliding is ~1/rangeSize, so there's no need to reserve/track assigned ports — just re-roll if
// the OS says the chosen one is already in use.
export async function freePort(range: [number, number]): Promise<number> {
  const [min, max] = range;
  for (let i = 0; i < 20; i++) {
    const p = min + Math.floor(Math.random() * (max - min + 1));
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port in ${min}–${max}`);
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

/** Kill a process AND all its descendants (leaves first). The `sh -lc` preview wrapper backgrounds
 *  a reseed subshell (`( until curl … ; do sleep 2; done; invite… ) &`) whose argv has no worktree
 *  path or `node_modules` token — so neither proc.kill() (the sh only) nor killWorktree (argv match)
 *  reaps it, and it polls a dead port forever after a stop/restart. Walking the pid tree catches it.
 *  macOS Bun.spawn has no process-group option, hence the manual pgrep walk. */
export function killTree(pid: number): void {
  const kids = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().trim().split("\n").filter(Boolean);
  for (const k of kids) killTree(Number(k));
  try { process.kill(pid); } catch { /* already gone */ }
}

export async function start(key: string, cwd: string, services: PreviewService[], portRange: [number, number]): Promise<void> {
  stop(key); // reap tracked procs + orphaned servers for this worktree so we never serve stale code
  const ports: Record<string, number> = {};
  for (const s of services) ports[s.name] = await freePort(portRange);
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

/** Every tracked preview, keyed by worktree path, with live status — for the running-previews menu.
 *  Not repo-scoped: the map spans all repos, keyed by absolute path. */
export async function list(): Promise<{ key: string; svcs: SvcStatus[] }[]> {
  return Promise.all([...previews.keys()].map(async (key) => ({ key, svcs: await status(key) })));
}

export function stop(key: string): void {
  for (const s of previews.get(key) ?? []) {
    if (s.proc?.pid) { try { killTree(s.proc.pid); } catch { /* gone */ } } // reap the sh wrapper + ALL its children (nest/vite + the backgrounded reseed loop)
    else { try { s.proc?.kill(); } catch { /* already gone / adopted, no handle */ } }
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
