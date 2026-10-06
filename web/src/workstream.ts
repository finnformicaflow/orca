// Pure workstream logic — the state machine and derivations. No React, no I/O,
// so both the store and the e2e tests import it directly.

import type { CiFailureEvidence, CiStatus, ConversationComment, Mergeable, ReviewStatus, ReviewThreadEvidence } from "../../server/gh";
import { OUTCOME_CONTRACT, withOutcomeContract, type AgentOutcome, type AgentProvider, type AgentTurn, type TurnCheck } from "../../shared/agent";
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
export type PrMenuAction = "markReady" | "moveToDraft" | "autoMerge" | "addressPr" | "addPreview" | "copyLink";
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
  // ONE agent verb for a PR: it gathers conflicts, failing CI and the review itself (addressPrPrompt),
  // so the user never has to triage which button a blocked PR needs.
  actions.push("addressPr");
  if (!row.previewUrl) actions.push("addPreview");
  if (row.prUrl) actions.push("copyLink");
  return actions;
}

// Lane-level bulk actions: the same per-card verbs, fired across every card in a swimlane. Which
// verbs a lane offers is fixed (they mirror what that lane's cards can do); WHICH cards each one
// runs on is state-gated exactly like the per-card menu, so a bulk "Fix CI" only touches the cards
// with failing CI and a lane with none doesn't show the item at all.
export type BulkAction =
  | "testLocally" | "promote" | "promoteReady" | "promoteDraft" | "markReady" | "moveToDraft"
  | "resolveConflicts" | "addressPr" | "slackNotify" | "slackBump"
  | "autoMerge" | "disableAutoMerge" | "follow" | "unfollow" | "addPreview"
  | "copyLink" | "merge" | "closePr" | "discard";

export type BulkRow = PrMenuRow & {
  hasRemote?: boolean;
  reviewStatus?: ReviewStatus;
  autoMergeEnabled?: boolean;
  agentStatus?: "idle" | "running" | "done" | "error";
  slackNotifiedAt?: string;
  slackLastBumpedAt?: string;
  following?: boolean;
};

export const BULK_LABELS: Record<BulkAction, string> = {
  testLocally: "Test locally",
  promote: "Promote",
  promoteDraft: "Draft PR",
  promoteReady: "Ready for review",
  markReady: "Mark ready for review",
  moveToDraft: "Move to draft",
  resolveConflicts: "Resolve conflicts",
  addressPr: "Address PR",
  slackNotify: "Send message",
  slackBump: "Send bump",
  autoMerge: "Enable auto-merge",
  disableAutoMerge: "Disable auto-merge",
  follow: "Follow (auto-fix)",
  unfollow: "Unfollow",
  addPreview: "Add preview",
  copyLink: "Copy PR links",
  merge: "Merge",
  closePr: "Close PR",
  discard: "Discard",
};

/** Related verbs collapse into one submenu, so a lane's menu stays short as the verb list grows.
 *  Ungrouped actions render flat at the top level. A lane usually needs both halves of a group
 *  (some PRs never announced, others announced and now stale), which is why they sit side by side. */
export const BULK_GROUPS: Partial<Record<BulkAction, "PR" | "Agent" | "Slack">> = {
  markReady: "PR", moveToDraft: "PR", autoMerge: "PR", disableAutoMerge: "PR",
  follow: "PR", unfollow: "PR", addPreview: "PR", copyLink: "PR",
  resolveConflicts: "Agent", addressPr: "Agent",
  slackNotify: "Slack", slackBump: "Slack",
};

/** Copy verbs are aggregate, not per-card: N clipboard writes would leave only the last one, so the
 *  runner writes one text built from every eligible card instead. */
export const bulkCopyText = (rows: { prUrl?: string }[]) => rows.map((r) => r.prUrl).filter(Boolean).join("\n");

/** Verbs that can't be taken back — the confirm spells that out before a whole lane runs one. */
export const BULK_IRREVERSIBLE: BulkAction[] = ["merge", "closePr", "discard"];

const BULK_LANE_ACTIONS: Partial<Record<string, BulkAction[]>> = {
  LOCAL: ["testLocally", "promote", "promoteDraft", "promoteReady", "resolveConflicts", "discard"],
  DRAFT: ["markReady", "addressPr", "follow", "unfollow", "addPreview", "copyLink", "closePr"],
  IN_REVIEW: ["slackNotify", "slackBump", "markReady", "moveToDraft", "autoMerge", "disableAutoMerge", "follow", "unfollow", "addPreview", "copyLink", "addressPr", "merge", "closePr"],
  MERGEABLE: ["merge", "slackNotify", "slackBump", "autoMerge", "disableAutoMerge", "follow", "unfollow", "addPreview", "copyLink", "addressPr", "closePr"],
  DONE: ["copyLink"], // nothing left to do but grab the links (standup / status posts)
};

const conflicting = (row: BulkRow) => row.mergeable === "CONFLICTING" || row.mergeClean === "conflict";
// Never stack a second agent on a branch that's already running one (the run lease would reject it).
const idle = (row: BulkRow) => row.agentStatus !== "running";

/** Clock + staleness policy for the time-dependent gates (currently the Slack bump). */
export type BulkContext = { nowMs: number; staleHours: number };

