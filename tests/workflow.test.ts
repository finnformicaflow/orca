// The core problem, as executable spec. Each test is named after a workflow step
// (W1–W7). git runs against a scratch repo; gh is a PATH shim. No network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { changeSummary, createWorktree, listWorktrees, removeWorktree } from "../server/git";
import { convertToDraft, createPr, listPrs, markReady, mergePr, prDetail, prDiff, prStatus } from "../server/gh";
import { freePort } from "../server/preview";
import { run } from "../server/run";
import {
  attachCommand, canMerge, deriveKanbanState, draftState, followUpPrompt, launchPrompt, promptFor, readyForReview,
  resolveConflictsPrompt, shouldBump, slackPrompt, slugifyBranch, withAttachments, type WorkstreamState,
} from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, restorePath, setPrFixture, setPrListFixture, setViewFixture } from "./helpers";

let repo: string;
beforeAll(async () => {
  repo = await makeScratchRepo();
  await installFakeGh();
});
afterAll(restorePath);

const fixture = (over: Partial<Parameters<typeof setPrFixture>[0]>) =>
  setPrFixture({ state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "APPROVED", statusCheckRollup: [], ...over });

test("W1 create-worktree: branch + worktree on disk, carries a copyable prompt", async () => {
  const branch = slugifyBranch("Add dark mode toggle!");
  expect(branch).toBe("add-dark-mode-toggle");

  const { worktreePath: wt } = await createWorktree(repo, join(repo, ".worktrees"), branch, "main");
  expect((await stat(wt)).isDirectory()).toBe(true);
  expect((await run(["git", "-C", wt, "rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(branch);

  const prompt = promptFor({ title: "Add dark mode toggle", branch, prompt: "Use CSS vars." });
  expect(prompt).toContain(branch);
  expect(prompt).toContain("Use CSS vars.");

  // headless launch prompt adds an autonomous-commit instruction, and forbids opening a PR itself
  // (Orca owns Promote — otherwise the agent proactively opens a PR and the card jumps to In Review)
  const launch = launchPrompt({ title: "T", branch, prompt: "do it" });
  expect(launch).toContain("Commit");
  expect(launch).toContain("Do NOT open a pull request");
  expect(followUpPrompt("tweak the copy")).toContain("Do NOT open a pull request");
  // pasted-image paths are appended for the agent to Read; no images = prompt unchanged
  expect(withAttachments("go", [])).toBe("go");
  expect(withAttachments("go", ["/tmp/a.png"])).toContain("/tmp/a.png");
  // attach command drops you into a session continuing the headless run
  expect(attachCommand({ worktreePath: wt })).toBe(`cd "${wt}" && claude`);
});

test("W2 change-summary: commits produce a summary and flip DRAFTING → READY", async () => {
  const { worktreePath: wt } = await createWorktree(repo, join(repo, ".worktrees"), "feat-summary", "main");
  expect(draftState((await changeSummary(wt, "main")).commits.length)).toBe("DRAFTING");

  await run(["git", "-C", wt, "commit", "--allow-empty", "-m", "add feature"]);
  await Bun.write(join(wt, "feature.ts"), "export const x = 1;\n");
  await run(["git", "-C", wt, "add", "."]);
  await run(["git", "-C", wt, "commit", "-m", "implement feature"]);

  const summary = await changeSummary(wt, "main");
  expect(summary.commits.map((c) => c.subject)).toContain("implement feature");
  expect(summary.files.map((f) => f.path)).toContain("feature.ts");
  expect(summary.additions).toBeGreaterThan(0);
  expect(draftState(summary.commits.length)).toBe("READY");
});

test("W3 promote-to-pr: gh pr create returns number + url", async () => {
  const { worktreePath: wt } = await createWorktree(repo, join(repo, ".worktrees"), "feat-pr", "main");
  process.env.ORCA_PR_NUMBER = "42";
  const pr = await createPr(wt, { title: "Feat", body: "b", base: "main", head: "feat-pr" });
  expect(pr.number).toBe(42);
  expect(pr.url).toEndWith("/42");
});

describe("W4 poll-status: gh json → state machine", () => {
  const cases: Array<[string, Parameters<typeof setPrFixture>[0], WorkstreamState]> = [
    ["approved → MERGEABLE", { state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }, "MERGEABLE"],
    ["green + unapproved → IN_REVIEW (ready-for-review is a badge)", { state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }, "IN_REVIEW"],
    ["changes requested → IN_REVIEW", { state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }, "IN_REVIEW"],
    ["conflict but approved → MERGEABLE (conflict is a badge)", { state: "OPEN", mergeable: "CONFLICTING", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }, "MERGEABLE"],
    ["unapproved, failing ci → IN_REVIEW", { state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ conclusion: "FAILURE" }] }, "IN_REVIEW"],
    ["merged → MERGED", { state: "MERGED", mergeable: "UNKNOWN", reviewDecision: "APPROVED", statusCheckRollup: [] }, "MERGED"],
  ];
  for (const [name, fx, expected] of cases) {
    test(name, async () => {
      await setPrFixture(fx);
      const status = await prStatus(repo, 1);
      expect(deriveKanbanState(status)).toBe(expected);
    });
  }
});

test("readyForReview: green + unapproved is flagged; approved / failing / changes are not", () => {
  const base = { state: "OPEN", mergeable: "MERGEABLE" as const };
  expect(readyForReview({ ...base, ciStatus: "passing", reviewStatus: "review_required" })).toBe(true);
  expect(readyForReview({ ...base, ciStatus: "passing", reviewStatus: "approved" })).toBe(false);
  expect(readyForReview({ ...base, ciStatus: "failing", reviewStatus: "review_required" })).toBe(false);
  expect(readyForReview({ ...base, ciStatus: "passing", reviewStatus: "changes_requested" })).toBe(false);
});

test("W5 merge-when-green: guarded by canMerge, then worktree is removed", async () => {
  await fixture({ statusCheckRollup: [{ conclusion: "SUCCESS" }] });
  const green = await prStatus(repo, 1);
  expect(canMerge(green)).toBe(true);

  await setPrFixture({ state: "OPEN", mergeable: "CONFLICTING", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "FAILURE" }] });
  expect(canMerge(await prStatus(repo, 1))).toBe(false);

  // green but not yet approved cannot be merged (it belongs in Awaiting Approval)
  await fixture({ reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ conclusion: "SUCCESS" }] });
  expect(canMerge(await prStatus(repo, 1))).toBe(false);

  const { worktreePath: wt } = await createWorktree(repo, join(repo, ".worktrees"), "feat-merge", "main");
  await mergePr(repo, 1); // fake gh exits 0
  await removeWorktree(repo, wt);
  await expect(stat(wt)).rejects.toThrow();
});

