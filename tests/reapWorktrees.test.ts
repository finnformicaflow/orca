// Reaping worktrees when their PR is done with. Merged → worktree AND branch gone (commits are in
// base). Closed unmerged → worktree gone, branch KEPT (its commits live only there). A branch in
// neither set — a pre-PR local or a still-open PR — is left alone. This is the fix for "closing a PR
// leaves its worktree hanging." Real git against a scratch repo, no gh (the caller supplies the sets).
import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createWorktree, listWorktrees, reapWorktrees } from "../server/git";
import { run } from "../server/run";
import { makeScratchRepo } from "./helpers";

let repo: string | undefined;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); repo = undefined; });
const branches = async (root: string) => (await listWorktrees(repo!, root)).map((w) => w.branch);
const branchExists = async (b: string) => run(["git", "-C", repo!, "rev-parse", "--verify", b]).then(() => true, () => false);

test("merged deletes the branch, closed keeps it, and an untouched local survives", async () => {
  repo = await makeScratchRepo();
  const root = join(repo, ".worktrees");
  for (const b of ["merged-x", "closed-y", "local-z"]) await createWorktree(repo, root, b, "main");
  // Each worktree has its own commit, so "keeps the branch" is a real, checkable claim.
  for (const b of ["merged-x", "closed-y"]) {
    const wt = join(root, b);
    await run(["git", "-C", wt, "commit", "--allow-empty", "-m", `work on ${b}`]);
  }

  const seen: string[] = [];
  const reaped = await reapWorktrees(repo, root, new Set(["merged-x"]), new Set(["closed-y"]),
    (w, reason) => { seen.push(`${w.branch}:${reason}`); });

  // The before-hook fired for each reaped worktree with the right reason, and not for the local one.
  expect(seen.sort()).toEqual(["closed-y:closed", "merged-x:merged"]);
  expect(reaped.map((r) => `${r.branch}:${r.reason}`).sort()).toEqual(["closed-y:closed", "merged-x:merged"]);

  // Both worktrees are gone from disk; the untouched local remains.
  expect(await branches(root)).toEqual(["local-z"]);
  // Merged branch deleted; closed branch KEPT (its commit isn't in main); local untouched.
  expect(await branchExists("merged-x")).toBe(false);
  expect(await branchExists("closed-y")).toBe(true);
  expect(await branchExists("local-z")).toBe(true);
});

test("nothing to reap leaves every worktree in place", async () => {
  repo = await makeScratchRepo();
  const root = join(repo, ".worktrees");
  await createWorktree(repo, root, "keep-me", "main");
  const reaped = await reapWorktrees(repo, root, new Set(), new Set());
  expect(reaped).toEqual([]);
  expect(await branches(root)).toEqual(["keep-me"]);
});