const BULK_ELIGIBLE: Record<BulkAction, (row: BulkRow, ctx: BulkContext) => boolean> = {
  testLocally: () => true, // adopts a worktree if the branch lacks one, same as the card button
  promote: (row) => !row.prNumber && !row.hasRemote, // local-only repo: no PR to open, just mark promoted
  promoteDraft: (row) => !row.prNumber && Boolean(row.hasRemote),
  promoteReady: (row) => !row.prNumber && Boolean(row.hasRemote),
  markReady: (row) => Boolean(row.prNumber) && Boolean(row.isDraft),
  moveToDraft: (row) => Boolean(row.prNumber) && !row.isDraft,
  resolveConflicts: (row) => conflicting(row) && idle(row), // LOCAL branches only (a PR's conflicts go through addressPr)
  // Same gate as the per-card menu: any open PR. It covers conflicts, CI and review in one run, and
  // review feedback isn't only "changes requested", so the lane verb can't be narrower than the card's.
  addressPr: (row) => Boolean(row.prNumber) && idle(row),
  follow: (row) => Boolean(row.prNumber) && !row.following,
  unfollow: (row) => Boolean(row.prNumber) && Boolean(row.following),
  addPreview: (row) => Boolean(row.prNumber) && !row.previewUrl,
  copyLink: (row) => Boolean(row.prUrl),
  closePr: (row) => Boolean(row.prNumber),
  discard: (row) => !row.prNumber,
  // Announce the PRs nobody has been told about; bump only the ones already announced AND gone quiet
  // for staleHours — so the two counts partition the lane into "needs telling" vs "needs chasing"
  // and neither re-pings a PR that was just posted.
  slackNotify: (row) => Boolean(row.prNumber) && !row.slackNotifiedAt,
  slackBump: (row, ctx) => Boolean(row.prNumber) && shouldBump(row.slackNotifiedAt, row.slackLastBumpedAt, ctx.nowMs, ctx.staleHours),
  autoMerge: (row) => Boolean(row.prNumber) && !row.isDraft && !row.autoMergeEnabled,
  disableAutoMerge: (row) => Boolean(row.prNumber) && Boolean(row.autoMergeEnabled),
  merge: (row) => !row.isDraft && !conflicting(row) && row.ciStatus !== "failing",
};

/** The lane's bulk menu: each offered action with the cards it would actually run on. Actions with
 *  no eligible card are dropped, so the menu only ever shows work that exists. */
export function bulkActions<R extends BulkRow>(lane: string, rows: R[], ctx: BulkContext): { action: BulkAction; rows: R[] }[] {
  return (BULK_LANE_ACTIONS[lane] ?? [])
    .map((action) => ({ action, rows: rows.filter((row) => BULK_ELIGIBLE[action](row, ctx)) }))
    .filter((group) => group.rows.length > 0);
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

// A headless run narrates almost nothing by default: one real run produced 11 text blocks against 97
// tool calls, so the chat showed a list of commands and nothing about why. Claude's own reasoning is
// unavailable — its thinking blocks arrive encrypted and empty — so the only way to see an approach
// is to ask for it in words. This is that ask, shared by every launch.
const NARRATE = [
  "Narrate your work as you go, because someone reads this conversation afterwards to understand your",
  "approach — not just what you ran:",
  "- Open with your plan in two or three sentences: what you think the task involves, where you expect",
  "  the relevant code to be, and anything you're unsure about.",
  "- Before each significant step, say in a sentence what you're about to do and why.",
  "- When you learn something that changes the plan — the code isn't structured as you assumed, a test",
  "  reveals a different cause — say so, and say what you're doing instead.",
  "Keep it brief and factual. This is a running commentary, not a report; the summary comes at the end.",
].join("\n");

/** Prompt used to launch the headless agent — Orca already created it from the latest base.
 *
 *  Deliberately does NOT assume the request is work to be done. "Investigate why X is slow and report
 *  back" and "add a rate limit to the upload endpoint" arrive through the same box, and forcing the
 *  first into "implement and commit" produced an agent that changed code nobody asked it to change.
 *  The model reads the request instead of a toggle deciding for it — but it must SAY which way it read
 *  it, first, so the decision is visible in seconds and can be corrected with one message rather than
 *  discovered in a diff. */
export function launchPrompt(ws: Pick<Workstream, "title" | "branch" | "prompt">, base = "main"): string {
  return withOutcomeContract([
    promptFor(ws),
    "",
    `This worktree was created from the latest \`${base}\`. Inspect the repository instructions first.`,
    "",
    "First, decide what is being asked of you and say so in one line before anything else:",
    "- A request to build, fix or change something → implement it. Only the requested scope, treating",
    "  any existing changes as user-owned. Verify in proportion to risk, and commit as you go with",
    "  clear messages. No unrelated refactors.",
    "- A request to investigate, research, scope, review or explain → do that and report back. Read",
    "  whatever you need, but do NOT modify, commit or push anything. Findings are the deliverable.",
    "- Genuinely ambiguous → say which reading you're taking and why, then proceed on it. Don't stop to",
    "  ask: nobody is watching yet.",
    "",
    NARRATE,
    NO_PR,
  ].join("\n"));
}

/** Exact provider-neutral Slack message. Copying it never spends another provider's quota. */
export function slackMessage(
  ws: Pick<Workstream, "title" | "prNumber" | "prUrl"> & { previewUrl?: string },
  kind: "notify" | "bump",
): string {
  const link = `[#${ws.prNumber} ${ws.title}](${ws.prUrl ?? ""})`
    + (ws.previewUrl ? ` - [PR Preview](${ws.previewUrl})` : "");
  return kind === "bump" ? `Bump:\n${link}` : link;
}

/** The same linked `#7 Title` message in Slack's native mrkdwn link syntax (`<url|label>`), so an
 *  auto-send via a webhook renders identically to the rich-html copy — a hyperlink, not literal
 *  Markdown. Used only when posting through the API; the clipboard path keeps using slackClipboard. */
export function slackApiText(
  ws: Pick<Workstream, "title" | "prNumber" | "prUrl"> & { previewUrl?: string },
  kind: "notify" | "bump",
): string {
  const label = `#${ws.prNumber} ${ws.title}`;
  const link = (ws.prUrl ? `<${ws.prUrl}|${label}>` : label)
    + (ws.previewUrl ? ` - <${ws.previewUrl}|PR Preview>` : "");
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
  ws: Pick<Workstream, "title" | "prNumber" | "prUrl"> & { previewUrl?: string },
  kind: "notify" | "bump",
): { text: string; html: string } {
  const label = `#${ws.prNumber} ${ws.title}`;
  const url = ws.prUrl ?? "";
  const anchor = (url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label))
    + (ws.previewUrl ? ` - <a href="${escapeHtml(ws.previewUrl)}">PR Preview</a>` : "");
  const plain = (url ? `${label}\n${url}` : label)
    + (ws.previewUrl ? `\nPR Preview: ${ws.previewUrl}` : "");
  return kind === "bump"
    ? { text: `Bump:\n${plain}`, html: `Bump:<br>${anchor}` }
    : { text: plain, html: anchor };
}

