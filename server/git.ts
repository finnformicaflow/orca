import { realpathSync } from "node:fs";
import { cp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dlopen, FFIType, suffix } from "bun:ffi";
import { run } from "./run";

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// APFS copy-on-write directory clone via clonefile(2) — clones a whole tree in O(1) (block-shared
// until modified). Bound lazily; on any non-macOS/non-APFS context the binding or the call fails
// and callers fall back. clonefile requires `dst` to not already exist.
let _clonefile: ((src: Buffer, dst: Buffer, flags: number) => number) | null | undefined;
function cloneTree(src: string, dst: string): boolean {
  if (_clonefile === undefined) {
    try {
      _clonefile = dlopen(`libSystem.${suffix}`, {
        clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
      }).symbols.clonefile as (s: Buffer, d: Buffer, f: number) => number;
    } catch { _clonefile = null; }
  }
  if (!_clonefile) return false;
  try { return _clonefile(Buffer.from(`${src}\0`), Buffer.from(`${dst}\0`), 0) === 0; }
  catch { return false; }
}

export type FileChange = { path: string; additions: number; deletions: number };
export type Commit = { hash: string; subject: string };
export type ChangeSummary = {
  files: FileChange[];
  commits: Commit[];
  additions: number;
  deletions: number;
};

const git = (repoPath: string, ...args: string[]) => run(["git", "-C", repoPath, ...args]);

