import { realpathSync } from "node:fs";
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

/** Create a new branch + worktree off `base`. Returns the worktree path. */
export async function createWorktree(
  repoPath: string,
  worktreeRoot: string,
  branch: string,
  base: string,
): Promise<string> {
  const worktreePath = join(worktreeRoot, branch);
  await git(repoPath, "worktree", "add", "-b", branch, worktreePath, base);
  return worktreePath;
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

/** Remove a worktree and its branch (best-effort on the branch). */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, "worktree", "remove", "--force", worktreePath);
}

/** Diff + commit summary of a worktree's branch against `base`. */
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