/** Legacy instruction form retained for consumers that explicitly want an agent to post it. */
export function slackPrompt(
  ws: Pick<Workstream, "title" | "prNumber" | "prUrl"> & { previewUrl?: string },
  kind: "notify" | "bump",
  channel?: string,
): string {
  const content = slackMessage(ws, kind);
  const where = channel ? ` to the ${channel} channel` : "";
  return `Post a new Slack message${where} with exactly this content and nothing else — no emojis, no extra text, and do not reply in a thread:\n\n${content}`;
}

/** Follow-up instruction for an agent already working a branch (resumes its session). */
export function followUpPrompt(instruction: string): string {
  return withOutcomeContract(`${instruction}\n\nThis is an incremental follow-up. Preserve completed work; files and git are authoritative. Change only what is related to this follow-up.\n${SESSION_START}\nWork autonomously. Verify in proportion to risk, then commit and push your changes.\n${NO_PR}`);
}

// Every session starts with no memory of the last one, so it starts by looking: the same three-line
// ritual Anthropic's long-running-agent harness uses (git log, the progress notes, then one thing).
const SESSION_START = "Before acting: run `git log --oneline -15` and `git status`, and read the prior turns' Remaining and Decisions above. Do one thing at a time.";

/** A message typed in the CHAT, as opposed to a board action.
 *
 *  The distinction matters. A board action (Fix CI, Resolve conflicts, Follow up) is a work order
 *  issued to a background agent: go away, do the thing, commit, report. A chat message is a
 *  conversation — often a question, a second opinion, or thinking out loud — and answering "what do
 *  you think about X?" by silently rewriting six files and pushing is the wrong response to it.
 *
 *  So the agent is told to READ the message for what it is. Discussion gets a discussive answer;
 *  an instruction to change something gets the same autonomous treatment as before, including the
 *  outcome contract, because the card's badges and the PR description are built from it. The
 *  judgement is deliberately left to the model rather than pattern-matched here: "also handle the
 *  empty case" is an instruction and "should we handle the empty case?" is not, and no keyword list
 *  survives contact with that. */
export function chatPrompt(instruction: string): string {
  return [
    instruction,
    "",
    "You are replying in a conversation, not executing a work order. Read the message for what it is:",
    "- A question, or a request for your opinion or a plan → answer it. Be concrete and specific, cite",
    "  the files and lines you're reasoning about, and say what you'd do and why. Do NOT change files.",
    "- Ambiguous, or resting on an assumption you can't verify → ask, or state the assumption and give",
    "  the answer under it. Don't guess and don't start work to find out.",
    "- A clear instruction to change something → do it, autonomously, the way you would any task:",
    "  preserve completed work, change only what's related, verify in proportion to risk, then commit",
    "  and push. Narrate it as you go — say what you're about to do and why before each significant",
    "  step, and say so when something you learn changes the plan.",
    "",
    "Treat the files, git status and commits in this worktree as authoritative — they are the record of",
    "what has actually happened, whatever the conversation above says.",
    SESSION_START,
    NO_PR,
    "",
    "If (and only if) you changed something, finish with the usual sections:",
    OUTCOME_CONTRACT,
  ].join("\n");
}

/** The user's own words out of a built prompt, for DISPLAY only (the chat log).
 *
 *  Every builder above appends its scaffolding AFTER the instruction, so the instruction is the head
 *  of the prompt and the first scaffolding line is where it ends. Stripping at read time (rather than
 *  storing the instruction alongside the prompt) also fixes the turns already recorded. If nothing
 *  matches — an old prompt shape, or a board action that is scaffolding all the way down — the whole
 *  prompt is shown, which is what happened before. */
