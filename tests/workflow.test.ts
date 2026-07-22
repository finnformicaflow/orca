// The core problem, as executable spec. Each test is named after a workflow step
// (W1–W7). git runs against a scratch repo; gh is a PATH shim. No network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { baseWorktree, changeSummary, createWorktree, linkToWorktree, listWorktrees, removeWorktree, resolveBase, resolvePrBody, syncWorktrees } from "../server/git";
import { addLabel, ciEvidence, convertToDraft, countExternalFeedback, createPr, disableAutoMerge, enableAutoMerge, listPrs, listReviewPrs, markReady, mergePr, prDetail, prDiff, prStatus, reviewEvidence } from "../server/gh";
import { freePort, killTree } from "../server/preview";
import { portFree, reclaimBridgePort, waitForPortFree } from "../server/net";
import { run } from "../server/run";
import {
  addressReviewPrompt, attachCommand, bulkActions, canMerge, deriveKanbanState, draftState, followAction, followDecision, followUpPrompt, investigateReportPrompt, launchPrompt,
  DEFAULT_PR_TEMPLATE, prDescriptionPrompt, prMenuActions, promptFor, resolveCiPrompt, resolveConflictsPrompt, shouldBump, slackApiText, slackClipboard, slackMessage, slackPrompt, slugifyBranch, summarizeSync, validPrDescription, withAttachments, type WorkstreamState,
} from "../web/src/workstream";
import { retryTitle, titleFromModelJson } from "../server/title";
import { parseRunMeta, prettyModel } from "../server/agent";
import { installFakeGh, makeScratchRepo, recordGhArgs, restorePath, setPrFixture, setPrListFixture, setRequiredChecksFixture, setReviewEvidenceFixture, setRunLogFixture, setViewFixture } from "./helpers";

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
  expect(launch).toContain("Inspect the repository instructions first");
  expect(launch).toContain("Treat any existing changes as user-owned");
  expect(launch).toContain("## Outcome");
  expect(launch.indexOf("do it")).toBeLessThan(launch.indexOf("Inspect the repository instructions"));
  expect(followUpPrompt("tweak the copy")).toContain("Do NOT open a pull request");
  // attachment paths (any file type) are appended for the agent to Read; none = prompt unchanged
  expect(withAttachments("go", [])).toBe("go");
  expect(withAttachments("go", ["/tmp/a.png", "/tmp/spec.docx"])).toContain("/tmp/spec.docx");
  // attach command drops you into a session continuing the headless run: exact id → --resume it;
  // unknown id → --continue the most recent conversation in that dir (never a bare, fresh `claude`).
  expect(attachCommand({ worktreePath: wt, sessionId: "abc-123" })).toBe(`cd "${wt}" && claude --resume abc-123 --permission-mode auto`);
  expect(attachCommand({ worktreePath: wt })).toBe(`cd "${wt}" && claude --continue --permission-mode auto`);
});

