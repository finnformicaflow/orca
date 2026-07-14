// Pure workstream logic — the state machine and derivations. No React, no I/O,
// so both the store and the e2e tests import it directly.

import type { CiFailureEvidence, CiStatus, Mergeable, ReviewStatus, ReviewThreadEvidence } from "../../server/gh";
import { withOutcomeContract, type AgentOutcome } from "../../shared/agent";
export { attachCommand } from "../../shared/agent";

// Kanban lanes are driven by the REVIEW lifecycle only. Conflict / CI / mergeability
// are conditions shown as badges on the card, never lanes — so an approval moves a PR
// straight to MERGEABLE instead of bouncing through IN_REVIEW while GitHub recomputes.
export type WorkstreamState =
  | "DRAFTING"
  | "READY"
  | "IN_REVIEW"
  | "MERGEABLE"
  | "MERGED";

export type Workstream = {
  id: string;
  title: string;
  branch: string;
  worktreePath: string;
  port: number;
  state: WorkstreamState;
  prompt: string;
  agentStatus?: "idle" | "running" | "done" | "error";
  prNumber?: number;
  prUrl?: string;
  ciStatus?: CiStatus;
  reviewStatus?: ReviewStatus;
  mergeable?: Mergeable;
  slackNotifiedAt?: string;
  slackLastBumpedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PrStatusLike = {
  state: string;
  ciStatus: CiStatus;
  reviewStatus: ReviewStatus;
  mergeable: Mergeable;
};

const ciOk = (ci: CiStatus) => ci === "passing" || ci === "none";

/** Can this PR be merged right now? (mergeable + green + approved) */
export function canMerge(s: PrStatusLike): boolean {
  return mergeSafe(s) && s.reviewStatus === "approved";
}

/** Safe to *attempt* a merge: not a known conflict, and CI isn't failing/pending. Only a definitive
 *  `CONFLICTING` blocks — `UNKNOWN` is allowed through, because GitHub computes mergeability lazily
 *  and a fresh poll routinely returns `UNKNOWN` ("not computed yet"), which is NOT a conflict.
 *  Blocking on it wrongly refused genuinely-mergeable PRs ("not mergeable/green"). `gh pr merge` is
 *  the final arbiter — it recomputes and errors clearly if the PR truly can't merge. Approval is
 *  deliberately NOT required here — GitHub branch protection enforces required reviews on its side,
 *  so this lets an owner merge their own PR (which GitHub won't let them self-approve) on an
 *  unprotected repo, while a protected team repo still rejects the unapproved `gh pr merge`. */
export function mergeSafe(s: PrStatusLike): boolean {
  return s.mergeable !== "CONFLICTING" && ciOk(s.ciStatus);
}

/** Map a freshly-polled PR status onto its kanban lane: open (In Review) vs approved (Mergeable). */
export function deriveKanbanState(s: PrStatusLike): WorkstreamState {
  if (s.state === "MERGED") return "MERGED";
  return s.reviewStatus === "approved" ? "MERGEABLE" : "IN_REVIEW"; // conflict/CI/ready show as badges
}

// The "PR" submenu: every action that only makes sense once a branch has an open PR, grouped in one
// place so the top-level menu stays short. Order is stable so the submenu reads the same every time.
export type PrMenuAction = "markReady" | "moveToDraft" | "autoMerge" | "resolveConflicts" | "fixCi" | "addressReview" | "addPreview" | "copyLink";
export type PrMenuRow = {
  prNumber?: number;
  isDraft?: boolean;
  mergeable?: Mergeable;
  mergeClean?: "clean" | "conflict";
  ciStatus?: CiStatus;
  previewUrl?: string;
  prUrl?: string;
};

/** Ordered PR-scoped actions available for a row — the contents of the "PR" submenu. Empty for
 *  a branch with no PR (those live in the top-level menu / Agent submenu instead). */
export function prMenuActions(row: PrMenuRow): PrMenuAction[] {
  if (!row.prNumber) return [];
  const actions: PrMenuAction[] = [row.isDraft ? "markReady" : "moveToDraft"];
  // Auto-merge only applies to a ready PR — GitHub rejects it on a draft. Offer it regardless of
  // current mergeability: the whole point is to queue the merge for once checks/reviews pass.
  if (!row.isDraft) actions.push("autoMerge");
  if (row.mergeable === "CONFLICTING" || row.mergeClean === "conflict") actions.push("resolveConflicts");
  if (row.ciStatus === "failing") actions.push("fixCi");
  actions.push("addressReview");
  if (!row.previewUrl) actions.push("addPreview");
  if (row.prUrl) actions.push("copyLink");
  return actions;
}

/** Pre-PR state: a workstream is READY once its branch has commits. */
export function draftState(commitCount: number): Extract<WorkstreamState, "DRAFTING" | "READY"> {
  return commitCount > 0 ? "READY" : "DRAFTING";
}

/** True once a notified PR's last Slack activity is older than staleHours. */
export function shouldBump(
  notifiedAt: string | undefined,
  lastBumpedAt: string | undefined,
  nowMs: number,
  staleHours: number,
): boolean {
  if (!notifiedAt) return false;
  return nowMs - Date.parse(lastBumpedAt ?? notifiedAt) >= staleHours * 3_600_000;
}

/** Prompt to paste into your own Claude session for this workstream. */
export function promptFor(ws: Pick<Workstream, "title" | "branch" | "prompt">): string {
  return [
    `You are working on branch \`${ws.branch}\`.`,
    `Task: ${ws.title}`,
    "",
    ws.prompt,
  ].join("\n");
}

// Orca owns the create-PR step (the human clicks Promote). Left to itself in bypassPermissions mode
// the agent will sometimes open a ready-for-review PR on its own, which yanks the card into In
// Review — so every launch/follow-up prompt explicitly forbids it.
const NO_PR = "Do NOT open a pull request or run `gh pr create` — stop after committing. Promoting the branch to a PR is handled separately in Orca.";

/** Prompt used to launch the headless agent — Orca already created it from the latest base. */
export function launchPrompt(ws: Pick<Workstream, "title" | "branch" | "prompt">, base = "main"): string {
  return withOutcomeContract([
    promptFor(ws),
    "",
    `This worktree was created from the latest \`${base}\`. Inspect the repository instructions first.`,
    "Implement only the requested scope. Treat any existing changes as user-owned. Verify in proportion to risk.",
    "Work autonomously and commit your changes with clear messages as you go. Do not perform unrelated refactors.",
    NO_PR,
  ].join("\n"));
}

/** Exact provider-neutral Slack message. Copying it never spends another provider's quota. */
export function slackMessage(
  ws: Pick<Workstream, "title" | "prNumber" | "prUrl">,
  kind: "notify" | "bump",
): string {
  const link = `[#${ws.prNumber} ${ws.title}](${ws.prUrl ?? ""})`;
  return kind === "bump" ? `Bump:\n${link}` : link;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Clipboard content for the Slack copy, in two flavours. Slack's composer doesn't parse Markdown on
 *  paste — `[#7 Foo](url)` shows up literally — but it DOES honour a rich `text/html` clipboard
 *  flavour, so an `<a>` pastes as a proper hyperlink with the title as the link text (paste and done,
 *  no Cmd+Shift+F). The `text/plain` fallback is for targets that ignore HTML: the title on one line,
 *  the raw URL on the next (which Slack autolinks anyway). */
export function slackClipboard(
  ws: Pick<Workstream, "title" | "prNumber" | "prUrl">,
  kind: "notify" | "bump",
): { text: string; html: string } {
  const label = `#${ws.prNumber} ${ws.title}`;
  const url = ws.prUrl ?? "";
  const anchor = url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label);
  const plain = url ? `${label}\n${url}` : label;
  return kind === "bump"
    ? { text: `Bump:\n${plain}`, html: `Bump:<br>${anchor}` }
    : { text: plain, html: anchor };
}

/** Legacy instruction form retained for consumers that explicitly want an agent to post it. */
export function slackPrompt(
  ws: Pick<Workstream, "title" | "prNumber" | "prUrl">,
  kind: "notify" | "bump",
  channel?: string,
): string {
  const content = slackMessage(ws, kind);
  const where = channel ? ` to the ${channel} channel` : "";
  return `Post a new Slack message${where} with exactly this content and nothing else — no emojis, no extra text, and do not reply in a thread:\n\n${content}`;
}

/** Follow-up instruction for an agent already working a branch (resumes its session). */
export function followUpPrompt(instruction: string): string {
  return withOutcomeContract(`${instruction}\n\nThis is an incremental follow-up. Preserve completed work; files and git are authoritative. Change only what is related to this follow-up.\nWork autonomously. Verify in proportion to risk, then commit and push your changes.\n${NO_PR}`);
}

/** Explicit read-only action. Orca chooses this builder; natural-language classification never does. */
export function investigateReportPrompt(instruction: string): string {
  return withOutcomeContract(`${instruction}\n\nInvestigate and report only. Treat files and git as authoritative. Do not modify files, commit, or push.`);
}

/** Explicit failed-work continuation with compact prior evidence. */
export function rerunFailedPrompt(input: { original?: string; error?: string; outcome?: AgentOutcome }): string {
  const failedVerification = input.outcome?.verification.filter((v) => /fail|error|non[- ]?zero|did not pass/i.test(v)).slice(0, 5) ?? [];
  const bounded = (value: string) => value.slice(0, 4_000);
  const evidence = [
    input.original ? `Original instruction:\n${bounded(input.original)}` : "",
    input.outcome?.outcome ? `Completed work:\n${bounded(input.outcome.outcome)}` : "",
    input.error ? `Previous error:\n${input.error.slice(0, 1_000)}` : "",
    input.outcome?.remaining.length ? `Unfinished items:\n${input.outcome.remaining.slice(0, 8).map((v) => `- ${v.slice(0, 500)}`).join("\n")}` : "",
    failedVerification.length ? `Previous verification failures:\n${failedVerification.map((v) => `- ${v.slice(0, 500)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return followUpPrompt(["Inspect the current worktree and continue or repair the unfinished task. Continue from current files and commits; do not restart. Do not repeat completed work.", evidence].filter(Boolean).join("\n\n"));
}

/** A sensible default PR description when the repo has no PR template: a "what changed" overview
 *  built from the branch's commit subjects (pass them oldest-first). No commits yet → a minimal
 *  placeholder, so a promoted PR is never blank. */
export function defaultPrBody(commitSubjects: string[]): string {
  const subjects = commitSubjects.map((s) => s.trim()).filter(Boolean);
  if (subjects.length === 0) return "_No commits yet._";
  if (subjects.length === 1) return subjects[0]!; // one commit: its subject is the overview
  return ["## Summary", "", ...subjects.map((s) => `- ${s}`)].join("\n");
}

// Cap the diff we paste into the description prompt so a big branch can't blow the context window;
// the AI still sees the commit subjects + the leading (usually most telling) hunks.
const PR_DIFF_LIMIT = 30_000;

/** Orca's reviewer-oriented fallback when a managed repo has no checked-in PR template. */
export const DEFAULT_PR_TEMPLATE = [
  "## What & Why",
  "",
  "<!-- Explain the user-facing problem, motivation, and who benefits. -->",
  "",
  "## Key Decisions & Trade-offs",
  "",
  "<!-- Explain non-obvious choices, alternatives considered, constraints, and accepted trade-offs. -->",
  "",
  "## How It Works",
  "",
  "<!-- Summarize the technical approach and any API, data-model, or migration changes. -->",
  "",
  "## What Changed",
  "",
  "<!-- Give a file-level summary grouped by area and distinguish core changes from mechanical ones. -->",
  "",
  "## Testing & Verification",
  "",
  "<!-- List commands and manual checks actually run, their results, and relevant untested edges. -->",
  "",
  "## Risks & Follow-ups",
  "",
  "<!-- State risks, migration or rollback concerns, limitations, deferred work, and review hotspots. -->",
].join("\n");

const prHeadings = (template: string): string[] =>
  [...template.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim());

/** A generated body must fill the template exactly, rather than paste empty guidance or a title. */
export function validPrDescription(body: string, template?: string | null): boolean {
  const expected = prHeadings(template?.trim() || DEFAULT_PR_TEMPLATE);
  const actual = prHeadings(body);
  if (!body.trim() || body.includes("<!--") || actual.join("\n") !== expected.join("\n")) return false;
  if (expected.length === 0) return body.trim().length >= 80;
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  return matches.every((match, index) => {
    const start = match.index! + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    return body.slice(start, end).replace(/<!--[^]*?-->/g, "").trim().length > 0;
  });
}

/** Build the instruction handed to the selected implementation agent to write a PR description from the branch's
 *  actual diff — this is what turns a promoted PR from "raw template / commit list" into a filled,
 *  reviewer-ready description. When the repo ships a PR template, every section is filled from the
 *  diff (HTML comments are guidance, not text to keep); otherwise a sensible section set is used.
 *  Breaking changes go at the TOP; secrets are never emitted. The reply is the finished markdown. */
export function prDescriptionPrompt(input: { template?: string | null; diff: string; commits: string[]; task?: string; outcome?: AgentOutcome }): string {
  const commits = input.commits.map((s) => s.trim()).filter(Boolean);
  const diff = input.diff.length > PR_DIFF_LIMIT
    ? `${input.diff.slice(0, PR_DIFF_LIMIT)}\n…(diff truncated)…`
    : input.diff;
  const template = input.template?.trim() || DEFAULT_PR_TEMPLATE;
  const outcome = input.outcome;
  const evidence = outcome ? [
    outcome.outcome ? `Completed work:\n${outcome.outcome}` : "",
    outcome.decisions.length ? `Recorded decisions:\n${outcome.decisions.map((v) => `- ${v}`).join("\n")}` : "",
    outcome.verification.length ? `Verification reported by the implementation agent:\n${outcome.verification.map((v) => `- ${v}`).join("\n")}` : "",
    outcome.remaining.length ? `Known remaining work:\n${outcome.remaining.map((v) => `- ${v}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n") : "";
  return [
    "Write the final pull-request description for the completed branch. You are the implementation",
    "agent for this work, so use the task and decisions already in this conversation as context.",
    "Output ONLY the description as",
    "GitHub-flavored markdown — no preamble, no sign-off, no code fence wrapping the whole thing.",
    "",
    "Use the following template exactly. Keep every level-two heading in the same order, fill every",
    "section, remove all HTML guidance comments, and do not add or rename level-two headings:",
    "",
    template,
    "",
    "Rules:",
    "- Put any breaking change, removed feature, or disabled workflow at the top of What & Why,",
    "  including affected users and the migration or rollback path.",
    "- Describe only code changes. Never include secrets — no credentials, tokens, env vars, or",
    "  internal hostnames.",
    "- Be specific and give a reviewer with no prior context enough information to understand intent.",
    "- Base implementation claims on the final diff. Use only checks actually reported as run.",
    "- Never invent an issue, Slack thread, PRD, user request, test result, or link. If context was not",
    "  supplied, omit the claim or say that no link/context was supplied where the section requires it.",
    input.task?.trim() ? `\nOriginal task:\n${input.task.trim()}` : "",
    evidence ? `\nImplementation outcome:\n${evidence}` : "",
    commits.length ? `\nCommits (oldest first):\n${commits.map((c) => `- ${c}`).join("\n")}` : "",
    "",
    "Diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/** Point the agent at pasted/dropped image files (absolute paths) for extra visual context. */
export function withAttachments(prompt: string, imagePaths: string[]): string {
  if (!imagePaths.length) return prompt;
  const list = imagePaths.map((p) => `- ${p}`).join("\n");
  return `${prompt}\n\nAttached images (Read these files for visual context):\n${list}`;
}

/** Instruction for Claude to resolve a PR's merge conflicts in its worktree, then push. */
export function resolveConflictsPrompt(ws: Pick<Workstream, "branch">, base: string): string {
  return withOutcomeContract([
    "This is an explicit resolve-conflicts action. Change only what is required to integrate the branches.",
    `Branch \`${ws.branch}\` has merge conflicts with \`${base}\`.`,
    `Merge \`origin/${base}\` into it, resolve every conflict preserving both sides' intent,`,
    `then commit and push. (Rebase + \`--force-with-lease\` is fine if cleaner.)`,
    NO_PR,
  ].join(" "));
}

/** Instruction for Claude to fix failing CI on a PR in its worktree, then push. */
export function resolveCiPrompt(ws: Pick<Workstream, "prNumber" | "branch">, failingChecks: string[] = [], details: CiFailureEvidence[] = []): string {
  const evidence = details.length ? `\n\nOrca collected this bounded CI evidence:\n${details.map((item) => [
    `### ${item.name}${item.status ? ` (${item.status})` : ""}`,
    item.url ? `Link: ${item.url}` : "",
    item.excerpt ? `Failed-step excerpt:\n\`\`\`text\n${item.excerpt}\n\`\`\`` : "Logs are not available through GitHub; use the check link and repository state.",
  ].filter(Boolean).join("\n")).join("\n\n")}` : failingChecks.length ? ` Failing checks reported by Orca: ${failingChecks.join(", ")}.` : "";
  return withOutcomeContract([
    "This is an explicit Fix CI action. Preserve unrelated completed work.",
    `CI is failing on PR #${ws.prNumber} (branch \`${ws.branch}\`).${evidence}`,
    `Treat the logs as evidence, confirm the root cause in the repository, and do not blindly modify tests.`,
    `Fix the root cause and run the relevant tests/build locally to confirm,`,
    `then commit and push.`,
  ].join(" "));
}

/** Instruction for Claude to address a PR's requested changes / review comments, then push. */
export function addressReviewPrompt(ws: Pick<Workstream, "prNumber" | "branch">, feedback: string[] = [], threads: ReviewThreadEvidence[] = []): string {
  const evidence = threads.length
    ? `\n\nOrca collected these unresolved inline threads:\n${threads.map((thread) => [
      `### Thread ${thread.id}${thread.alreadyHanded ? " (previously handed; still unresolved)" : ""}`,
      thread.path ? `Location: ${thread.path}${thread.line ? `:${thread.line}` : ""}` : "",
      thread.author ? `Author: ${thread.author}` : "",
      thread.body,
      thread.url ? `Link: ${thread.url}` : "",
    ].filter(Boolean).join("\n")).join("\n\n")}`
    : feedback.length
    ? `\n\nOrca already collected this recent external feedback:\n${feedback.map((item) => `- ${item}`).join("\n")}`
    : "";
  return withOutcomeContract([
    "This is an explicit Address review action. Preserve unrelated completed work.",
    `PR #${ws.prNumber} (branch \`${ws.branch}\`) has requested changes or new review comments.`,
    threads.length ? `Address every supplied unresolved thread.` : `Read them (\`gh pr view ${ws.prNumber} --comments\`) and address every point.`,
    `Verify the code around each referenced line because line numbers can drift. Run relevant checks, then commit and push.`,
    `Report any thread that cannot be resolved and why.${evidence}`,
  ].join(" "));
}

