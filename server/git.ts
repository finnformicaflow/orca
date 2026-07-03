import { realpathSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./run";

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

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

/** Remove a worktree (does NOT touch the branch — that's an explicit, separate op). */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, "worktree", "remove", "--force", worktreePath);
}

/** Delete a local branch (best-effort). Only call for branches with no open PR. */
export const deleteBranch = (repoPath: string, branch: string) => git(repoPath, "branch", "-D", branch).catch(() => {});

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
