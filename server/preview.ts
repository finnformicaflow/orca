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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portFree } from "./net";
import type { PreviewService } from "./config";

/** A stable, Postgres-identifier-safe database name for one preview (keyed by its worktree path), so
 *  the `{db}` placeholder in a preview command resolves to a per-worktree database on the shared
 *  server. Deterministic (a restart/re-spin of the same worktree targets the same DB), unique (an
 *  8+ char hash of the full path avoids collisions when two branches slug alike), and matches
 *  MikroORM's `^[a-z][a-z0-9_]{0,62}$`: lowercase, leading letter (`orca_`), ≤63 chars. */
export function previewDbName(key: string): string {
  const slug = (key.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "preview";
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 10);
  return `orca_${slug}_${hash}`;
}

// Adopted svcs (re-surfaced after an ungraceful bridge exit) have no proc handle / log fd — we
// only know their port, and reap them via killPort. Owned svcs (started this run) have both.
type Svc = { name: string; port: number; open: boolean; proc?: Bun.Subprocess; logPath: string; logFd?: number; exited: boolean; startedAt: number; onStop?: string; everUp: boolean };
export type SvcStatus = { name: string; port: number; url: string; open: boolean; running: boolean; ready: boolean; error?: string; startedAt: number };

const previews = new Map<string, Svc[]>();

// Registry sidecar: the port↔service map for each worktree, so a crashed/hard-killed bridge (whose
// SIGINT/SIGTERM killAll never ran) can re-adopt its still-running dev servers on the next boot
// instead of orphaning them + forcing a re-spin. Only ports still responding are re-adopted.
const REG = join(tmpdir(), "orca-previews.json");
function persist(): void {
  const data: Record<string, Array<{ name: string; port: number; open: boolean; logPath: string; startedAt: number; onStop?: string }>> = {};
  // onStop persists so a preview re-adopted after a bridge restart still drops its DB on teardown.
  for (const [key, svcs] of previews) data[key] = svcs.map(({ name, port, open, logPath, startedAt, onStop }) => ({ name, port, open, logPath, startedAt, onStop }));
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
  let data: Record<string, Array<{ name: string; port: number; open: boolean; logPath: string; startedAt: number; onStop?: string }>>;
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
      if (cwd && cwd.startsWith(key)) live.push({ ...s, exited: false, everUp: true }); // re-adopted only because its port responded
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
  const db = previewDbName(key); // this preview's own database name — `{db}` in commands / onStop
  const svcs: Svc[] = services.map((s) => {
    const cmd = s.command
      .replace(/\{port\}/g, String(ports[s.name]))
      .replace(/\{svc:(\w+)\}/g, (_, n) => String(ports[n] ?? ""))
      .replace(/\{db\}/g, db);
    const logPath = join(tmpdir(), `orca-preview-${key.replace(/[^\w]+/g, "_")}-${s.name}.log`);
    const logFd = openSync(logPath, "w"); // capture output so a failed service is diagnosable
    const proc = Bun.spawn(["sh", "-lc", cmd], { cwd, env: process.env, stdout: logFd, stderr: logFd });
    const onStop = s.onStop?.replace(/\{db\}/g, db); // resolved now; runs at teardown (stop with teardown=true)
    const svc: Svc = { name: s.name, port: ports[s.name]!, open: s.open ?? false, proc, logPath, logFd, exited: false, startedAt: Date.now(), onStop, everUp: false };
    void proc.exited.then(() => { svc.exited = true; });
    return svc;
  });
  previews.set(key, svcs);
  persist();
}

// A dev server whose port NEVER answered within this long is wedged, not slow: `nest --watch` (the
// backend dev script) does NOT exit on a boot failure — it stays alive waiting for a file change — so
// "process alive" never clears on its own, and the card would spin on "Starting…" forever. Well above a
// cold boot (worktree npm-install self-heal + nest/vite compile) so a healthy slow start is never
// false-flagged. ponytail: a constant; make it configurable if a repo ever legitimately needs longer.
export const BOOT_TIMEOUT_MS = 180_000;