// Active PR following: when a card is "followed", Orca watches its polled status and launches the
// matching agent action itself — the same buttons, fired for you the moment a blocker appears.
export type FollowAction = "resolveConflicts" | "fixCi" | "addressReview";

/** The action a followed PR needs right now, or null if there's nothing to do. Priority mirrors what
 *  blocks progress most: a conflict stops any merge, then failing CI, then a reviewer asking for
 *  changes. A draft, pending CI, or a green/approved PR needs no action. */
export function followAction(
  s: { isDraft?: boolean; mergeable?: Mergeable; ciStatus?: CiStatus; reviewStatus?: ReviewStatus },
): FollowAction | null {
  if (s.isDraft) return null; // a draft isn't up for review yet — leave it alone
  if (s.mergeable === "CONFLICTING") return "resolveConflicts";
  if (s.ciStatus === "failing") return "fixCi";
  if (s.reviewStatus === "changes_requested") return "addressReview";
  return null;
}

/** What a followed PR should do now, plus a signature to remember it by. A blocker (conflict / CI /
 *  formal change request) fires whenever present. Otherwise a rise in `externalFeedback` — a
 *  coworker's new comment or review since we last acted — fires `addressReview`. The signature folds
 *  the blocker state and the feedback count, so:
 *   - nothing changed (same sig) → no action (never re-fires a steady state, incl. across reloads),
 *   - a NEW comment (feedback ↑) → addressReview, once per new comment,
 *   - the agent's own reply/commit (author-authored, so not counted) never re-triggers.
 *  `prevSig` is the last signature acted on (persisted per card); undefined on first follow, where
 *  any existing feedback/blocker is picked up so enabling Follow cleans up an already-commented PR. */
