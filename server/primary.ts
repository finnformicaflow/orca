// ONE bridge per instance runs the background duties: orchestrator wakes and drains, run-finished
// reporting, the merge queue, cleanup and the reaper, autofix and PR upkeep, the publish loops,
// lease adoption. Every other bridge on that instance serves HTTP only.
//
// Why (incident 2026-10-14): four full bridges started by hand from finished workstreams' worktrees
// (for screenshots, instead of scripts/preview-orca.sh) kept running on the shared database after
// their worktrees were deleted. Stale code with full duties: one woke the orchestrator with PATH
// naming the deleted worktree's bin/ and ORCA_URL its own port, and any of them could have merged,
// reaped or addressed PRs. Defence in depth:
//  1. a Postgres session advisory lock per instance (`pg_try_advisory_lock`, no schema) — the holder
//     is primary; a bridge that can't take it logs that it is secondary and retries, so a restart's
//     new process takes over once the old one's connection closes;
//  2. a bridge whose code lives under a `.worktrees/` path never even tries, unless `ORCA_PRIMARY=1`;
//  3. `watchSource`: a bridge whose own source directory disappears exits.
// The lock rides its OWN one-connection client, not db.ts's pool: the pool recycles connections
// (idleTimeout/maxLifetime) and a session lock dies with its connection.
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { errorText, instanceName, isDbError, logUnlessDown, onAvailable, onUnavailable, previewBridge, unavailableSince } from "./db";
import { processCwd } from "./proc";

/** How often a secondary retries the lock, and a primary re-asserts it (a dropped connection loses it). */
export const PRIMARY_RETRY_MS = Number(process.env.ORCA_PRIMARY_RETRY_MS) || 5_000;
export const PRIMARY_HEARTBEAT_MS = 30_000;
/** How often a bridge checks that its own source directory still exists. */
export const SOURCE_WATCH_MS = Number(process.env.ORCA_SOURCE_WATCH_MS) || 20_000;

const SOURCE_DIR = import.meta.dir;
const START_CWD = process.cwd();

/** Why a bridge whose code is at `dir` may not run background duties at all, or undefined. A bridge
 *  inside a `.worktrees/` checkout is a worker's (or a stray), never the instance's own. */
export function worktreeRefusal(dir: string = SOURCE_DIR, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.ORCA_PRIMARY === "1") return undefined;
  if (!/(^|\/)\.worktrees\//.test(dir)) return undefined;
  return `started from a worktree (${dir}); set ORCA_PRIMARY=1 to allow background duties`;
}

let elected = false;
let primary = false;
let reason = "not elected yet";
let client: Bun.SQL | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners: (() => unknown)[] = [];
let fired = false;

/** Whether THIS process may run background duties. True in a process that never ran the election
 *  (a test calling the orchestrator in-process, a script): the guard is the bridge's, not the code's.
 *  Never in a branch preview's bridge, elected or not — every duty's own guard reads this, so a code
 *  path that forgets `elect()` (or runs before it) still can't wake, merge, reap or launch from one. */
export const held = (): boolean => !previewBridge() && (!elected || (primary && unavailableSince() === null));

/** The one reason a bridge gives while the database is down. Fixed text, never the driver's error
 *  message: a timeout and a refused connect alternated, and each change of text logged a new line. */
export const DB_DOWN_REASON = "database unreachable";

/** For /api/health and /api/diagnostics. */
export const state = (): { primary: boolean; reason: string } => ({ primary: elected ? primary : true, reason: elected ? reason : "no election" });

/** Run `fn` once, the first time this process becomes primary (or now, if it already is). */
export function onPrimary(fn: () => unknown): void {
  if (fired) { void Promise.resolve().then(fn).catch(logUnlessDown("orca: primary duty failed")); return; }
  listeners.push(fn);
}

const promoted = new Set<() => unknown>();

function become(next: boolean, why: string): void {
  const rising = next && !primary;
  if (next !== primary || why !== reason) console.log(next ? `orca: primary for instance ${instanceName()} — running background duties` : `orca: secondary bridge (${why}) — serving HTTP only, no background duties`);
  primary = next;
  reason = why;
  if (next && !fired) {
    fired = true;
    for (const fn of listeners.splice(0)) void Promise.resolve().then(fn).catch(logUnlessDown("orca: primary duty failed"));
  }
  if (rising) for (const fn of promoted) void Promise.resolve().then(fn);
}

/** Run `fn` ONCE, the first time this process is primary with the database up — now, at a takeover,
 *  or when the database comes back after an outage. A run that meets a database error (`isDbError`:
 *  the database went away again) is not counted and runs again at the next of those; any other error is logged and
 *  counted, as before. (The boot-time reconcile set its flag first and so never ran after an outage.) */
export function whenUp(fn: () => Promise<unknown>, label: string): () => Promise<void> {
  let done = false;
  let running: Promise<void> | null = null;
  const tryRun = (): Promise<void> => {
    if (done || !held() || unavailableSince() !== null) return Promise.resolve();
    running ??= (async () => {
      try { await fn(); done = true; }
      catch (e) { if (!isDbError(e)) { done = true; console.error(`${label}: ${errorText(e)}`); } }
      finally { running = null; }
    })();
    return running;
  };
  onAvailable(tryRun);
  promoted.add(tryRun); // every secondary → primary change, not only the first (`onPrimary`)
  void Promise.resolve().then(tryRun);
  return tryRun;
}