const SCAFFOLDING = [
  "You are replying in a conversation, not executing a work order.",
  "This is an incremental follow-up.",
  "Investigate and report only.",
  "Attached files (Read these for extra context):",
  "Avoid unrelated cleanup.",
  "Finish your final response with these concise sections:",
  NO_PR,
];
export function promptInstruction(prompt: string): string {
  const cut = SCAFFOLDING.reduce((at, marker) => {
    const i = prompt.indexOf(marker);
    return i > 0 && i < at ? i : at;
  }, prompt.length);
  return prompt.slice(0, cut).trim() || prompt;
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
    "- Be concise: at most 3 sentences or 4 bullets per section, and under 400 words overall. Fewer",
    "  output tokens is also less time spent blocking Promote.",
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

/** Point the agent at pasted/dropped files of any type (absolute paths) for extra context. */
export function withAttachments(prompt: string, paths: string[]): string {
  if (!paths.length) return prompt;
  const list = paths.map((p) => `- ${p}`).join("\n");
  return `${prompt}\n\nAttached files (Read these for extra context):\n${list}`;
}

/** Instruction for Claude to resolve a PR's merge conflicts in its worktree, then push. */
// The three PR blockers as SECTIONS (no intro, no outcome contract), so one composed "Address PR"
// prompt can carry whichever apply, while each standalone builder below keeps its exact old shape.
function conflictLines(branch: string, base: string): string[] {
  return [
    `Branch \`${branch}\` has merge conflicts with \`${base}\`.`,
    `Merge \`origin/${base}\` into it, resolve every conflict preserving both sides' intent,`,
    `then commit and push. (Rebase + \`--force-with-lease\` is fine if cleaner.)`,
  ];
}

/** Instruction for Claude to resolve merge conflicts on a branch (used on its own for a LOCAL branch
 *  with no PR; for a PR it is one section of addressPrPrompt). */
export function resolveConflictsPrompt(ws: Pick<Workstream, "branch">, base: string): string {
  return withOutcomeContract([
    "This is an explicit resolve-conflicts action. Change only what is required to integrate the branches.",
    ...conflictLines(ws.branch, base),
    NO_PR,
  ].join(" "));
}

function ciLines(ws: Pick<Workstream, "prNumber" | "branch">, failingChecks: string[] = [], details: CiFailureEvidence[] = []): string[] {
  const evidence = details.length ? `\n\nOrca collected this bounded CI evidence:\n${details.map((item) => [
    `### ${item.name}${item.status ? ` (${item.status})` : ""}`,
    item.url ? `Link: ${item.url}` : "",
    item.excerpt ? `Failed-step excerpt:\n\`\`\`text\n${item.excerpt}\n\`\`\`` : "Logs are not available through GitHub; use the check link and repository state.",
  ].filter(Boolean).join("\n")).join("\n\n")}` : failingChecks.length ? ` Failing checks reported by Orca: ${failingChecks.join(", ")}.` : "";
  return [
    `CI is failing on PR #${ws.prNumber} (branch \`${ws.branch}\`).${evidence}`,
    `Treat the logs as evidence, confirm the root cause in the repository, and do not blindly modify tests.`,
    `Fix the root cause and run the relevant tests/build locally to confirm,`,
    `then commit and push.`,
  ];
}

/** Instruction for Claude to fix failing CI on a PR in its worktree, then push. */
export function resolveCiPrompt(ws: Pick<Workstream, "prNumber" | "branch">, failingChecks: string[] = [], details: CiFailureEvidence[] = []): string {
  return withOutcomeContract([
    "This is an explicit Fix CI action. Preserve unrelated completed work.",
    ...ciLines(ws, failingChecks, details),
  ].join(" "));
}

// The snapshot Orca passes can be stale or capped, so the agent works from the LIVE thread list and
// verifies it cleared them. It decides and executes every reply/resolve itself — Orca does not post.
const reviewInteraction = (pr: number | undefined): string => [
  "Close the loop on GitHub yourself — a pushed fix with no reply leaves the thread open. Work from the LIVE list of open threads, not just the snapshot above (which may be stale or partial). List every unresolved thread — re-run this any time, including at the end to confirm none remain:",
  `  gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path line comments(last:1){nodes{author{login} body}}}}}}}' -F o="$(gh repo view --json owner --jq .owner.login)" -F n="$(gh repo view --json name --jq .name)" -F p=${pr} --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)|"\\(.id)  \\(.path):\\(.line)  \\(.comments.nodes[-1].author.login): \\(.comments.nodes[-1].body)"'`,
  "Respond to EVERY thread that command lists, one at a time, using its id. Reply on the thread, then resolve it:",
  `  gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' -f t=THREAD_ID -f b="<your reply>"`,
  `  gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t=THREAD_ID`,
  "If the comment is valid, fix it in code first, then reply citing the commit and resolve. If it is NOT relevant or you won't change it, still reply saying why and resolve it — every thread gets a response. Leave a thread unresolved ONLY when you genuinely need the author's input, and even then post your question as a reply. Before finishing, re-run the list command and confirm it prints nothing.",
].join("\n");
const followedReview = (pr: number | undefined): string =>
  `This PR is actively followed, so keep its conversation current, not just its code: read the wider discussion (\`gh pr view ${pr} --comments\`) and reply to any open question or request directed at the author. Reply substantively; don't post redundant status chatter.`;

// Conversation comments have no "resolved" bit and Orca does NOT judge them — QA reports, review
// summaries and a human's question all arrive the same way. The agent decides, per comment, whether
// it needs a change, a reply, or nothing; the only rule is that every one gets an explicit
// disposition, so an item can be declined but never silently dropped.
const commentDispositions = (pr: number | undefined, n: number): string => [
  `Below are the ${n} conversation comment${n === 1 ? "" : "s"} posted since Orca last handed you this PR (not inline threads; everyone but you). They are yours to judge: for each one decide whether it needs a code change, a reply, or nothing. If it does, act on it and reply on the PR (\`gh pr comment ${pr} --body "…"\`); related ones — e.g. successive automated reports where a newer one supersedes the older — can share one consolidated reply.`,
  "Whatever you decide, finish with a `## Comment dispositions` section: one line per comment number — `replied`, `changed` (cite the commit), or `no action` — with a few words of why. Nothing may be dropped silently.",
].join(" ");