test("W6 slack-notify-and-bump: bump only fires past the stale window", () => {
  const notified = "2026-07-01T00:00:00Z";
  expect(shouldBump(notified, undefined, Date.parse("2026-07-01T12:00:00Z"), 24)).toBe(false); // 12h < 24h
  expect(shouldBump(notified, undefined, Date.parse("2026-07-02T01:00:00Z"), 24)).toBe(true); // 25h
  expect(shouldBump(notified, "2026-07-02T00:30:00Z", Date.parse("2026-07-02T01:00:00Z"), 24)).toBe(false); // just bumped
  expect(shouldBump(undefined, undefined, Date.now(), 0)).toBe(false); // never notified

  // Slack prompt: send exactly the markdown link [#7 title](url), no thread/emoji; bump prefixes "Bump:"
  const notify = slackPrompt({ title: "Add X", prNumber: 7, prUrl: "https://gh/pr/7" }, "notify", "#eng");
  expect(notify).toContain("#eng");
  expect(notify).toContain("[#7 Add X](https://gh/pr/7)");
  expect(notify).toContain("do not reply in a thread");
  const bump = slackPrompt({ title: "Add X", prNumber: 7, prUrl: "u" }, "bump");
  expect(bump).toContain("Bump:\n[#7 Add X](u)");
});

