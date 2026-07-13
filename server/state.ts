// Orca's one bit of on-disk *operational* state — NOT app/business state (that stays in git, gh, and
// the browser's localStorage; see CLAUDE.md). Two things live here: per-worktree run leases (so a
// restarted bridge won't launch a second agent over a still-live one) and the bounded run ledger
// (observability). Both are advisory: if a file is missing or unreadable the system must degrade —
// reclaim the lease, drop the ledger record — never refuse a legitimate run. Kept OUT of every
// worktree so it can't leak into a diff or PR body.
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "fs";

/** Root for operational state. Overridable so tests (and parallel checkouts) get an isolated dir. */
export function stateDir(): string {
  return process.env.ORCA_STATE_DIR || join(homedir(), ".orca");
}

/** Absolute path under the state dir, creating the parent directory on demand. */
export function statePath(...parts: string[]): string {
  const full = join(stateDir(), ...parts);
  mkdirSync(join(full, ".."), { recursive: true });
  return full;
}

/** Atomic write: a torn read during a poll would corrupt the JSON, so write a temp file and rename
 *  it into place (rename is atomic on the same filesystem). Synchronous so callers stay non-async. */
export function writeJsonSync(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** Read + parse JSON, or `undefined` if the file is missing or corrupt (never throws). */
export function readJsonSync<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
