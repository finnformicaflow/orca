// E2E for Active PR Following: a "followed" card is on autopilot — each poll, if its PR has a
// blocker (merge conflict / failing CI / requested changes) and no agent is already working the
// branch, the store fires the matching agent action itself (the same button you'd click). Driven
// against the preloaded fake `api` (tests/apiFake.ts, no network): we seed a PR + its worktree,
// toggle following, run a refresh (the poll), and assert the right agent action launched via
// the provider-neutral agent API. See store.runFollowers / toggleFollow and workstream.followAction.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { apiFake } from "./apiFake";
import * as store from "@/store";

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first poll

// One open PR on `branch`, plus its idle worktree (so ensureWorktree is a no-op and no agent is
// "running" to block following). Override the PR status fields per test.
const seed = (branch: string, pr: Record<string, unknown>, agentStatus = "idle") => {
  apiFake.prsData = [{
    number: 1, title: branch, branch, url: `u/${branch}`, state: "OPEN", isDraft: false,
    mergeable: "MERGEABLE", ciStatus: "passing", reviewStatus: "review_required", autoMergeEnabled: false, ...pr,
  }];
  apiFake.agentsData = [{ branch, worktreePath: `/wt/${branch}`, agentStatus }];
};
const poll = () => act(async () => { await store.refresh(); });

afterEach(async () => { apiFake.reset(); localStorage.clear(); await store.refresh(); });

test("following a failing-CI PR auto-launches the Fix-CI agent", async () => {
  seed("feat-ci", { ciStatus: "failing" });
  store.toggleFollow({ repo: "r", branch: "feat-ci" } as store.Row);
  await poll();
  expect(apiFake.calls).toContain("agent:/wt/feat-ci");
  expect(apiFake.claudePrompts.some((p) => p.includes("CI is failing"))).toBe(true);
});

test("following a conflicting PR auto-launches the resolve-conflicts agent (conflict wins over CI)", async () => {
  seed("feat-cf", { mergeable: "CONFLICTING", ciStatus: "failing" });
  store.toggleFollow({ repo: "r", branch: "feat-cf" } as store.Row);
  await poll();
  expect(apiFake.claudePrompts.some((p) => p.includes("merge conflicts"))).toBe(true);
});

test("following a changes-requested PR auto-launches a review follow-up", async () => {
  seed("feat-rv", { reviewStatus: "changes_requested" });
  store.toggleFollow({ repo: "r", branch: "feat-rv" } as store.Row);
  await poll();
  expect(apiFake.claudePrompts.some((p) => p.includes("gh pr view 1 --comments"))).toBe(true);
});

test("an unfollowed PR with the same blocker is left completely alone", async () => {
  seed("feat-off", { ciStatus: "failing" });
  await poll(); // never toggled following
  expect(apiFake.calls).toHaveLength(0);
});

test("no action while an agent is already working the branch (never stacks runs)", async () => {
  seed("feat-run", { ciStatus: "failing" }, "running");
  store.toggleFollow({ repo: "r", branch: "feat-run" } as store.Row);
  await poll();
  expect(apiFake.calls).toHaveLength(0); // its running agent handles it; we don't launch another
});

test("acts once per condition — a steady blocker doesn't relaunch on every poll", async () => {
  seed("feat-once", { ciStatus: "failing" });
  store.toggleFollow({ repo: "r", branch: "feat-once" } as store.Row);
  await poll();
  await poll();
  await poll(); // same failing state throughout
  expect(apiFake.calls.filter((c) => c === "agent:/wt/feat-once")).toHaveLength(1);
});