function reviewLines(ws: Pick<Workstream, "prNumber" | "branch">, feedback: string[] = [], threads: ReviewThreadEvidence[] = [], followed = false, comments: ConversationComment[] = []): string[] {
  const conversation = comments.length
    ? `\n\n${commentDispositions(ws.prNumber, comments.length)}\n\n${comments.map((c, i) => [
      `### Comment ${i + 1} — ${c.author ?? "someone"} · ${c.createdAt}${c.kind === "review" ? " (review summary)" : ""}`,
      c.body,
      c.url ? `Link: ${c.url}` : "",
    ].filter(Boolean).join("\n")).join("\n\n")}`
    : "";
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
  return [
    `PR #${ws.prNumber} (branch \`${ws.branch}\`) has requested changes or new review comments.`,
    threads.length ? `Address every supplied unresolved thread.` : `Read them (\`gh pr view ${ws.prNumber} --comments\`) and address every point.`,
    `Verify the code around each referenced line because line numbers can drift. Run relevant checks, then commit and push.`,
    reviewInteraction(ws.prNumber),
    followed ? followedReview(ws.prNumber) : "",
    evidence,
    conversation,
  ].filter(Boolean);
}

/** Instruction for Claude to address a PR's requested changes / review comments, reply to and resolve
 *  the threads, then push. `followed` = this is an auto-follow run, so also engage the conversation.
 *  `comments` = new conversation comments since the last hand-over, for the agent to disposition. */
export function addressReviewPrompt(ws: Pick<Workstream, "prNumber" | "branch">, feedback: string[] = [], threads: ReviewThreadEvidence[] = [], followed = false, comments: ConversationComment[] = []): string {
  return withOutcomeContract([
    "This is an explicit Address review action. Preserve unrelated completed work.",
    ...reviewLines(ws, feedback, threads, followed, comments),
  ].join(" "));
}

export type AddressPrParts = {
  base: string;
  conflicting: boolean;
  ci?: { failingChecks?: string[]; details?: CiFailureEvidence[] };
  feedback?: string[];
  threads?: ReviewThreadEvidence[];
  followed?: boolean;
  comments?: ConversationComment[];
};

/** THE PR action: one run that does everything the PR needs — merge conflicts, then failing CI, then
 *  the review (threads + conversation) — in that order, with one outcome contract. Sections that
 *  don't apply are simply absent; the review section is always present because comments can only
 *  be judged by reading them. Replaces the separate Resolve conflicts / Fix CI / Address review
 *  buttons, which asked the user to triage what one engineer would do in a single sitting. */
export function addressPrPrompt(ws: Pick<Workstream, "prNumber" | "branch">, parts: AddressPrParts): string {
  const order = [parts.conflicting ? "merge conflicts" : "", parts.ci ? "failing CI" : "", "the review"].filter(Boolean).join(", then ");
  return withOutcomeContract([
    `This is an explicit Address PR action for PR #${ws.prNumber} (branch \`${ws.branch}\`): get it to a mergeable, reviewed state in ONE pass — ${order} — and preserve unrelated completed work.`,
    ...(parts.conflicting ? ["## Merge conflicts", ...conflictLines(ws.branch, parts.base)] : []),
    ...(parts.ci ? ["## Failing CI", ...ciLines(ws, parts.ci.failingChecks, parts.ci.details)] : []),
    "## Review",
    ...reviewLines(ws, parts.feedback, parts.threads, parts.followed, parts.comments),
    NO_PR,
  ].join(" "));
}

// Active PR following: when a card is "followed", Orca watches its polled status and launches the
// matching agent action itself — the same buttons, fired for you the moment a blocker appears.
export type FollowAction = "addressPr";
export type FollowBlocker = "conflict" | "ci" | "review";

/** Every blocker a followed PR has right now, in the order the run handles them. A draft, pending
 *  CI, or a green/approved PR has none. */
export function followBlockers(
  s: { isDraft?: boolean; mergeable?: Mergeable; ciStatus?: CiStatus; reviewStatus?: ReviewStatus },
): FollowBlocker[] {
  if (s.isDraft) return []; // a draft isn't up for review yet — leave it alone
  const out: FollowBlocker[] = [];
  if (s.mergeable === "CONFLICTING") out.push("conflict");
  if (s.ciStatus === "failing") out.push("ci");
  if (s.reviewStatus === "changes_requested") out.push("review");
  return out;
}

/** The action a followed PR needs right now, or null if there's nothing to do. Priority mirrors what
 *  blocks progress most: a conflict stops any merge, then failing CI, then a reviewer asking for
 *  changes. A draft, pending CI, or a green/approved PR needs no action. */