/** The lock key: per instance, and per schema so parallel test schemas on one server never contend. */
async function tryLock(): Promise<boolean> {
  const url = process.env.ORCA_DATABASE_URL || "postgres://localhost:5432/orca";
  client ??= new Bun.SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0, connectionTimeout: Number(process.env.ORCA_DB_CONNECT_TIMEOUT_S) || 5 });
  const key = `orca-primary:${instanceName()}`;
  // Re-entrant: a primary re-asserting gets true again on the same session; on a NEW session (the
  // old one dropped) it is true only if nobody else took it meanwhile.
  const [row] = await client`SELECT pg_try_advisory_lock(hashtext(${key} || ':' || current_schema())) AS got`;
  return Boolean(row?.got);
}

function dropClient(): void {
  void client?.end().catch(() => {});
  client = null;
}

let attempting: Promise<void> | null = null;
/** One election step. While db.ts knows the database is down this does not try the lock at all: the
 *  lock's own client once reconnected before db.ts's probe did, so a bridge became primary and ran its
 *  duties into a pool that still failed fast — then lost the lock again (the flapping). db.ts is the one
 *  judge of "reachable"; its `onAvailable` re-runs this at once (see `elect`). */
function attempt(): Promise<void> {
  attempting ??= (async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (unavailableSince() !== null) {
      dropClient(); // the lock (if held) went with the connection
      become(false, DB_DOWN_REASON);
      return; // no timer: db.ts's probe calls back when it is reachable
    }
    try {
      const got = await tryLock();
      become(got, got ? "holds the instance lock" : `another bridge holds instance ${instanceName()}'s lock`);
    } catch {
      // The connection is gone (database down, dropped): the lock went with it. A fresh client next time.
      dropClient();
      become(false, DB_DOWN_REASON);
    }
    timer = setTimeout(() => void attempt(), primary ? PRIMARY_HEARTBEAT_MS : PRIMARY_RETRY_MS);
    timer.unref();
  })().finally(() => { attempting = null; });
  return attempting;
}

/** Start the election (server/index.ts, once). A preview bridge or a worktree's bridge never takes
 *  part — it is secondary for its whole life. */
export function elect(): void {
  if (elected) return;
  elected = true;
  const refused = previewBridge() ? "a branch preview's bridge" : worktreeRefusal();
  if (refused) { become(false, refused); return; }
  // Registered before index.ts's own listeners, so the lock is decided before a `whenUp` duty asks `held()`.
  // An attempt still in flight may have started while it was down: let it end, then decide afresh.
  onAvailable(async () => { await attempting; await attempt(); });
  // And the moment db.ts declares it down, step down: "primary … running background duties" must not
  // stand while the database is going away (it did, until the next 30s lock heartbeat).
  onUnavailable(async () => { await attempting; await attempt(); });
  void attempt();
}

/** Let the lock go (shutdown): the next bridge takes it at once rather than at its next retry. */
export async function release(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const c = client;
  client = null;
  primary = false;
  await c?.end().catch(() => {});
}

/** Why the checkout this bridge runs from is gone, or undefined while it stands. Any one is enough:
 *  its own source (`<dir>/index.ts`) is missing or emptied; it is a linked worktree whose git
 *  registration (`.git` → `gitdir: …`) was removed — `git worktree remove`/`prune` on it; or its
 *  working directory was deleted (Linux shows a deleted cwd as `<path> (deleted)`). Incident
 *  2026-10-15: a preview bridge whose worktree was deleted ran for 19h and woke the orchestrator. */
export function checkoutGone(dir: string = SOURCE_DIR, cwd: string = START_CWD, cwdNow: () => string | undefined = () => processCwd(process.pid)): string | undefined {
  if (!existsSync(join(dir, "index.ts"))) return `its source (${dir}) is gone`;
  const dotGit = join(dir, "..", ".git");
  try {
    if (statSync(dotGit).isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (gitdir && !existsSync(resolve(dirname(dotGit), gitdir))) return `its worktree (${resolve(dir, "..")}) was removed from git`;
    }
  } catch { /* no .git (a tarball deploy): nothing to check */ }
  if (!existsSync(cwd)) return `its working directory (${cwd}) is gone`;
  if (cwdNow()?.endsWith(" (deleted)")) return `its working directory (${cwd}) was deleted`;
  return undefined;
}

/** Call `onGone` once when the checkout this bridge runs from is gone (`checkoutGone`) — a worktree
 *  reaped under a bridge somebody started, or a branch preview's bridge outliving its worktree. */
export function watchSource(onGone: () => unknown, dir: string = SOURCE_DIR, ms = SOURCE_WATCH_MS, cwd: string = START_CWD): ReturnType<typeof setInterval> {
  const t = setInterval(() => {
    const why = checkoutGone(dir, cwd);
    if (!why) return;
    clearInterval(t);
    console.error(`orca: this bridge's checkout is gone (${why}) — exiting`);
    void onGone();
  }, ms);
  t.unref();
  return t;
}

/** The main install (the repository's primary checkout, never a linked worktree) and its `bin/`, for
 *  the orchestrator's PATH: `git rev-parse --git-common-dir` from this file names the main checkout's
 *  `.git` even from a worktree. Verified to hold `bin/orca`; falls back to this checkout's own when
 *  that does (a tarball deploy with no .git). Throws when neither has it — a wake with no `orca`
 *  command is the incident, not a degraded mode. */
export function mainBin(dir: string = SOURCE_DIR): string {
  const out = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, stderr: "ignore" });
  const common = out.success ? out.stdout.toString().trim() : "";
  const candidates = [common ? join(common, "..", "bin") : "", join(dir, "..", "bin")].filter(Boolean);
  for (const bin of candidates) if (existsSync(join(bin, "orca"))) return bin;
  throw new Error(`no orca command found (looked in ${candidates.join(", ")})`);
}