test("explicit prompt builders preserve action intent without natural-language inference", () => {
  const follow = followUpPrompt("Only adjust the cache timeout.");
  expect(follow.startsWith("Only adjust the cache timeout.")).toBe(true);
  expect(follow).toContain("incremental follow-up");
  expect(follow.match(/## Outcome/g)?.length).toBe(1);

  const investigate = investigateReportPrompt("Find why cache misses spike.");
  expect(investigate).toContain("Investigate and report only");
  expect(investigate).toContain("Do not modify files");
  expect(investigate).not.toContain("Commit and push");

  expect(resolveCiPrompt({ prNumber: 1, branch: "x" })).toContain("explicit Fix CI action");
  expect(addressReviewPrompt({ prNumber: 1, branch: "x" })).toContain("explicit Address review action");
  expect(resolveConflictsPrompt({ branch: "x" }, "main")).toContain("explicit resolve-conflicts action");
});

test("titleFromModelJson: zod-validates the title field, tolerates fences/prose, rejects junk/sentences", () => {
  expect(titleFromModelJson('{"title":"Dark Mode Toggle"}')).toBe("Dark Mode Toggle");
  expect(titleFromModelJson('```json\n{"title":"Add Usage Meter"}\n```')).toBe("Add Usage Meter"); // fenced
  expect(titleFromModelJson('Sure! {"title":"add dark mode"}')).toBe("Add dark mode"); // prose around it + capitalised
  // a sentence in the title field fails the schema → null so the caller falls back to the prompt
  expect(titleFromModelJson('{"title":"This task adds a dark mode toggle to the settings page for users"}')).toBeNull();
  expect(titleFromModelJson('{"name":"Wrong Field"}')).toBeNull(); // missing title field
  expect(titleFromModelJson("not json at all")).toBeNull();
  expect(titleFromModelJson("")).toBeNull();
});

test("retryTitle: refetches on an invalid reply, gives up after N attempts", async () => {
  let calls = 0;
  const flaky = async () => (++calls === 1 ? "garbage, no json" : '{"title":"Dark Mode Toggle"}');
  expect(await retryTitle(flaky, 3)).toBe("Dark Mode Toggle");
  expect(calls).toBe(2); // retried once, then the valid reply won

  let n = 0;
  const alwaysBad = async () => { n++; return "nope"; };
  expect(await retryTitle(alwaysBad, 2)).toBeNull();
  expect(n).toBe(2); // exhausted the attempts, then gave up (caller falls back to the prompt title)
});

test("run metadata: prettyModel + parseRunMeta surface model/context/cost from the claude -p JSON", () => {
  expect(prettyModel("claude-opus-4-8-20251101")).toBe("Opus 4.8");
  expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(prettyModel("claude-sonnet-5")).toBe("Sonnet 5");
  expect(prettyModel("claude-opus-4-8[1m]")).toBe("Opus 4.8"); // 1M-tier suffix stripped

  // contextPct = the FINAL iteration's read side (24783) over the window (1M) → 2% — NOT the
  // top-level `usage` sum. The real shape uses the `[1m]` tier key + a per-turn `iterations` array.
  const meta = parseRunMeta({
    modelUsage: { "claude-opus-4-8[1m]": { contextWindow: 1000000 } },
    usage: {
      input_tokens: 9999, cache_read_input_tokens: 9999, cache_creation_input_tokens: 9999, // cumulative — ignored
      iterations: [
        { input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 },
        { input_tokens: 4064, cache_read_input_tokens: 15667, cache_creation_input_tokens: 5052 },
      ],
    },
    total_cost_usd: 0.0148681, num_turns: 3, duration_ms: 12340,
  });
  expect(meta).toEqual({
    model: "Opus 4.8", contextPct: 2, costUsd: 0.0148681, numTurns: 3, durationMs: 12340,
    inputTokens: 9999, outputTokens: undefined, cacheReadTokens: 9999, cacheCreationTokens: 9999,
  });
  // single-turn runs have no `iterations` → fall back to top-level usage (4064+15667+5052 = 24783 → 2%)
  expect(parseRunMeta({
    modelUsage: { "claude-opus-4-8[1m]": { contextWindow: 1000000 } },
    usage: { input_tokens: 4064, cache_read_input_tokens: 15667, cache_creation_input_tokens: 5052 },
  }).contextPct).toBe(2);
  // missing/garbage input → all-undefined, never throws (line just doesn't render)
  expect(parseRunMeta({})).toEqual({
    model: undefined, contextPct: undefined, costUsd: undefined, numTurns: undefined, durationMs: undefined,
    inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheCreationTokens: undefined,
  });

  // Multi-model run: Claude Code fires an auxiliary Haiku alongside the Opus work and lists it
  // FIRST in modelUsage. The primary model = the one with the most output tokens (Opus), NOT the
  // first key — else the card reads "Haiku" and the last Opus turn's 218k prompt is divided by
  // Haiku's 200k window → 109%. With Opus's 1M window picked, it's a sane 22%.
  const multi = parseRunMeta({
    modelUsage: {
      "claude-haiku-4-5-20251001": { contextWindow: 200000, outputTokens: 13 },
      "claude-opus-4-8[1m]": { contextWindow: 1000000, outputTokens: 168 },
    },
    usage: { input_tokens: 4, cache_read_input_tokens: 213071, cache_creation_input_tokens: 4925 }, // 218000
    total_cost_usd: 0.07, num_turns: 5, duration_ms: 9999,
  });
  expect(multi.model).toBe("Opus 4.8"); // not "Haiku 4.5"
  expect(multi.contextPct).toBe(22); // 218000 / 1_000_000, not 218000 / 200_000 (= 109%)
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
  // Per-file diffstat powers the skimmable "Files changed" summary on the local-session Overview.
  const featureFile = summary.files.find((f) => f.path === "feature.ts");
  expect(featureFile?.additions).toBe(1);
  expect(featureFile?.deletions).toBe(0);
  expect(draftState(summary.commits.length)).toBe("READY");
});

test("W3 promote-to-pr: gh pr create returns number + url", async () => {
  const { worktreePath: wt } = await createWorktree(repo, join(repo, ".worktrees"), "feat-pr", "main");
  process.env.ORCA_PR_NUMBER = "42";
  const pr = await createPr(wt, { title: "Feat", body: "b", base: "main", head: "feat-pr" });
  expect(pr.number).toBe(42);
  expect(pr.url).toEndWith("/42");
});

test("W3c promote labels: configured PR labels are applied comma-joined in one gh call", async () => {
  const read = await recordGhArgs();
  await addLabel(repo, 42, ["preview", "urgent"].join(",")); // what /api/promote does with body.labels
  process.env.ORCA_GH_ARGS_LOG = ""; // stop recording so later tests aren't polluted
  const log = await read();
  expect(log).toContain("pr edit 42 --add-label preview,urgent");
});

test("W3b promote body: no blank PRs — commit summary by default, the repo's PR template if present", async () => {
  const { worktreePath: wt } = await createWorktree(repo, join(repo, ".worktrees"), "feat-body", "main");
  const base = await resolveBase(repo, "main");

  // No commits yet, no template → a placeholder, never blank.
  expect(await resolvePrBody(wt, base, "")).toBe("_No commits yet._");

  // A caller-supplied body always wins untouched.
  expect(await resolvePrBody(wt, base, "hand written")).toBe("hand written");

  // Commits but no template → a "what changed" overview from the commit subjects, oldest-first.
  await writeFile(join(wt, "a.ts"), "export const a = 1;\n");
  await run(["git", "-C", wt, "add", "."]);
  await run(["git", "-C", wt, "commit", "-m", "add a"]);
  await writeFile(join(wt, "b.ts"), "export const b = 2;\n");
  await run(["git", "-C", wt, "add", "."]);
  await run(["git", "-C", wt, "commit", "-m", "add b"]);
  const summary = await resolvePrBody(wt, base, "");
  expect(summary).toContain("- add a");
  expect(summary).toContain("- add b");
  expect(summary.indexOf("add a")).toBeLessThan(summary.indexOf("add b")); // oldest-first

  // A checked-in PR template becomes the body (the repo's own guidelines win over the summary).
  await mkdir(join(wt, ".github"), { recursive: true });
  await writeFile(join(wt, ".github/PULL_REQUEST_TEMPLATE.md"), "## Why\n\n## What\n");
  expect(await resolvePrBody(wt, base, "")).toBe("## Why\n\n## What");
});

test("W3c AI PR description: prompt is built from the diff, template + conventions", () => {
  const diff = "diff --git a/server/pay.ts b/server/pay.ts\n+charge(user)";
  const commits = ["add a", "add b"];

  // No template → the AI is told the section set to fill, plus the diff + commits (oldest-first).
  const noTemplate = prDescriptionPrompt({
    template: null, diff, commits, task: "Stop duplicate charges for retried requests.",
    outcome: { outcome: "Added idempotent charging.", verification: ["bun test — passed"], decisions: ["Reused request IDs"], remaining: [], commits: [] },
  });
  expect(noTemplate).toContain("What & Why");
  expect(noTemplate).toContain("Key Decisions & Trade-offs");
  expect(noTemplate).toContain("What Changed");
  expect(noTemplate).toContain("Stop duplicate charges");
  expect(noTemplate).toContain("Reused request IDs");
  expect(noTemplate).toContain("bun test — passed");
  expect(noTemplate).toContain(diff);
  expect(noTemplate.indexOf("- add a")).toBeLessThan(noTemplate.indexOf("- add b")); // oldest-first
  // Safety conventions are always in the prompt.
  expect(noTemplate).toContain("breaking change");
  expect(noTemplate).toContain("top of What & Why");
  expect(noTemplate).toContain("Never include secrets");
  expect(noTemplate).toContain("ONLY the description"); // no preamble → body is drop-in for gh

  // A template is embedded verbatim so the AI fills the repo's own sections.
  const withTemplate = prDescriptionPrompt({ template: "## Risks\n\n## Rollout", diff, commits });
  expect(withTemplate).toContain("## Risks\n\n## Rollout");
  expect(withTemplate).toContain("fill every");

  // A huge diff is truncated so it can't blow the context window (commits still included).
  const huge = prDescriptionPrompt({ template: null, diff: "x".repeat(40_000), commits });
  expect(huge).toContain("(diff truncated)");
  expect(huge.length).toBeLessThan(40_000);
});

test("W3d generated PR descriptions must fill the exact six-section template", () => {
  const body = [
    "## What & Why", "Fix duplicate charges on retries.",
    "## Key Decisions & Trade-offs", "Reuse the request ID rather than add a new table.",
    "## How It Works", "The charge path now forwards an idempotency key.",
    "## What Changed", "- Backend: pass the request ID to the provider.",
    "## Testing & Verification", "- `bun test` — passed.",
    "## Risks & Follow-ups", "None.",
  ].join("\n\n");
  expect(validPrDescription(body, null)).toBe(true);
  expect(validPrDescription("Fix duplicate charges", null)).toBe(false); // title-only
  expect(validPrDescription(DEFAULT_PR_TEMPLATE, null)).toBe(false); // empty guidance template
  expect(validPrDescription(body.replace("None.", "<!-- None. -->"), null)).toBe(false);
  expect(validPrDescription(body.replace("## How It Works", "## Implementation"), null)).toBe(false);
  expect(validPrDescription("## Risks\n\nLow.\n\n## Rollout\n\nNo special steps.", "## Risks\n\n## Rollout")).toBe(true);
});

test("W3e review evidence returns bounded unresolved human inline threads", async () => {
  await setReviewEvidenceFixture({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { id: "open", isResolved: false, path: "src/a.ts", line: 9, comments: { nodes: [{ author: { login: "alice" }, body: "Please handle the edge case", url: "https://review/open" }] } },
    { id: "resolved", isResolved: true, comments: { nodes: [{ author: { login: "bob" }, body: "old" }] } },
    { id: "bot", isResolved: false, comments: { nodes: [{ author: { login: "ci[bot]" }, body: "noise" }] } },
    { id: "bounded", isResolved: false, comments: { nodes: [{ author: { login: "carol" }, body: "z".repeat(5_000) }] } },
  ] } } } } });
  const threads = await reviewEvidence(repo, 42);
  expect(threads.map((thread) => thread.id)).toEqual(["open", "bounded"]);
  expect(threads[0]).toMatchObject({ path: "src/a.ts", line: 9, author: "alice", resolved: false });
  expect(threads[1]!.body).toContain("(truncated)");
  expect(JSON.stringify(threads).length).toBeLessThan(8_500);
});

