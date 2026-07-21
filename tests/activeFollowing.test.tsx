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

test("review launch sends unresolved thread evidence and persists IDs only after acceptance", async () => {
  seed("feat-threads", { reviewStatus: "changes_requested" });
  apiFake.reviewEvidenceData = [{ id: "T1", path: "src/a.ts", line: 12, author: "alice", body: "Handle null", url: "https://review/T1", resolved: false }];
  const row = { repo: "r", hasRemote: true, branch: "feat-threads", title: "threads", prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/feat-threads", prNumber: 1 } as store.Row;
  await store.addressReview(row, false);
  expect(apiFake.claudePrompts.at(-1)).toContain("Thread T1");
  expect(apiFake.claudePrompts.at(-1)).toContain("src/a.ts:12");
  expect(apiFake.enrichmentData.get("r::feat-threads")?.handedReviewThreadIds).toEqual(["T1"]);

  await store.addressReview(row, false);
  expect(apiFake.calls.filter((call) => call === "agent:/wt/feat-threads")).toHaveLength(1);
});

test("manual review includes all unresolved threads and marks previously handed ones", async () => {
  seed("feat-manual", {});
  apiFake.reviewEvidenceData = [{ id: "T1", body: "Still open", resolved: false }];
  const row = { repo: "r", hasRemote: true, branch: "feat-manual", title: "manual", prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/feat-manual", prNumber: 1 } as store.Row;
  await store.addressReview(row, false);
  await store.addressReview(row, true);
  expect(apiFake.claudePrompts.at(-1)).toContain("previously handed; still unresolved");
});

test("failed review launch does not persist handed IDs", async () => {
  seed("feat-reject", {});
  apiFake.reviewEvidenceData = [{ id: "T-reject", body: "Change this", resolved: false }];
  apiFake.claudeError = "launch rejected";
  const row = { repo: "r", hasRemote: true, branch: "feat-reject", title: "reject", prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/feat-reject", prNumber: 1 } as store.Row;
  await expect(store.addressReview(row, false)).rejects.toThrow("launch rejected");
  expect(apiFake.enrichmentData.get("r::feat-reject")?.handedReviewThreadIds).toBeUndefined();
});

test("evidence endpoint failure falls back to generic review discovery", async () => {
  seed("feat-fallback", {});
  apiFake.reviewEvidenceError = "GitHub unavailable";
  const row = { repo: "r", hasRemote: true, branch: "feat-fallback", title: "fallback", prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/feat-fallback", prNumber: 1 } as store.Row;
  await store.addressReview(row);
  expect(apiFake.claudePrompts.at(-1)).toContain("gh pr view 1 --comments");
});

test("Fix CI includes bounded failed-step evidence and falls back to check names", async () => {
  seed("feat-ci-evidence", { ciStatus: "failing" });
  const row = { repo: "r", hasRemote: true, branch: "feat-ci-evidence", title: "ci", prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/feat-ci-evidence", prNumber: 1, failingChecks: ["unit"] } as store.Row;
  apiFake.ciEvidenceData = [{ name: "unit", status: "FAILURE", url: "https://actions/run", excerpt: "Error: expected true" }];
  await store.fixCi(row);
  expect(apiFake.claudePrompts.at(-1)).toContain("Error: expected true");
  expect(apiFake.claudePrompts.at(-1)).toContain("do not blindly modify tests");

  apiFake.ciEvidenceError = "logs unavailable";
  await store.fixCi(row);
  expect(apiFake.claudePrompts.at(-1)).toContain("Failing checks reported by Orca: unit");
});