/** Whether a service counts as running/ready. The boot timeout applies ONLY before a service has ever
 *  bound its port (`everUp`): a fresh backend that never comes up is wedged and reaped. Once it HAS been
 *  up, a failed probe is a transient blip (e.g. the event loop blocked on a long request) — it stays
 *  running (only an actual process exit, via `alive`, marks it down), so a busy live server is never
 *  reaped, which would drop its per-preview DB. Pure, so both cases are testable without spawning. */
export function svcHealth(alive: boolean, up: boolean, everUp: boolean, startedAt: number, now: number): { running: boolean; ready: boolean } {
  const wedged = alive && !up && !everUp && now - startedAt > BOOT_TIMEOUT_MS;
  const running = alive && !wedged;
  return { running, ready: running && up };
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
    // handle, so their liveness IS the port responding. A service that NEVER binds its port past
    // BOOT_TIMEOUT_MS is wedged (crash-looping under --watch) → svcHealth reports it not-running so the
    // client reaps it; a service that HAS been up is never reaped on a probe blip (see everUp).
    if (up) s.everUp = true;
    const { running, ready } = svcHealth(s.proc ? !s.exited : up, up, s.everUp, s.startedAt, Date.now());
    return { name: s.name, port: s.port, url: `http://localhost:${s.port}`, open: s.open, running, ready, error: running ? undefined : await tail(s.logPath), startedAt: s.startedAt };
  }));
}

/** Every tracked preview, keyed by worktree path, with live status — for the running-previews menu.
 *  Not repo-scoped: the map spans all repos, keyed by absolute path.
 *  Only reflects previews started by THIS bridge process (the in-memory `previews` map) — previews
 *  orphaned by a prior bridge aren't listed, by design. */
export async function list(): Promise<{ key: string; svcs: SvcStatus[] }[]> {
  return Promise.all([...previews.keys()].map(async (key) => ({ key, svcs: await status(key) })));
}

/** Stop a preview's services. `teardown` = an explicit Discard / preview-stop (not the reap-before-
 *  restart, and not shutdown): only then do we run each service's onStop, so a per-preview database is
 *  dropped when you're done with the branch — but never on a routine restart, which would drop the DB
 *  out from under a re-spin. onStop runs with the worktree (still present at this point) as cwd. */
export function stop(key: string, teardown = false): void {
  const svcs = previews.get(key) ?? [];
  if (teardown) {
    for (const s of svcs) {
      if (!s.onStop) continue;
      // Best-effort and synchronous: a drop-database is quick, and the worktree it needs (env + drop
      // script) is still on disk here — callers remove it only after stop() returns.
      try { Bun.spawnSync(["sh", "-lc", s.onStop], { cwd: key, env: process.env, stdout: "ignore", stderr: "ignore" }); } catch { /* best effort */ }
    }
  }
  for (const s of svcs) {
    if (s.proc?.pid) { try { killTree(s.proc.pid); } catch { /* gone */ } } // reap the sh wrapper + ALL its children (nest/vite + the backgrounded reseed loop)
    else { try { s.proc?.kill(); } catch { /* already gone / adopted, no handle */ } }
    killPort(s.port); // precise: reap the actual listener the sh-wrapper kill (or adoption) leaves behind
    if (s.logFd !== undefined) { try { closeSync(s.logFd); } catch { /* already closed */ } }
  }
  killWorktree(key); // key === worktree path; sweeps orphans from a prior run (narrow pattern)
  previews.delete(key);
  persist();
}

/** Kill all preview services — call on server shutdown. Not a teardown: leaves per-preview DBs intact
 *  so a restart re-spins against them (they're dropped only on an explicit Discard / preview-stop). */
export function killAll(): void {
  for (const key of [...previews.keys()]) stop(key);
}