export function followDecision(
  pr: { isDraft?: boolean; mergeable?: Mergeable; ciStatus?: CiStatus; reviewStatus?: ReviewStatus; externalFeedback?: number },
  prevSig?: string,
): { action: FollowAction | null; sig: string } {
  const blocker = followAction(pr);
  const feedback = pr.externalFeedback ?? 0;
  const sig = `${blocker ?? "ok"}#${feedback}`;
  if (prevSig === sig) return { action: null, sig };
  const prevFeedback = Number(prevSig?.split("#")[1] ?? 0);
  return { action: blocker ?? (feedback > prevFeedback ? "addressReview" : null), sig };
}

/** Derive a short human title from text's first non-empty line (no AI): strip markdown,
 *  drop trailing punctuation, truncate on a word boundary, capitalise. Used for both the
 *  provisional title from a prompt and the final title from the agent's response text. */
export function titleFromText(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const cleaned = first
    .replace(/[`*_#>[\]]/g, "")     // strip markdown
    .replace(/^[\w ]{1,24}:\s+/, "") // drop a leading "Task Name:" style label — visible width is scarce
    .replace(/[.!?…:]+$/, "")       // trailing punctuation
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Untitled";
  const truncated = cleaned.length > 60 ? cleaned.slice(0, 60).replace(/\s+\S*$/, "") : cleaned;
  return truncated.charAt(0).toUpperCase() + truncated.slice(1);
}

/** Session title, summarised from the feature prompt (server prefers the selected provider, falls back to
 *  this). Set once at creation and kept — it's what the branch name is derived from. */
export const titleFromPrompt = titleFromText;

// (The model-title parser lives in server/title.ts — it uses zod, kept out of the web bundle.)

/** Slugify a title into a git branch name. */
export function slugifyBranch(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workstream"
  );
}

/** Lowest free port in [min, max] not already used by a workstream. */
export function nextPort(used: number[], range: [number, number]): number {
  for (let p = range[0]; p <= range[1]; p++) if (!used.includes(p)) return p;
  throw new Error(`no free port in ${range[0]}-${range[1]}`);
}

/** Outcome of fast-forwarding one worktree to its upstream (see server/git.ts syncWorktrees). */
export type SyncOutcome = "synced" | "up to date" | "dirty" | "diverged" | "no upstream";
export type SyncResult = { branch: string; outcome: SyncOutcome };

/** One-line summary of a worktree sync: "synced N, up to date M, skipped: dirty X, diverged Y". */
export function summarizeSync(results: SyncResult[]): string {
  if (!results.length) return "no worktrees";
  const n = (o: SyncOutcome) => results.filter((r) => r.outcome === o).length;
  const parts: string[] = [];
  if (n("synced")) parts.push(`synced ${n("synced")}`);
  if (n("up to date")) parts.push(`up to date ${n("up to date")}`);
  const skipped = (["dirty", "diverged", "no upstream"] as const).filter((o) => n(o)).map((o) => `${o} ${n(o)}`);
  if (skipped.length) parts.push(`skipped: ${skipped.join(", ")}`);
  return parts.join(", ");
}