export function followAction(
  s: { isDraft?: boolean; mergeable?: Mergeable; ciStatus?: CiStatus; reviewStatus?: ReviewStatus },
): FollowAction | null {
  return followBlockers(s).length ? "addressPr" : null; // one run covers every blocker present
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
  const blockers = followBlockers(pr);
  const feedback = pr.externalFeedback ?? 0;
  // The sig names WHICH blockers are present, not just that one is: "conflict fixed, now CI fails"
  // is a new state and must re-fire, even though both are the same addressPr run.
  const sig = `${blockers.length ? blockers.join("+") : "ok"}#${feedback}`;
  if (prevSig === sig) return { action: null, sig };
  const prevFeedback = Number(prevSig?.split("#")[1] ?? 0);
  return { action: blockers.length || feedback > prevFeedback ? "addressPr" : null, sig };
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

/** Slugify a title into a git branch name, namespaced under `orca/`. */
export function slugifyBranch(title: string): string {
  return (
    "orca/" +
    (title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workstream")
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

// ---- the handover ladder (CLAUDE.md) ----

/** A Claude session this full is reset onto the portable transcript rather than resumed. */
export const CONTEXT_RESET_PCT = 80;
// A resumed session the provider can't find — claude "No conversation found…", codex "no rollout
// found…", cursor "session not found". These mean the id points at nothing, so resuming it loops.
const SESSION_MISSING = /no conversation found|no rollout found|session (?:id )?[^\n]*not found|unable to (?:find|resume)/i;

/** Which rung the next run takes: native resume when the same provider's session is healthy, else a
 *  new session seeded with the portable transcript. Pure, so the browser's actions and the bridge's
 *  own verbs (server/verbs.ts) cannot disagree about it. Spread the result into the launch options. */
export function continuation(input: {
  provider: AgentProvider; from?: AgentProvider; sessionId?: string; contextPct?: number; transcript: AgentTurn[];
}): { resume?: string; history?: AgentTurn[]; handoffFrom?: AgentProvider } {
  const { provider, from, sessionId, transcript } = input;
  const contextTooFull = typeof input.contextPct === "number" && input.contextPct >= CONTEXT_RESET_PCT;
  const nativeTurns = sessionId ? transcript.filter((turn) => turn.provider === provider && turn.sessionId === sessionId) : [];
  const repeatedFailures = nativeTurns.slice(-3).length === 3 && nativeTurns.slice(-3).every((turn) => turn.failed);
  // Codex and Cursor report token usage but not their context-window occupancy.
  // Reset only on observable bounded history, never a fabricated percentage.
  const portableReset = provider !== "claude" && (nativeTurns.length >= 12 || repeatedFailures);
  // A resume that reports the session doesn't exist can only keep failing: the id was never a real
  // session (e.g. the first run died before creating it), so every follow-up resuming it re-fails
  // with "No conversation found …" and bricks the card. Detect that SPECIFIC failure on the latest
  // native turn and start fresh, seeded from the transcript + worktree, instead. A plain task failure
  // must still resume (that's what portableReset's 3-strike rule is for) — only a missing session
  // forces the reset. Text match because a turn carries no structured error kind; if a CLI reworded
  // the message the fallback is merely today's behaviour, never something worse.
  const lastNative = nativeTurns.at(-1);
  const sessionMissing = Boolean(lastNative?.failed) && SESSION_MISSING.test(lastNative?.response ?? "");
  if (from === provider && sessionId && !contextTooFull && !portableReset && !sessionMissing) return { resume: sessionId };
  // No transcript (a chat started blank) → a plain first run, not a handoff over nothing.
  return { history: transcript, handoffFrom: transcript.length ? from : undefined };
}

// ---- the orchestrator ----
// One conversation you talk to, which delegates to worker agents (ordinary workstreams) through the
// `orca` CLI and is woken when they finish. It is itself a headless one-shot like every other run:
// its "workstream" is this reserved (repo, branch), which names no git repo.

export const ORCHESTRATOR_REPO = "@orca";
export const ORCHESTRATOR_BRANCH = "orchestrator";

/** What a worker is told. Anthropic's multi-agent research system found a delegated task needs an
 *  objective, an output format and boundaries — a vague brief is where duplicated and missing work
 *  comes from — so `spawn` refuses one without all three. */
export type WorkerBrief = { objective?: string; output?: string; boundaries?: string; context?: string };
export function briefProblems(brief: WorkerBrief): string[] {
  return (["objective", "output", "boundaries"] as const).filter((k) => !brief[k]?.trim()).map((k) => `--${k} is required`);
}
export function workerBrief(brief: WorkerBrief): string {
  return [
    brief.objective!.trim(),
    "", "## Expected output", brief.output!.trim(),
    "", "## Boundaries", brief.boundaries!.trim(),
    ...(brief.context?.trim() ? ["", "## Context", brief.context.trim()] : []),
  ].join("\n");
}

// What a New draft becomes when its model is left to the orchestrator (AUTO_MODEL): a message that
// opens with this marker, which the role text tells it to answer with exactly one spawn.
export const NEW_DRAFT_MARKER = "[new draft]";
export const newDraftMessage = (repo: string, prompt: string): string => `${NEW_DRAFT_MARKER} repo: ${repo}\n\n${prompt}`;

/** Which model a worker should get, cheapest first. Fable is the scarce resource: the orchestrator
 *  is told to reach for it only when a cheaper model has already failed or the work is genuinely
 *  novel. Model ids are the catalog's (shared/models.ts), so a rename there is a rename here. */
export const MODEL_LADDER: { id: string; when: string }[] = [
  { id: "claude-haiku-4-5-20251001", when: "mechanical edits, renames, one-file fixes with a clear spec" },
  { id: "claude-sonnet-5", when: "small, well-specified tasks in a known area" },
  { id: "claude-opus-5-5", when: "most tasks — the DEFAULT: features, bug fixes, refactors, debugging" },
  { id: "claude-fable-5-1", when: "ONLY work that has already defeated Opus, or genuinely novel, ambiguous design work" },
];

/** Why an orchestrator wake died before finishing its turn. `no-reply` is the CLI ending "cleanly"
 *  on its own placeholder instead of an answer. */
export type WakeExit =
  | { kind: "budget"; budgetUsd: number }
  | { kind: "timeout"; minutes: number }
  | { kind: "restart" }
  | { kind: "no-reply" }
  | { kind: "error"; code: number; stderr: string };
/** What the Claude CLI writes as the turn's result when a session ends with no assistant reply. */
export const NO_REPLY_PLACEHOLDER = "No response requested.";
/** The reason as a verb phrase — "Wake stopped: <this>" in the chat, "Your previous wake <this>" in
 *  the next wake's prompt. Pure. */
export function wakeExitReason(exit: WakeExit): string {
  switch (exit.kind) {
    case "budget": return `hit the ${exit.budgetUsd} USD budget cap`;
    case "timeout": return `timed out at ${exit.minutes} minute${exit.minutes === 1 ? "" : "s"}`;
    case "restart": return "was cut off by an Orca restart";
    case "no-reply": return "ended without a reply";
    case "error": return `exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr}` : ""}`;
  }
}
/** The system line a dead wake's turn shows instead of nothing. `dropped` messages have now died
 *  twice and are not retried again. Pure. */
export function wakeStoppedLine(input: { reason: string; toolCalls: number; costUsd?: number; retried: number; dropped: number }): string {
  const spent = input.costUsd === undefined ? "" : ` ($${input.costUsd.toFixed(2)} spent)`;
  return [
    `Wake stopped: ${input.reason} after ${input.toolCalls} tool call${input.toolCalls === 1 ? "" : "s"}${spent}.`,
    ...(input.retried ? ["Re-queued what it was handling; the next wake is told why and finishes the reply."] : []),
    ...(input.dropped ? ["Not retried again: the wake handling this has now died twice. Send it again to retry."] : []),
  ].join("\n");
}
/** A resumed session re-reads its whole history on every wake, so cost per wake grows with it. Says
 *  so once a wake costs half its cap or the context is half full — a hint only, nothing is reset. Pure. */
export function sessionHint(input: { contextPct?: number; lastWakeUsd?: number; budgetUsd?: number }): string | undefined {
  const costly = input.budgetUsd !== undefined && (input.lastWakeUsd ?? 0) >= input.budgetUsd / 2;
  if (!costly && (input.contextPct ?? 0) < 50) return undefined;
  return "Large session: each wake re-reads all of it, so a fresh session would be much cheaper.";
}

// First line of the message that wakes the orchestrator when a worker finishes. Also how a queue of
// pending wakes is told apart from something the user typed (see server/orchestrator.ts).
export const WORKER_EVENT_MARKER = "[worker finished]";
export const isWorkerEvent = (text: string): boolean => text.startsWith(WORKER_EVENT_MARKER);
/** A report that needs the orchestrator now: the run did not end cleanly, or its commit failed
 *  Orca's check. Read off the report text, so a queued one can be judged after the fact. */
export const isWorkerProblem = (text: string): boolean => {
  const [head = "", next = ""] = text.split("\n");
  return !head.endsWith(" — done") || next.startsWith("Orca's check") && next.includes("FAILED");
};
/** Reports that may wait: every part is a clean worker report. */
export const onlyCleanReports = (messages: string[]): boolean =>
  messages.length > 0 && messages.every((m) => isWorkerEvent(m) && !isWorkerProblem(m));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A finished worker run, as the orchestrator hears about it: the condensed outcome (the 1–2k token
 *  summary a sub-agent hands back), Orca's own check verdict, and the run id as a reference to the
 *  full turn — never the transcript itself. */
export function workerEvent(input: {
  repo: string; branch: string; title?: string; runId: string; status: string;
  outcome?: AgentOutcome; response?: string; check?: TurnCheck;
}): string {
  const { outcome: o, check } = input;
  const list = (label: string, items: string[] | undefined) => (items?.length ? [`${label}:`, ...items.map((i) => `- ${i}`)] : []);
  return [
    `${WORKER_EVENT_MARKER} ${input.repo}/${input.branch}${input.title ? ` "${input.title}"` : ""} — ${input.status}`,
    ...(check ? [`Orca's check \`${check.command}\` ${check.ok ? "passed" : `FAILED (exit ${check.exitCode}):\n${clip(check.output, 600)}`}`] : []),
    ...(o ? [`Outcome: ${clip(o.outcome, 1500)}`, ...list("Remaining", o.remaining), ...list("Decisions", o.decisions), ...list("Commits", o.commits)]
      : [`Response: ${clip(input.response ?? "(none)", 1500)}`]),
    `Full turn: orca read --run ${input.runId}`,
  ].join("\n");
}

/** One line of the board as the orchestrator reads it. */
export type BoardRow = {
  repo: string; branch: string; title?: string; worktreePath?: string; agent: string;
  pr?: { number: number; isDraft?: boolean; reviewStatus?: string; ciStatus?: string; mergeable?: string };
  check?: boolean; orchestrated?: boolean; last?: string;
};
export function boardText(rows: BoardRow[]): string {
  if (!rows.length) return "(no workstreams)";
  return rows.map((r) => {
    const pr = r.pr
      ? `PR #${r.pr.number}${r.pr.isDraft ? " draft" : ""}${r.pr.reviewStatus ? ` review:${r.pr.reviewStatus}` : ""}${r.pr.ciStatus ? ` ci:${r.pr.ciStatus}` : ""}${r.pr.mergeable === "CONFLICTING" ? " CONFLICTS" : ""}`
      : "no PR";
    return [
      `${r.repo}/${r.branch}${r.title ? ` "${r.title}"` : ""}`,
      pr, `agent:${r.agent}`,
      ...(r.check === undefined ? [] : [`check:${r.check ? "passed" : "FAILED"}`]),
      ...(r.orchestrated ? ["yours"] : []),
      ...(r.worktreePath ? [r.worktreePath] : []),
      ...(r.last ? [`last: ${clip(r.last.replace(/\s+/g, " "), 160)}`] : []),
    ].join(" | ");
  }).join("\n");
}

const ORCHESTRATOR_ROLE = [
  "You are Orca's orchestrator. The user talks only to you. You get work done by delegating to worker",
  "agents: each is a headless coding agent in its own git worktree, and one branch is one workstream",
  "is one conversation. You never edit a repo's code yourself.",
  "",
  "Your tools are the `orca` command (run it with Bash) and Read/Grep/Glob over the repos, whose",
  "worktree paths are on the board. The `## Access` line of each message says what else you may run.",
  "  orca board                      every workstream: PR state, agent status, Orca's check verdict",
  "  orca spawn --repo <repo> --title \"<2-5 words>\" --model <id> --objective \"…\" --output \"…\" --boundaries \"…\" [--context \"…\"]",
  "  orca send --repo <repo> --branch <branch> [--model <id>] \"<message>\"     continue an existing workstream (--model moves it to another model)",
  "  orca address --repo <repo> --branch <branch>              have its agent fix conflicts, CI and review on its PR",
  "  orca preview --repo <repo> --branch <branch> [--status]   start (or restart) its local preview; --status prints",
  "                                  starting / running + URL / failed, and the tail of each service's log",
  "  orca chats [\"<search terms>\"]   list conversations, or full-text search every past one (merged ones too)",
  "  orca read --chat <id> | --run <runId>                     one conversation's turns, or one full turn",
  "  orca notes                      print your notes",
  "  orca notes set \"<the whole new text>\"",
  "",
  "You are a senior engineer running a team, not a dispatcher following rules. Use your judgement;",
  "the user would rather you decide than ask, and would rather you adapt a plan than protect it.",
  "",
  "What tends to work:",
  "- Answer questions yourself when the board, your notes or past chats hold the answer. Delegate work.",
  "- A workstream is a branch, and a branch is a conversation with an agent that already knows the",
  "  code it touched. When a request changes, extends or corrects work a workstream is doing or has",
  "  done, `orca send` to it — even mid-run (the message is queued and delivered). Spawn a new one",
  "  when the work is independent enough to merge on its own. Two workstreams in the same files will",
  "  conflict; one workstream given a second unrelated task will produce a tangled PR. Weigh those.",
  "- A worker knows only its brief. Say what done looks like, what to leave alone, and what you learned",
  "  from past chats (`orca chats`) that it would otherwise rediscover. Point at files when you know them.",
  "- Delegation is asynchronous: after you spawn or send, end your turn. You are woken at once for a",
  "  problem — a worker that failed, was stopped, or whose commit failed Orca's check — and otherwise",
  "  when the last of your running workers finishes, or when the user next speaks, with every",
  "  `[worker finished]` report since. Between wakes, `orca board` and `orca read` are your check-in;",
  "  use them when a turn needs the current state. Polling or waiting in a turn wastes it.",
  "- When a worker finishes, Orca's check verdict is evidence and the worker's own Verification is a",
  "  claim. Decide what the result deserves: a report to the user, a follow-up, a different model, or",
  "  stopping. Repeating the same failed attempt is the one thing not worth doing; tell the user instead.",
  "- `orca preview` starts a preview and returns; nothing wakes you when it is up. Check `--status`",
  "  when it matters. A code fault in the log goes to the workstream; a machine fault goes to the user.",
  "- You cannot promote, merge or post to Slack. Say when something is ready for the user to do that.",
  "- Your notes are your memory across context resets: keep them current with the plan, the open",
  "  workstreams, decisions and the user's preferences, in roughly 1500 words or fewer.",
  "- Keep replies short and concrete: what you did, what is running, what needs the user.",
].join("\n");

/** The orchestrator's prompt for one wake. The role goes in only when the session starts (or
 *  restarts after a context reset); the notes and a fresh board go in EVERY time, because they are
 *  what makes the session disposable — everything it needs to carry on is outside its context. */
export function orchestratorPrompt(input: { fresh: boolean; notes?: string; board: string; messages: string[]; shell?: boolean; cutOff?: string }): string {
  return [
    ...(input.fresh ? [ORCHESTRATOR_ROLE, ""] : []),
    // Every wake, not just the first: the setting can change under a session that is being resumed.
    "## Access",
    input.shell
      ? "Full shell on this machine. Use it for machine-level work that belongs to no workstream (a missing toolchain version, a preview that won't start, inspecting state). Changes to a repo's code still go to a worker. Ask before anything destructive or hard to undo."
      : "Only the `orca` command and reading files. Any other command is denied: when a fix needs one, give the user the exact command to run.",
    // Every wake too — not just the role text — because a resumed session only ever sees the role
    // once, and the model rule is the one most worth repeating: without it every worker got the
    // config default, which was the biggest model.
    "", "## Models",
    "`spawn` requires --model. Start from Opus; step DOWN to Sonnet for small, clear tasks and UP to Fable only when Opus has failed:",
    ...MODEL_LADDER.map((m) => `  ${m.id}: ${m.when}`),
    "Move a workstream along the ladder with send --model when a run fails, stalls, or turns out smaller than it looked; say which model you chose and why.",
    `A message opening with \`${NEW_DRAFT_MARKER}\` is the user's New-draft box: spawn exactly ONE workstream for it, in the repo it names, with a brief you write from it and a model you choose. Reply with one line: branch and model.`,
    "", "## Your notes", input.notes?.trim() || "(empty)",
    "", "## Board", input.board,
    // The wake before this one died mid-turn: say so, or the user has to ask why it went quiet.
    ...(input.cutOff ? ["", "## Previous wake was cut off", `Your previous wake ${input.cutOff} before it finished its turn, so the user got no reply. What it was handling is under New again. It may already have acted: check the board before you spawn or send (never start the same work twice), then finish the reply.`] : []),
    "", "## New", input.messages.join("\n\n"),
  ].join("\n");
}