test("W3f CI evidence includes failed-step excerpts and external-check fallback", async () => {
  await setViewFixture({ statusCheckRollup: [
    { name: "unit", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/app/actions/runs/123/job/456" },
    { context: "external", state: "ERROR", targetUrl: "https://ci.example.test/build/1" },
    { name: "passing", conclusion: "SUCCESS" },
  ] });
  await setRunLogFixture(["setup", "running suite", "Error: expected true", "at cache.test.ts:4", "cleanup"].join("\n"));
  const failures = await ciEvidence(repo, 42);
  expect(failures).toHaveLength(2);
  expect(failures[0]).toMatchObject({ name: "unit", status: "FAILURE" });
  expect(failures[0]!.excerpt).toContain("Error: expected true");
  expect(failures[1]).toEqual({ name: "external", status: "ERROR", url: "https://ci.example.test/build/1", excerpt: undefined });
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

test("W5 merge-when-green: guarded by canMerge, then worktree is removed", async () => {
  await fixture({ statusCheckRollup: [{ conclusion: "SUCCESS" }] });
  const green = await prStatus(repo, 1);
  expect(canMerge(green)).toBe(true);

  await setPrFixture({ state: "OPEN", mergeable: "CONFLICTING", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "FAILURE" }] });
  expect(canMerge(await prStatus(repo, 1))).toBe(false);

  // mergeability UNKNOWN (GitHub hasn't computed it yet) must NOT block — only a real conflict does;
  // gh pr merge is the final arbiter. Blocking on UNKNOWN was the "not mergeable/green" false reject.
  await fixture({ mergeable: "UNKNOWN", statusCheckRollup: [{ conclusion: "SUCCESS" }] });
  expect(canMerge(await prStatus(repo, 1))).toBe(true);

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
  expect(slackMessage({ title: "Add X", prNumber: 7, prUrl: "u" }, "notify")).toBe("[#7 Add X](u)");
  expect(slackMessage({ title: "Add X", prNumber: 7, prUrl: "u" }, "bump")).toBe("Bump:\n[#7 Add X](u)");

  // Clipboard flavours for the Copy Slack action: an <a> so Slack pastes a real hyperlink (title as
  // link text), plus a plain fallback that is NOT Markdown (which pastes literally and "looks strange").
  const clip = slackClipboard({ title: "Add X", prNumber: 7, prUrl: "https://gh/pr/7" }, "notify");
  expect(clip.html).toBe('<a href="https://gh/pr/7">#7 Add X</a>');
  expect(clip.text).toBe("#7 Add X\nhttps://gh/pr/7");
  const bumpClip = slackClipboard({ title: "Add X", prNumber: 7, prUrl: "https://gh/pr/7" }, "bump");
  expect(bumpClip.html).toBe('Bump:<br><a href="https://gh/pr/7">#7 Add X</a>');
  expect(bumpClip.text).toBe("Bump:\n#7 Add X\nhttps://gh/pr/7");
  // A title with HTML-special characters can't break the anchor markup.
  expect(slackClipboard({ title: "A & B <ok>", prNumber: 1, prUrl: "u" }, "notify").html).toBe('<a href="u">#1 A &amp; B &lt;ok&gt;</a>');

  // Webhook auto-send uses Slack's native mrkdwn link so it renders as the SAME linked `#7 Title`
  // (a hyperlink, not literal Markdown) as the rich-html copy.
  expect(slackApiText({ title: "Add X", prNumber: 7, prUrl: "https://gh/pr/7" }, "notify")).toBe("<https://gh/pr/7|#7 Add X>");
  expect(slackApiText({ title: "Add X", prNumber: 7, prUrl: "https://gh/pr/7" }, "bump")).toBe("Bump:\n<https://gh/pr/7|#7 Add X>");
  expect(slackApiText({ title: "Add X", prNumber: 7, prUrl: "" }, "notify")).toBe("#7 Add X"); // no URL → plain label
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

// W10 active-following: given a polled PR status, decide which agent action to auto-run. This is the
// pure decision behind the "Follow PR" toggle — the store fires the matching action off every poll
// (see tests/activeFollowing.test.tsx for the end-to-end wiring). Priority: conflict → CI → review.
describe("W10 active-following (followAction)", () => {
  test("a clean, green, approved PR needs nothing", () => {
    expect(followAction({ mergeable: "MERGEABLE", ciStatus: "passing", reviewStatus: "approved" })).toBeNull();
  });
  test("a merge conflict wins over everything → resolveConflicts", () => {
    expect(followAction({ mergeable: "CONFLICTING", ciStatus: "failing", reviewStatus: "changes_requested" })).toBe("resolveConflicts");
  });
  test("failing CI (no conflict) → fixCi", () => {
    expect(followAction({ mergeable: "MERGEABLE", ciStatus: "failing", reviewStatus: "review_required" })).toBe("fixCi");
    expect(resolveCiPrompt({ prNumber: 7, branch: "feat" }, ["unit", "lint"])).toContain("unit, lint");
  });
  test("requested changes (clean + green) → addressReview", () => {
    expect(followAction({ mergeable: "MERGEABLE", ciStatus: "passing", reviewStatus: "changes_requested" })).toBe("addressReview");
  });
  test("pending CI and unknown mergeability are not (yet) actionable", () => {
    expect(followAction({ mergeable: "UNKNOWN", ciStatus: "pending", reviewStatus: "review_required" })).toBeNull();
  });
  test("a draft PR is never followed, even with a blocker", () => {
    expect(followAction({ isDraft: true, mergeable: "CONFLICTING", ciStatus: "failing" })).toBeNull();
  });
  test("the review follow-up prompt points the agent at the PR's comments", () => {
    const p = addressReviewPrompt({ prNumber: 7, branch: "feat-x" }, ["Please add a regression test"]);
    expect(p).toContain("#7");
    expect(p).toContain("feat-x");
    expect(p).toContain("gh pr view 7 --comments");
    expect(p).toContain("Please add a regression test");
  });
});

describe("W11 follow decisions (followDecision — blockers + new-comment triggering)", () => {
  const green = { mergeable: "MERGEABLE", ciStatus: "passing", reviewStatus: "approved" } as const;
  test("a blocker fires regardless of feedback, tagging the sig with the count", () => {
    expect(followDecision({ ...green, ciStatus: "failing", externalFeedback: 2 }, undefined))
      .toEqual({ action: "fixCi", sig: "fixCi#2" });
  });
  test("first follow of a green PR with existing comments addresses them once", () => {
    // prevSig undefined (just enabled / cleared) → pending feedback is picked up
    expect(followDecision({ ...green, externalFeedback: 3 }, undefined)).toEqual({ action: "addressReview", sig: "ok#3" });
  });
  test("a steady state never re-fires — same sig → no action (survives reloads)", () => {
    expect(followDecision({ ...green, externalFeedback: 3 }, "ok#3")).toEqual({ action: null, sig: "ok#3" });
  });
  test("a NEW comment (feedback ↑ since last acted) fires addressReview again", () => {
    expect(followDecision({ ...green, externalFeedback: 4 }, "ok#3")).toEqual({ action: "addressReview", sig: "ok#4" });
  });
  test("feedback dropping (a deleted comment) records the sig but does not fire", () => {
    expect(followDecision({ ...green, externalFeedback: 2 }, "ok#3")).toEqual({ action: null, sig: "ok#2" });
  });
});

test("countExternalFeedback tallies others' comments/reviews, ignoring the author and bots", () => {
  const author = "me";
  const comments = [
    { author: { login: "me" } },        // self — ignored
    { author: { login: "coworker" } },  // human — counts
    { author: { login: "vercel[bot]" } }, // bot — ignored
  ];
  const reviews = [
    { author: { login: "reviewer" }, state: "CHANGES_REQUESTED" }, // counts
    { author: { login: "reviewer2" }, state: "COMMENTED" },        // counts
    { author: { login: "reviewer3" }, state: "APPROVED" },         // approval isn't "feedback to address"
    { author: { login: "me" }, state: "COMMENTED" },               // self — ignored
  ];
  expect(countExternalFeedback(author, comments, reviews)).toBe(3); // 1 comment + 2 reviews
  expect(countExternalFeedback(author, [], [])).toBe(0);
});

test("W8 draft-toggle: markReady/convertToDraft shell out to `gh pr ready` (± --undo)", async () => {
  // Both directions just invoke gh and must resolve; convertToDraft backs an open PR down to draft.
  await expect(markReady(repo, 1)).resolves.toBeDefined();
  await expect(convertToDraft(repo, 1)).resolves.toBeDefined();
});

test("W9 auto-merge: enableAutoMerge shells out to `gh pr merge --auto` (queues the merge for when CI/reviews pass)", async () => {
  // Unlike mergePr, this doesn't require the PR to be green *now* — GitHub holds it until requirements pass.
  await expect(enableAutoMerge(repo, 1)).resolves.toBeDefined();
});

test("S1 source-of-truth: listWorktrees returns live worktrees under the root", async () => {
  const root = join(repo, ".worktrees");
  await createWorktree(repo, root, "feat-list", "main");
  const wts = await listWorktrees(repo, root);
  expect(wts.map((w) => w.branch)).toContain("feat-list");
  expect(wts.every((w) => w.worktreePath.includes("/.worktrees/"))).toBe(true); // main repo excluded
});

test("M1 test-master: baseWorktree makes a detached checkout of the latest base, invisible to the board", async () => {
  const repoM = await makeScratchRepo(); // isolated so the extra commit doesn't touch the shared repo
  const root = join(repoM, ".worktrees");
  // Advance main so we can prove the base worktree tracks the newest tip, not a stale one.
  await writeFile(join(repoM, "bug.txt"), "repro\n");
  await run(["git", "-C", repoM, "add", "."]);
  await run(["git", "-C", repoM, "commit", "-m", "add bug"]);
  const mainTip = (await run(["git", "-C", repoM, "rev-parse", "main"])).trim();

  const { worktreePath } = await baseWorktree(repoM, root, "main");
  expect(await stat(join(worktreePath, "bug.txt")).then(() => true)).toBe(true); // real checkout on disk…
  expect((await run(["git", "-C", worktreePath, "rev-parse", "HEAD"])).trim()).toBe(mainTip); // …at main's tip

  // Detached → no `branch refs/heads/…` line → never surfaces as a Local workstream card.
  expect((await listWorktrees(repoM, root)).map((w) => w.branch)).not.toContain("main");

  // Reusable: a second call refreshes the SAME path (kept in place with its env/node_modules).
  const again = await baseWorktree(repoM, root, "main");
  expect(again.worktreePath).toBe(worktreePath);
  await removeWorktree(repoM, worktreePath).catch(() => {});
});

test("S2 source-of-truth: listPrs maps gh json to kanban rows", async () => {
  await setPrListFixture([
    { number: 10, title: "Add A", headRefName: "feat-a", url: "u10", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED", author: { login: "me" }, comments: [{ author: { login: "alex" }, body: "Please add a regression test" }], statusCheckRollup: [{ name: "unit", conclusion: "FAILURE" }] },
    { number: 11, title: "Add B", headRefName: "feat-b", url: "u11", state: "OPEN", isDraft: true, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [] },
  ]);
  const prs = await listPrs(repo);
  expect(prs.map((p) => p.branch)).toEqual(["feat-a", "feat-b"]);
  expect(deriveKanbanState(prs[0]!)).toBe("MERGEABLE"); // approved
  expect([prs[0]!.isDraft, prs[1]!.isDraft]).toEqual([false, true]); // draft flag flows through for the Draft lane
  expect(prs[0]!.failingChecks).toEqual(["unit"]);
  expect(prs[0]!.feedback).toEqual(["Please add a regression test"]);
});

test("S2b required-check gating: only merge-gating checks decide CI (advisory bots ignored)", async () => {
  const rollup = [
    { name: "build-backend", conclusion: "SUCCESS" },
    { name: "claude-review", conclusion: "FAILURE" }, // advisory AI-review bot — not a merge gate
  ];
  const prFixture = (n: number) => [{ number: n, title: "Legible", headRefName: "feat-leg", baseRefName: "main", url: "u", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED", author: { login: "me" }, statusCheckRollup: rollup }];

  // Branch protection requires only build-backend → the failing advisory bot is ignored, CI passes.
  const gated = await makeScratchRepo(); // fresh cwd = fresh requiredChecks cache key
  await setRequiredChecksFixture(["build-backend"]);
  await setPrListFixture(prFixture(50));
  const gatedPrs = await listPrs(gated);
  expect(gatedPrs[0]!.ciStatus).toBe("passing");
  expect(gatedPrs[0]!.failingChecks).toBeUndefined();

  // Control: no branch protection (empty required set) → all checks count, so the bot fails CI.
  const ungated = await makeScratchRepo();
  await setRequiredChecksFixture([]);
  await setPrListFixture(prFixture(51));
  const ungatedPrs = await listPrs(ungated);
  expect(ungatedPrs[0]!.ciStatus).toBe("failing");
  expect(ungatedPrs[0]!.failingChecks).toEqual(["claude-review"]);
});

test("S3 auto-merge badge: listPrs surfaces GitHub's autoMergeRequest as a boolean flag", async () => {
  await setPrListFixture([
    { number: 12, title: "Armed", headRefName: "feat-am", url: "u12", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], autoMergeRequest: { enabledAt: "2026-07-07T10:00:00Z" } },
    { number: 13, title: "Not armed", headRefName: "feat-nm", url: "u13", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], autoMergeRequest: null },
  ]);
  const readArgs = await recordGhArgs();
  const prs = await listPrs(repo);
  expect(prs.map((p) => p.autoMergeEnabled)).toEqual([true, false]); // the card renders a purple auto-merge badge only for the armed PR
  // …and guard the field is actually *requested* from gh — without it the live API omits the flag
  // (the badge silently never shows), even though the mapping above still passes on the fixture.
  expect(await readArgs()).toContain("autoMergeRequest");
});

test("S4 auto-merge is a toggle: enable and disable issue the matching gh commands", async () => {
  const readArgs = await recordGhArgs();
  await enableAutoMerge(repo, 42);
  await disableAutoMerge(repo, 42);
  const args = await readArgs();
  expect(args).toContain("pr merge 42 --auto --squash"); // enable
  expect(args).toContain("pr merge 42 --disable-auto");   // disable — the previously-missing half
});

test("R1 review-queue: listReviewPrs maps coworker meta (author + updated), newest first, no comments", async () => {
  await setPrListFixture([
    { number: 20, title: "Older", headRefName: "feat-old", url: "u20", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", author: { login: "alex", name: "Alex Atack" }, updatedAt: "2026-07-01T10:00:00Z" },
    { number: 21, title: "Newer", headRefName: "feat-new", url: "u21", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED", author: { login: "sam" }, updatedAt: "2026-07-05T10:00:00Z" },
  ]);
  const prs = await listReviewPrs(repo);
  expect(prs.map((p) => p.number)).toEqual([21, 20]); // newest-updated first
  expect(prs[0]).toMatchObject({ author: "sam", authorName: "sam", reviewStatus: "approved" });
  expect(prs[0]!.previewUrl).toBeUndefined(); // meta list skips comments — the preview URL is a detail-only field
  expect(prs[0]!.ciStatus).toBe("none"); // and skips CI (statusCheckRollup) — that's a detail-only, slow fetch
  expect(prs[1]).toMatchObject({ author: "alex", authorName: "Alex Atack" }); // name preferred over login
});

test("R2 review-queue: listReviewPrs caches per repo, serving the queue without re-running gh (fast reloads/polls)", async () => {
  const repo2 = await makeScratchRepo(); // fresh cwd = fresh cache key, isolated from other tests
  await setPrListFixture([{ number: 30, title: "First", headRefName: "feat-1", url: "u30", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", author: { login: "alex" }, updatedAt: "2026-07-01T10:00:00Z" }]);
  const first = await listReviewPrs(repo2); // cold: shells gh, populates the cache
  expect(first.map((p) => p.number)).toEqual([30]);
  await setPrListFixture([{ number: 31, title: "Changed", headRefName: "feat-2", url: "u31", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", author: { login: "sam" }, updatedAt: "2026-07-06T10:00:00Z" }]);
  const second = await listReviewPrs(repo2); // within TTL: served from cache, so it still shows the first fixture, not the changed one
  expect(second.map((p) => p.number)).toEqual([30]);
});

test("R3 review-queue: a failed cold fetch surfaces the error (not a silent empty queue) and isn't cached", async () => {
  const repo3 = await makeScratchRepo();
  process.env.ORCA_PRLIST_FIXTURE = "/nonexistent/orca-prlist.json"; // make `gh pr list` fail
  await expect(listReviewPrs(repo3)).rejects.toThrow(); // cold failure surfaces
  await setPrListFixture([{ number: 40, title: "Recovered", headRefName: "feat-r", url: "u40", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", author: { login: "alex" }, updatedAt: "2026-07-01T10:00:00Z" }]);
  const after = await listReviewPrs(repo3); // no stale placeholder cached, so it retries and recovers
  expect(after.map((p) => p.number)).toEqual([40]);
});

test("P1 preview isolation: node_modules is CoW-cloned so worktrees can't perturb each other's deps", async () => {
  const src = await mkdtemp(join(tmpdir(), "orca-src-"));
  const wt = await mkdtemp(join(tmpdir(), "orca-wt-"));
  // main-repo node_modules: a package + Vite's dep-optimize cache
  await mkdir(join(src, "frontend/node_modules/somepkg"), { recursive: true });
  await writeFile(join(src, "frontend/node_modules/somepkg/index.js"), "module.exports=1");
  await mkdir(join(src, "frontend/node_modules/.vite/deps"), { recursive: true });

  await linkToWorktree(src, wt, ["frontend/node_modules"]);

  const nm = join(wt, "frontend/node_modules");
  // a real directory, NOT a symlink to the shared dir
  expect((await lstat(nm)).isSymbolicLink()).toBe(false);
  expect((await lstat(nm)).isDirectory()).toBe(true);
  // packages resolve from the clone, and .vite comes along (now worktree-local, no shared cache)
  expect(await readFile(join(nm, "somepkg/index.js"), "utf8")).toBe("module.exports=1");
  expect((await lstat(join(nm, ".vite/deps"))).isDirectory()).toBe(true);
  // isolation — the clone is independent both ways: a write in the worktree doesn't reach the
  // source, and a mutation of the source (a concurrent `npm install`) doesn't reach the worktree.
  // That severed link is what stops the shared-tree corruption ("only abstract entities" / 504s).
  await writeFile(join(nm, "somepkg/added.js"), "x");
  await expect(readFile(join(src, "frontend/node_modules/somepkg/added.js"), "utf8")).rejects.toThrow();
  await writeFile(join(src, "frontend/node_modules/somepkg/index.js"), "module.exports=2");
  expect(await readFile(join(nm, "somepkg/index.js"), "utf8")).toBe("module.exports=1");
});

test("P2 preview cleanup: killTree reaps the whole subtree incl. a backgrounded loop", async () => {
  // Mimic the preview's `sh -lc` wrapper: a parent shell with a BACKGROUNDED child (the reseed
  // poll loop, `… &`) plus a foreground child. proc.kill() hits only the shell, orphaning the
  // backgrounded loop — which is exactly the 23h "sleep 2" leak. killTree must get all of them.
  const proc = Bun.spawn(["sh", "-lc", "sleep 30 & sleep 30"]);
  let kids: number[] = [];
  for (let i = 0; i < 20 && kids.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    kids = Bun.spawnSync(["pgrep", "-P", String(proc.pid)]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
  }
  expect(kids.length).toBeGreaterThan(0); // children exist

  killTree(proc.pid);
  await new Promise((r) => setTimeout(r, 250));
  const alive = [proc.pid, ...kids].filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  expect(alive).toEqual([]); // wrapper AND every descendant reaped
});

// A fake bridge that just holds a port, spawned from a path we control so its argv either does or
// doesn't look like an Orca bridge (server/index.ts). Waits until it's actually bound.
const LISTENER = "const p=Number(process.argv[2]);Bun.serve({port:p,fetch:()=>new Response('ok')});await new Promise(()=>{});";
async function spawnListener(scriptPath: string, port: number): Promise<Bun.Subprocess> {
  await writeFile(scriptPath, LISTENER);
  const proc = Bun.spawn(["bun", scriptPath, String(port)], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 60 && (await portFree(port)); i++) await new Promise((r) => setTimeout(r, 50));
  return proc;
}

test("N1 bridge-port reclaim: a stale bridge on the API port is killed so a fresh one can bind", async () => {
  // The "Test master 404" bug: a bridge from another checkout squatted the API port, so the fresh
  // bridge lost the bind and the UI proxied to old, routeless code. Reclaim must free the port.
  const dir = await mkdtemp(join(tmpdir(), "orca-bridge-"));
  await mkdir(join(dir, "server"), { recursive: true });
  const port = await freePort([20_000, 60_000]);
  await spawnListener(join(dir, "server", "index.ts"), port); // argv → …/server/index.ts (looks like a bridge)

  expect(await portFree(port)).toBe(false); // squatting
  expect(reclaimBridgePort(port)).toBe(true); // matched an Orca bridge → killed it
  expect(await waitForPortFree(port)).toBe(true); // …and the port is now bindable
});

test("N2 bridge-port reclaim: an unrelated service on the port is left alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-decoy-"));
  const port = await freePort([20_000, 60_000]);
  const proc = await spawnListener(join(dir, "decoy.ts"), port); // argv does NOT look like a bridge
  try {
    expect(reclaimBridgePort(port)).toBe(false); // not an Orca bridge → don't touch it
    expect(await portFree(port)).toBe(false); // still bound
  } finally {
    killTree(proc.pid!); // it wasn't reaped by reclaim, so clean it up
  }
});

test("D1 pr-detail: gh view json maps to a detail object", async () => {
  await setViewFixture({
    number: 5, title: "Add A", body: "Because reasons", author: { login: "finn" },
    state: "OPEN", url: "u", headRefName: "feat-a", baseRefName: "main",
    additions: 10, deletions: 2, changedFiles: 1,
    files: [{ path: "a.ts", additions: 10, deletions: 2 }],
    reviews: [{ author: { login: "bob" }, state: "APPROVED" }],
    comments: [{ author: { login: "carol" }, body: "nice" }, { author: { login: "bot" }, body: "Deploy preview: https://feat-a.preview.example.com is ready" }],
    mergeable: "MERGEABLE", reviewDecision: "APPROVED",
    statusCheckRollup: [{ name: "build", conclusion: "SUCCESS" }, { name: "lint", conclusion: "FAILURE" }],
    autoMergeRequest: { enabledAt: "2026-07-07T10:00:00Z", mergeMethod: "SQUASH" },
  });
  const d = await prDetail(repo, 5);
  expect(d.title).toBe("Add A");
  expect(d.author).toBe("finn");
  expect(d.files[0]?.path).toBe("a.ts");
  expect(d.reviews[0]).toEqual({ author: "bob", state: "APPROVED" });
  expect(d.checks).toEqual([{ name: "build", status: "passing" }, { name: "lint", status: "failing" }]);
  expect(d.ciStatus).toBe("failing"); // any failing check fails the rollup
  expect(d.previewUrl).toBe("https://feat-a.preview.example.com"); // deep fetch surfaces the deploy preview
  expect(d.autoMergeEnabled).toBe(true); // gh's autoMergeRequest object → the detail page's auto-merge badge
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
  const p = await freePort([10_000, 65_000]); // matches config portRange; portFree re-rolls any out-of-range port
  expect(p).toBeGreaterThanOrEqual(10_000);
  expect(p).toBeLessThanOrEqual(65_000);

  const srv = createServer().listen(p, "0.0.0.0");
  await new Promise<void>((res) => srv.once("listening", () => res()));
  await expect(freePort([p, p])).rejects.toThrow(); // only option is the busy port → re-rolls out, then throws
  await new Promise<void>((res) => srv.close(() => res()));
});

// A1 PR-actions submenu: the "PR" submenu groups exactly the actions that need an open PR, gated by
// the row's live state. A branch with no PR gets none (those actions live elsewhere in the menu).
describe("A1 PR-actions submenu (prMenuActions)", () => {
  test("no PR → no PR-scoped actions", () => {
    expect(prMenuActions({ prUrl: "x", ciStatus: "failing" })).toEqual([]);
  });

  test("open ready PR → draft toggle + auto-merge + copy link, plus preview when unlabeled", () => {
    expect(prMenuActions({ prNumber: 5, prUrl: "u" })).toEqual(["moveToDraft", "autoMerge", "addressReview", "addPreview", "copyLink"]);
  });

  test("draft PR offers Mark ready instead of Move to draft, and no auto-merge (gh rejects it on a draft)", () => {
    expect(prMenuActions({ prNumber: 5, isDraft: true, prUrl: "u", previewUrl: "p" })).toEqual(["markReady", "addressReview", "copyLink"]);
  });

  test("conflicts and failing CI add their fix actions, in order", () => {
    expect(prMenuActions({ prNumber: 5, mergeable: "CONFLICTING", ciStatus: "failing", previewUrl: "p", prUrl: "u" }))
      .toEqual(["moveToDraft", "autoMerge", "resolveConflicts", "fixCi", "addressReview", "copyLink"]);
  });

  test("no prUrl → no Copy link (nothing to copy)", () => {
    expect(prMenuActions({ prNumber: 5, previewUrl: "p" })).toEqual(["moveToDraft", "autoMerge", "addressReview"]);
  });
});

// A2 swimlane bulk actions: each lane offers the verbs its cards support, and every offered action
// carries exactly the cards that could take it individually — so a bulk run never touches a card the
// per-card menu would have refused (and an action with no eligible card isn't offered at all).
describe("A2 swimlane bulk actions (bulkActions)", () => {
  const names = (lane: string, rows: Parameters<typeof bulkActions>[1]) =>
    bulkActions(lane, rows).map((g) => `${g.action}:${g.rows.length}`);

  test("Local offers test/promote, and Resolve conflicts only when a branch conflicts with base", () => {
    const rows = [{ hasRemote: true }, { hasRemote: true, mergeClean: "conflict" as const }];
    expect(names("LOCAL", rows)).toEqual(["testLocally:2", "promoteDraft:2", "promoteReady:2", "resolveConflicts:1"]);
    expect(names("LOCAL", [{ hasRemote: false }])).toEqual(["testLocally:1"]); // no remote → no PR to open
  });

  test("Draft offers Ready for review for draft PRs only", () => {
    expect(names("DRAFT", [{ prNumber: 1, isDraft: true }, { prNumber: 2 }])).toEqual(["markReady:1"]);
  });

  test("In Review offers Slack + Auto-merge, and the fix actions only where the condition is live", () => {
    const rows = [
      { prNumber: 1, ciStatus: "failing" as const },
      { prNumber: 2, mergeable: "CONFLICTING" as const },
      { prNumber: 3, autoMergeEnabled: true, reviewStatus: "changes_requested" as const },
    ];
    expect(names("IN_REVIEW", rows)).toEqual(["slack:3", "autoMerge:2", "resolveConflicts:1", "fixCi:1", "addressReview:1"]);
  });

  test("a running agent is skipped by the agent actions (its run lease would reject a second launch)", () => {
    const rows = [{ prNumber: 1, ciStatus: "failing" as const, agentStatus: "running" as const }];
    expect(names("IN_REVIEW", rows)).toEqual(["slack:1", "autoMerge:1"]);
  });

  test("Mergeable merges the cards that can merge; Done offers nothing", () => {
    const rows = [{ prNumber: 1 }, { prNumber: 2, ciStatus: "failing" as const }];
    expect(names("MERGEABLE", rows)).toEqual(["merge:1", "slack:2", "fixCi:1"]);
    expect(names("DONE", rows)).toEqual([]);
  });
});

// W8 sync worktrees: pull remote work down by fast-forwarding each worktree to its upstream.
// Safety is the point — dirty trees and diverged branches are reported and left untouched.
describe("W8 sync-worktrees", () => {
  const gitc = (dir: string, ...args: string[]) => run(["git", "-C", dir, ...args]);
  const commit = async (dir: string, file: string, body: string, msg: string) => {
    await writeFile(join(dir, file), body);
    await gitc(dir, "add", ".");
    await gitc(dir, "commit", "-m", msg);
  };

  test("fast-forwards behind, skips dirty + diverged (never clobbers), reports per-branch", async () => {
    // origin (bare) ← local (working clone with worktrees) ; driver advances origin behind local's back.
    const seed = await makeScratchRepo();
    const origin = await mkdtemp(join(tmpdir(), "orca-origin-"));
    await run(["git", "clone", "--bare", seed, origin]);
    const local = await mkdtemp(join(tmpdir(), "orca-local-"));
    await run(["git", "clone", origin, local]);
    await gitc(local, "config", "user.email", "test@orca.dev");
    await gitc(local, "config", "user.name", "Orca Test");
    const root = join(local, ".worktrees");

    // Three tracked worktrees off origin/main, each pushed so it has an upstream on origin.
    for (const b of ["behind", "dirty", "diverged"]) {
      const wt = join(root, b);
      await gitc(local, "worktree", "add", "-b", b, wt, "origin/main");
      await commit(wt, `${b}.txt`, "base\n", `${b}: base`);
      await gitc(wt, "push", "-u", "origin", b);
    }
    // A branch with no upstream configured (off local HEAD, never pushed) → reported "no upstream".
    await gitc(local, "worktree", "add", "-b", "lonely", join(root, "lonely"));

    // Advance origin's copies of behind + dirty (a clean ff would now be possible for both).
    const driver = await mkdtemp(join(tmpdir(), "orca-driver-"));
    await run(["git", "clone", origin, driver]);
    await gitc(driver, "config", "user.email", "test@orca.dev");
    await gitc(driver, "config", "user.name", "Orca Test");
    for (const b of ["behind", "dirty", "diverged"]) {
      await gitc(driver, "checkout", b);
      await commit(driver, `${b}.txt`, "remote\n", `${b}: remote advance`);
      await gitc(driver, "push", "origin", b);
    }

    // Dirty: an uncommitted local edit that a sync must NOT discard.
    await writeFile(join(root, "dirty", "dirty.txt"), "local uncommitted edit\n");
    // Diverged: a local commit not on origin — origin also moved, so no fast-forward is possible.
    await commit(join(root, "diverged"), "diverged.txt", "local\n", "diverged: local-only");
    const divergedHeadBefore = (await gitc(join(root, "diverged"), "rev-parse", "HEAD")).trim();

    const results = await syncWorktrees(local, root);
    const outcome = (b: string) => results.find((r) => r.branch === b)?.outcome;
    expect(outcome("behind")).toBe("synced");
    expect(outcome("dirty")).toBe("dirty");
    expect(outcome("diverged")).toBe("diverged");
    expect(outcome("lonely")).toBe("no upstream");

    // (a) behind fast-forwarded to origin's tip.
    expect((await readFile(join(root, "behind", "behind.txt"), "utf8"))).toBe("remote\n");
    expect((await gitc(join(root, "behind"), "rev-parse", "HEAD")).trim())
      .toBe((await gitc(join(root, "behind"), "rev-parse", "@{u}")).trim());
    // (b) dirty NOT clobbered: the uncommitted edit survives, HEAD untouched (still on base).
    expect((await readFile(join(root, "dirty", "dirty.txt"), "utf8"))).toBe("local uncommitted edit\n");
    // (c) diverged left untouched: HEAD is still the local-only commit.
    expect((await gitc(join(root, "diverged"), "rev-parse", "HEAD")).trim()).toBe(divergedHeadBefore);

    // A second sync is idempotent: the now-current worktree reports "up to date".
    expect((await syncWorktrees(local, root)).find((r) => r.branch === "behind")?.outcome).toBe("up to date");
  });

  test("summarizeSync rolls per-branch outcomes into a one-line report", () => {
    expect(summarizeSync([])).toBe("no worktrees");
    expect(summarizeSync([
      { branch: "a", outcome: "synced" }, { branch: "b", outcome: "synced" },
      { branch: "c", outcome: "up to date" },
      { branch: "d", outcome: "dirty" }, { branch: "e", outcome: "diverged" }, { branch: "f", outcome: "no upstream" },
    ])).toBe("synced 2, up to date 1, skipped: dirty 1, diverged 1, no upstream 1");
  });
});