test("W7 fix-conflicts: conflict blocks merge + yields a rebase prompt; clears once mergeable", async () => {
  await setPrFixture({ state: "OPEN", mergeable: "CONFLICTING", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] });
  expect(canMerge(await prStatus(repo, 1))).toBe(false); // conflict blocks merge even though approved + green

  const prompt = resolveConflictsPrompt({ branch: "feat-x" }, "main");
  expect(prompt).toContain("feat-x");
  expect(prompt).toContain("main");

  await fixture({ statusCheckRollup: [{ conclusion: "SUCCESS" }] }); // approved + MERGEABLE again
  expect(canMerge(await prStatus(repo, 1))).toBe(true);
});

test("W8 draft-toggle: markReady/convertToDraft shell out to `gh pr ready` (± --undo)", async () => {
  // Both directions just invoke gh and must resolve; convertToDraft backs an open PR down to draft.
  await expect(markReady(repo, 1)).resolves.toBeDefined();
  await expect(convertToDraft(repo, 1)).resolves.toBeDefined();
});

test("S1 source-of-truth: listWorktrees returns live worktrees under the root", async () => {
  const root = join(repo, ".worktrees");
  await createWorktree(repo, root, "feat-list", "main");
  const wts = await listWorktrees(repo, root);
  expect(wts.map((w) => w.branch)).toContain("feat-list");
  expect(wts.every((w) => w.worktreePath.includes("/.worktrees/"))).toBe(true); // main repo excluded
});

test("S2 source-of-truth: listPrs maps gh json to kanban rows", async () => {
  await setPrListFixture([
    { number: 10, title: "Add A", headRefName: "feat-a", url: "u10", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] },
    { number: 11, title: "Add B", headRefName: "feat-b", url: "u11", state: "OPEN", isDraft: true, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [] },
  ]);
  const prs = await listPrs(repo);
  expect(prs.map((p) => p.branch)).toEqual(["feat-a", "feat-b"]);
  expect(deriveKanbanState(prs[0]!)).toBe("MERGEABLE"); // approved
  expect([prs[0]!.isDraft, prs[1]!.isDraft]).toEqual([false, true]); // draft flag flows through for the Draft lane
});

test("D1 pr-detail: gh view json maps to a detail object", async () => {
  await setViewFixture({
    number: 5, title: "Add A", body: "Because reasons", author: { login: "finn" },
    state: "OPEN", url: "u", headRefName: "feat-a", baseRefName: "main",
    additions: 10, deletions: 2, changedFiles: 1,
    files: [{ path: "a.ts", additions: 10, deletions: 2 }],
    reviews: [{ author: { login: "bob" }, state: "APPROVED" }],
    comments: [{ author: { login: "carol" }, body: "nice" }],
    mergeable: "MERGEABLE", reviewDecision: "APPROVED",
    statusCheckRollup: [{ name: "build", conclusion: "SUCCESS" }, { name: "lint", conclusion: "FAILURE" }],
  });
  const d = await prDetail(repo, 5);
  expect(d.title).toBe("Add A");
  expect(d.author).toBe("finn");
  expect(d.files[0]?.path).toBe("a.ts");
  expect(d.reviews[0]).toEqual({ author: "bob", state: "APPROVED" });
  expect(d.checks).toEqual([{ name: "build", status: "passing" }, { name: "lint", status: "failing" }]);
  expect(d.ciStatus).toBe("failing"); // any failing check fails the rollup
});

test("D2 pr-diff: returns the raw unified diff", async () => {
  const diff = await prDiff(repo, 5);
  expect(diff).toContain("diff --git");
  expect(diff).toContain("added line");
});

test("D3 preview ports: a free port in range, never one already bound", async () => {
  // A random high port avoids the collision that bit two-quick-previews (both landed on the same
  // low port); the range is wide enough that reservation isn't needed. It must still skip a port
  // that's actually in use, so we never spawn a server onto an occupied port.
  const p = await freePort([10_000, 100_000]);
  expect(p).toBeGreaterThanOrEqual(10_000);
  expect(p).toBeLessThanOrEqual(100_000);

  const srv = createServer().listen(p, "0.0.0.0");
  await new Promise<void>((res) => srv.once("listening", () => res()));
  await expect(freePort([p, p])).rejects.toThrow(); // only option is the busy port → re-rolls out, then throws
  await new Promise<void>((res) => srv.close(() => res()));
});