const branchExists = async (repoPath: string, branch: string) => {
  try { await git(repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`); return true; } catch { return false; }
};

/** A branch name not already taken (appends -2, -3, … on collision). */
export async function uniqueBranch(repoPath: string, branch: string): Promise<string> {
  if (!(await branchExists(repoPath, branch))) return branch;
  for (let i = 2; ; i++) {
    const candidate = `${branch}-${i}`;
    if (!(await branchExists(repoPath, candidate))) return candidate;
  }
}

/**
 * Resolve the base ref to diff/merge against. Prefers the remote-tracking `origin/<base>` over the
 * local branch, which is frequently stale (behind origin) and would make change summaries include
 * commits already merged upstream — the exact "why are there 6 commits?" surprise. Falls back to
 * the local ref for local-only repos (no origin).
 */
export async function resolveBase(repoPath: string, base: string): Promise<string> {
  const remote = `origin/${base}`;
  try {
    await git(repoPath, "rev-parse", "--verify", "--quiet", remote);
    return remote;
  } catch {
    return base;
  }
}

/** Create a new branch + worktree off `base`. Branch name is made unique on collision. */
export async function createWorktree(
  repoPath: string,
  worktreeRoot: string,
  branch: string,
  base: string,
): Promise<{ branch: string; worktreePath: string }> {
  branch = await uniqueBranch(repoPath, branch);
  const worktreePath = join(worktreeRoot, branch);
  await git(repoPath, "worktree", "add", "-b", branch, worktreePath, base);
  return { branch, worktreePath };
}

/**
 * Create or refresh a DETACHED worktree at the latest `base` — for previewing the base branch
 * itself ("test master": confirm on a clean main whether a bug is already fixed / still there).
 * Fetches origin so it's current, then checks out the resolved base ref detached. Detached is the
 * point: with no `branch refs/heads/…` line it's invisible to `listWorktrees`, so it never shows up
 * as a board workstream. Reused across runs (its copied env + linked node_modules stay in place),
 * just moved to the newest base each time.
 */
export async function baseWorktree(repoPath: string, worktreeRoot: string, base: string): Promise<{ worktreePath: string }> {
  await git(repoPath, "worktree", "prune").catch(() => {}); // clear stale registrations
  await git(repoPath, "fetch", "origin", base).catch(() => {}); // best-effort; local-only repos have no origin
  const ref = await resolveBase(repoPath, base); // origin/<base> when present (newest), else the local branch
  const worktreePath = join(worktreeRoot, base);
  try {
    await git(worktreePath, "checkout", "--detach", ref); // existing worktree → move it to the newest base
  } catch {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {}); // clear any stale/leftover dir
    await git(repoPath, "worktree", "add", "--detach", worktreePath, ref);
  }
  return { worktreePath };
}

/** List worktrees under `worktreeRoot` (excludes the main working tree). */
export async function listWorktrees(
  repoPath: string,
  worktreeRoot: string,
): Promise<{ branch: string; worktreePath: string }[]> {
  const out = await git(repoPath, "worktree", "list", "--porcelain");
  const root = real(worktreeRoot); // resolve symlinks (macOS /var → /private/var)
  const result: { branch: string; worktreePath: string }[] = [];
  for (const block of out.split("\n\n")) {
    const worktreePath = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (worktreePath && branch && real(worktreePath).startsWith(root)) result.push({ branch, worktreePath });
  }
  return result;
}

/** Add a worktree for an EXISTING branch (adopt a PR). Fetches the remote branch first. */
export async function adoptWorktree(
  repoPath: string,
  worktreeRoot: string,
  branch: string,
): Promise<{ branch: string; worktreePath: string }> {
  await git(repoPath, "worktree", "prune").catch(() => {}); // clear stale registrations
  await git(repoPath, "fetch", "origin", branch).catch(() => {}); // best-effort; may be local-only
  const worktreePath = join(worktreeRoot, branch);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => {}); // clear any leftover dir
  // --force fallback: the branch may already be checked out in the main working tree (e.g. you
  // `git switch`ed to it) — git refuses a second checkout without it. A preview only reads the
  // tree, so a shared checkout is safe.
  const add = (...args: string[]) =>
    git(repoPath, "worktree", "add", ...args).catch(() => git(repoPath, "worktree", "add", "--force", ...args));
  if (await branchExists(repoPath, branch)) {
    await add(worktreePath, branch);
  } else {
    await add("--track", "-b", branch, worktreePath, `origin/${branch}`);
  }
  return { branch, worktreePath };
}

/**
 * Copy gitignored config (e.g. `backend/.env`) from the main repo into a worktree — a fresh
 * checkout only has tracked files, so local secrets/integrations would otherwise be missing and
 * the previewed app boots without its API keys. Best-effort per file (missing ones are skipped).
 */
export async function copyToWorktree(repoPath: string, worktreePath: string, paths: string[] = []): Promise<void> {
  await Promise.all(paths.map((rel) =>
    cp(join(repoPath, rel), join(worktreePath, rel), { recursive: true }).catch(() => {})));
}

/**
 * Provision heavy shared dirs (e.g. `node_modules`) from the main repo into a worktree — a fresh
 * checkout has none, and a real per-worktree install is slow + disk-heavy. Best-effort per path.
 *
 * `node_modules` is special-cased: it's CLONED, not symlinked, via APFS copy-on-write (clonefile).
 * A copy-on-write clone is near-instant and shares disk blocks with the source until a file is
 * modified, so it costs almost nothing — but each worktree gets a fully INDEPENDENT tree. That
 * isolation is the point: when worktrees shared one node_modules (a whole-dir symlink, or even
 * per-entry symlinks), any process mutating it — an `npm install` self-heal, an agent adding a
 * dep, Vite rewriting `.vite/deps` — corrupted every other concurrent preview reading the same
 * files. The worst symptom was mikro-orm's "only abstract entities discovered" when a preview ran
 * `cache:generate` while the shared `@mikro-orm/core` was mid-rewrite, plus Vite 504s from a shared
 * `.vite/deps`. With a per-worktree clone, no worktree can perturb another's deps.
 *
 * Falls back to the old per-entry symlink if the clone fails (e.g. a non-APFS volume where
 * clonefile isn't supported) — shared but functional. Other (non-node_modules) paths stay symlinked.
 */
export async function linkToWorktree(repoPath: string, worktreePath: string, paths: string[] = []): Promise<void> {
  await Promise.all(paths.map(async (rel) => {
    const src = join(repoPath, rel);
    const dest = join(worktreePath, rel);
    await mkdir(dirname(dest), { recursive: true }).catch(() => {});
    await rm(dest, { recursive: true, force: true }).catch(() => {}); // replace any stale entry; clonefile needs dest absent
    if (basename(rel) !== "node_modules") {
      await symlink(src, dest).catch(() => {});
      return;
    }
    // APFS CoW directory clone: ~2s for an 82k-file node_modules (vs ~40s for per-file `cp -c`),
    // block-shared with the source until modified, but a fully independent tree per worktree.
    if (cloneTree(src, dest)) return;
    // Non-APFS / clonefile unavailable → degrade to the old per-entry symlink (keeps .vite local).
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    await mkdir(dest, { recursive: true }).catch(() => {});
    const entries = await readdir(src).catch(() => [] as string[]);
    await Promise.all(entries
      .filter((e) => !e.startsWith(".vite"))
      .map((e) => symlink(join(src, e), join(dest, e)).catch(() => {})));
  }));
}

/** Remove a worktree (does NOT touch the branch — that's an explicit, separate op). */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, "worktree", "remove", "--force", worktreePath);
}

/** Delete a local branch (best-effort). Only call for branches with no open PR. */
export const deleteBranch = (repoPath: string, branch: string) => git(repoPath, "branch", "-D", branch).catch(() => {});

/** Push a branch to origin (setting upstream) so a PR can be opened against it. A worktree branch
 *  created/adopted locally isn't on the remote yet, and `gh pr create` needs it there. */
export const pushBranch = (worktreePath: string, branch: string) =>
  git(worktreePath, "push", "-u", "origin", branch);

/** Does the repo have any git remote? (Determines PR vs local-only lifecycle.) */
export async function hasRemote(repoPath: string): Promise<boolean> {
  try { return (await git(repoPath, "remote")).trim().length > 0; } catch { return false; }
}

/** Whether `branch` merges into `base` cleanly, per `git merge-tree` (no working-tree changes). */
export async function mergeClean(repoPath: string, base: string, branch: string): Promise<"clean" | "conflict"> {
  try {
    await git(repoPath, "merge-tree", "--write-tree", base, branch); // exits non-zero on conflict
    return "clean";
  } catch {
    return "conflict";
  }
}

/** Merge a branch into `base` locally (no remote). Guarded: base must be checked out & clean. */
export async function mergeLocal(repoPath: string, base: string, branch: string): Promise<void> {
  const cur = (await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (cur !== base) throw new Error(`check out ${base} in the repo first (currently on ${cur})`);
  if ((await git(repoPath, "status", "--porcelain")).trim()) throw new Error("repo working tree is not clean");
  await git(repoPath, "merge", "--no-ff", "--no-edit", branch);
}

/** Diff + commit summary of a worktree's branch against `base`. */
/** Full patch of the branch vs its base — powers the Files tab on the local-session detail view. */
export const worktreeDiff = (worktreePath: string, base: string) =>
  run(["git", "-C", worktreePath, "diff", `${base}...HEAD`]);

export async function changeSummary(worktreePath: string, base: string): Promise<ChangeSummary> {
  const numstat = await run(["git", "-C", worktreePath, "diff", "--numstat", `${base}...HEAD`]);
  const files: FileChange[] = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, path] = line.split("\t");
      return {
        path: path ?? "",
        additions: add === "-" ? 0 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
      };
    });

  const log = await run(["git", "-C", worktreePath, "log", "--format=%H%x00%s", `${base}..HEAD`]);
  const commits: Commit[] = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\0");
      return { hash: hash ?? "", subject: subject ?? "" };
    });

  return {
    files,
    commits,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}
