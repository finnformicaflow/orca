// Pure workstream logic — the state machine and derivations. No React, no I/O,
// so both the store and the e2e tests import it directly.

import type { CiFailureEvidence, CiStatus, ConversationComment, Mergeable, ReviewSignal, ReviewStatus, ReviewThreadEvidence } from "../../server/gh";
import { AUTOFIX_MARKER, OUTCOME_CONTRACT, withOutcomeContract, type AgentOutcome, type AgentProvider, type AgentStep, type AgentTurn, type TurnCheck, type TurnSource } from "../../shared/agent";
import { AUTO_MODEL, MODELS, modelLabel, prettyModel } from "../../shared/models";
import { WRITING_STYLE } from "../../shared/writingStyle";
import { asksForInput } from "../../shared/notifications";
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

/** What the branch's live side says about it, for `mergedPrIsHistory`. `headBehindPr`: a fact only
 *  git can supply (`git.isAncestor`) — true when `head` is an ancestor of, or equal to, the merged
 *  PR's `headSha`, i.e. the worktree simply never fetched the PR's last push. Undefined means the
 *  caller never checked (a pure-web caller with no git), so a differing head still reads as reuse. */
export type BranchActivity = { agentStatus?: string; queued?: number; agentStartedAt?: number; head?: string; headBehindPr?: boolean; openPr?: boolean };

/** Is a merged PR found by head branch only HISTORY for this workstream? GitHub matches PRs by
 *  branch name, and the orchestrator reuses a branch after its PR merged (`orca send` to it: the
 *  worker resets onto the base and starts again) — so the old merged PR must not make the row Done
 *  (hidden under "Not merged") while new work runs. It is history once anything happened since the
 *  merge: a newer open PR for the branch, the agent running or a message queued, a run started after
 *  `mergedAt`, or the worktree's HEAD has commits the PR's last head doesn't (`headBehindPr` is not
 *  true) — a worktree that is merely BEHIND the PR's head (its last push landed from somewhere else
 *  and this worktree never fetched it) is not reuse; it is the same work, just not caught up. With
 *  nothing live behind the branch (no worktree) the merge stands. ONE derivation for the board UI
 *  and `orca board`. Pure. */
export function mergedPrIsHistory(m: { mergedAt?: string; headSha?: string }, w: BranchActivity | undefined): boolean {
  if (!w) return false;
  if (w.openPr || w.agentStatus === "running" || (w.queued ?? 0) > 0) return true;
  const mergedMs = m.mergedAt ? Date.parse(m.mergedAt) : NaN;
  if (w.agentStartedAt && Number.isFinite(mergedMs) && w.agentStartedAt > mergedMs) return true;
  if (!w.head || !m.headSha || w.head === m.headSha) return false;
  return w.headBehindPr !== true;
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
// The box can't afford a browser per worker (an OOM took it down), so the bridge runs ONE capped,
// queued browser (server/screenshot.ts) and this is how a worker reaches it. Shot paths in the reply
// ride into the orchestrator's report (`workerEvent`).
export const SCREENSHOTS = "To see a UI, the ONLY allowed way to take a screenshot is `orca-shot <url> [--viewport 390x844] [--dark] [--wait-for <sel>] [--click <sel>] [--press <key>] [--hover <sel>] [--scroll <y|sel>] [--label before|after]` (it queues on Orca's one memory-capped browser and prints `shot: <path>`; Read the PNG to look at it). `--click` is a real mouse click, so it opens a Radix UI dropdown/menu trigger (those open on pointerdown, not plain `click`); `--press <key>` sends a named key (Enter, Escape, ArrowDown, …), repeatable and ordered with `--click`, for navigating a menu once it's open. Never launch a browser, Playwright or Puppeteer yourself. Screenshots are optional: commit and push your work FIRST, then take one only if it helps; if it times out or the queue is busy, give up and move on rather than retrying. For a UI change, list each before/after `shot: <path>` line in your Verification. To run Orca itself for a screenshot, use `scripts/preview-orca.sh` (a read-only preview bridge) — never start `server/index.ts` or `bun run dev` directly: a full bridge left running from a worktree acts on the shared database with stale code.";

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
    SCREENSHOTS,
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
export function followUpPrompt(instruction: string, opts: { mergeWhenGreen?: boolean } = {}): string {
  const mergeNote = opts.mergeWhenGreen ? "\n\n(This PR is marked merge-when-green: Orca's merge queue holds the mark and waits for this run — and anything queued behind it — to finish, then merges once CI is green on your latest push. Commit and push as usual; no separate merge step needed.)" : "";
  return withOutcomeContract(`${instruction}${mergeNote}\n\nThis is an incremental follow-up. Preserve completed work; files and git are authoritative. Change only what is related to this follow-up.\n${SESSION_START}\nWork autonomously. Verify in proportion to risk, then commit and push your changes.\n${NO_PR}\n${SCREENSHOTS}`);
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
export function chatPrompt(instruction: string, opts: { mergeWhenGreen?: boolean } = {}): string {
  return [
    instruction,
    ...(opts.mergeWhenGreen ? ["", "(This PR is marked merge-when-green: Orca's merge queue holds the mark and waits for this run — and anything queued behind it — to finish, then merges once CI is green on your latest push. Commit and push as usual; no separate merge step needed.)"] : []),
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
    SCREENSHOTS,
    "",
    WRITING_STYLE,
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
  "Finish your final response with these concise sections:", // the contract's first line before STE
  "End your final response with these sections.",
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
    "",
    WRITING_STYLE,
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

export const ATTACHED_FILES_HEADER = "Attached files (Read these for extra context):";

/** Point the agent at pasted/dropped files of any type for extra context: `orca-attachment://`
 *  references (server/attachments.ts turns each into a local path where the run launches), or a
 *  legacy absolute path. */
export function withAttachments(prompt: string, paths: string[]): string {
  if (!paths.length) return prompt;
  const list = paths.map((p) => `- ${p}`).join("\n");
  return `${prompt}\n\n${ATTACHED_FILES_HEADER}\n${list}`;
}

/** One stored attachment a message carried: its id (served at `/api/attachments/<id>`) and name. */
export type AttachmentRef = { id: string; name: string };

/** Every `orca-attachment://<id>/<name>` reference in a text, first occurrence of each id. */
export function attachmentRefs(text: string): AttachmentRef[] {
  const seen = new Map<string, AttachmentRef>();
  for (const m of text.matchAll(/orca-attachment:\/\/([0-9a-f-]{36})(?:\/([\w.-]+))?/g)) {
    if (!seen.has(m[1]!)) seen.set(m[1]!, { id: m[1]!, name: m[2] ?? "file" });
  }
  return [...seen.values()];
}

/** The message as typed: the "Attached files" block `withAttachments` appended is dropped, since the
 *  chat shows those files as chips / thumbnails instead of a list of references. */
export function withoutAttachmentList(text: string): string {
  return text.replace(new RegExp(`\\n*${ATTACHED_FILES_HEADER.replace(/[()]/g, "\\$&")}(?:\\n- [^\\n]*)*`, "g"), "").trimEnd();
}

/** A message, formatted for the composer's Quote action: every line prefixed `> ` (a markdown
 *  blockquote), followed by a blank line so typing continues as ordinary text below it. */
export function quoteMarkdown(text: string): string {
  return `${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
}

/** Append a Quote block after whatever draft is already in the composer, keeping it intact: a
 *  newline separates the two only when the draft doesn't already end in one, so quoting twice in a
 *  row doesn't collapse the blank line between the two blockquotes into one combined quote. */
export function appendQuote(draft: string, quote: string): string {
  if (!draft) return quote;
  return draft.endsWith("\n") ? draft + quote : `${draft}\n${quote}`;
}

function attachmentSection(messages: string[]): string[] {
  const files = attachmentRefs(messages.join("\n"));
  if (!files.length) return [];
  return ["", "## Attachments", "Files attached to the messages above. To give one to a worker, pass `--attach <id>` to orca spawn / orca send (repeatable):",
    ...files.map((f) => `- ${f.id}  ${f.name}`)];
}

export const isImageName = (name: string) => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);

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
  "End with a `## Comment dispositions` section. Write one line for each comment number: `replied`, `changed` (give the commit) or `no action`, and a short reason. Do not skip a comment.",
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

// Changelog-only conflicts. Two branches that each add an entry under the same CHANGELOG heading
// conflict on every merge of the base, and an agent spent a whole run re-merging that one hunk (five
// runs on one branch-demo PR). Orca merges the base itself first: if every conflicted path is a
// changelog, each is resolved by keeping BOTH sides' added lines in order (`git merge-file --union`)
// and pushed — no agent. Anything else aborts the merge and goes to the agent as before.

/** The changelog paths a repo has unless it sets `changelogFiles`. */
export const DEFAULT_CHANGELOG_FILES = ["**/CHANGELOG.md"];

/** A repo-relative glob as a regex: `**\/` any directories (incl. none), `*` within one segment,
 *  `?` one character. Pure, so the browser and tests share it (no Bun.Glob). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (glob.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; }
    else if (glob.startsWith("**", i)) { re += ".*"; i += 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether `path` is a changelog by the repo's patterns. */
export const isChangelogPath = (path: string, patterns: string[] = DEFAULT_CHANGELOG_FILES): boolean =>
  patterns.some((g) => globToRegExp(g).test(path));

/** Whether a merge's conflicted paths can be resolved mechanically: there are some, and every one is
 *  a changelog. */
export const changelogOnlyConflict = (conflicted: string[], patterns?: string[]): boolean =>
  conflicted.length > 0 && conflicted.every((p) => isChangelogPath(p, patterns));

/** What Orca's own merge of the base did. `resolved` (changelog conflicts unioned) and `merged` (it
 *  merged cleanly) both pushed and leave no conflict for an agent; the rest leave the worktree as it
 *  was. */
export type MechanicalMerge = "resolved" | "merged" | "up to date" | "conflict" | "dirty" | "busy" | "push failed";
export const mergeSettled = (m: MechanicalMerge | undefined): boolean => m === "resolved" || m === "merged";

/** Whether Address PR still needs an agent once Orca has settled the conflict itself: only if CI fails
 *  or there is review to answer (threads, conversation, a change request). Asked ONLY after Orca
 *  settled one — a manual Address PR on a quiet PR still runs, as it always did. */
export const addressNeedsAgent = (p: Pick<AddressPrParts, "conflicting" | "ci" | "feedback" | "threads" | "comments">): boolean =>
  p.conflicting || !!p.ci || !!p.feedback?.length || !!p.threads?.length || !!p.comments?.length;

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
    SCREENSHOTS,
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

/** Precedence for a workstream row's displayed title — the ONE place this is decided, so a card
 *  never flips once its PR loads. The workstream's own title (set at spawn, or renamed) always
 *  wins; a PR title stands in only when the branch has none of its own (e.g. a branch created
 *  outside Orca); the branch name is the last resort. The PR's full title is never lost — callers
 *  keep it reachable via the PR number/link, a tooltip, or the PR detail page, which already shows
 *  it in full. */
export function rowTitle(workstreamTitle: string | undefined, prTitle: string | undefined, branch: string): string {
  return workstreamTitle || prTitle || branch;
}

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

/** The chat composer's placeholder — the one place it's built, so a workstream chat, the orchestrator
 *  panel and the orchestrator page can't drift apart. Busy stays short enough for a 390px-wide
 *  composer; idle never names the model, since the model chip already shows it. */
export function chatPlaceholder(running: boolean, repo: string): string {
  if (running) return "Queue a message…";
  return repo === ORCHESTRATOR_REPO ? "Message the orchestrator…" : "Reply…";
}

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
export const newDraftMessage = (repo: string, prompt: string, instance?: string): string =>
  `${NEW_DRAFT_MARKER} repo: ${repo}${instance ? ` on: ${instance}` : ""}\n\n${prompt}`;

/** Where a New-draft-box submission starts (the box no longer offers a picker). A direct launch
 *  (a model chosen) always starts on the instance named "local", when one is configured, else the
 *  repo's own default — moving to cloud afterwards is the card's "Move to" control, not this. Left
 *  to the orchestrator (AUTO_MODEL), placement is untouched: no explicit instance, so `orca spawn`
 *  keeps using the repo's `runsOn` default without `--on`. */
export const draftInstance = (model: string, choices: string[], repoDefault?: string): string | undefined =>
  model === AUTO_MODEL ? undefined : (choices.includes("local") ? "local" : repoDefault);

/** Which model a worker should get, cheapest first. Fable is the scarce resource: the orchestrator
 *  is told to reach for it only when a cheaper model has already failed or the work is genuinely
 *  novel. Model ids are the catalog's (shared/models.ts), so a rename there is a rename here. */
export const MODEL_LADDER: { id: string; when: string }[] = [
  { id: "claude-haiku-4-5-20251001", when: "mechanical edits, renames, one-file fixes with a clear spec" },
  { id: "claude-sonnet-5", when: "small, well-specified tasks in a known area" },
  { id: "claude-opus-5-5", when: "most tasks — the DEFAULT: features, bug fixes, refactors, debugging" },
  { id: "claude-fable-5-1", when: "ONLY work that has already defeated Opus, or genuinely novel, ambiguous design work" },
];

/** Model-ladder automation: a worker that fails — the run errors, or its commit fails Orca's check —
 *  `LADDER_FAILURES` times in a row on the same model gets the next model up for the retry. The
 *  streak lives on the workstream's enrichment (`failStreak`), so a restart doesn't reset it. */
export const LADDER_FAILURES = 2;
export type FailStreak = { model: string; count: number };
/** The next model up the ladder, or undefined at the top or for a model not on it (Codex, Cursor). */
export const nextLadderModel = (model: string): string | undefined => {
  const i = MODEL_LADDER.findIndex((m) => m.id === model);
  return i < 0 ? undefined : MODEL_LADDER[i + 1]?.id;
};
/** The streak after a run on `model`: a failure extends it (or starts one on a new model), a clean
 *  run ends it. A run you stopped is neither — pass the previous streak through instead. */
export function nextFailStreak(prev: FailStreak | undefined, model: string | undefined, failed: boolean): FailStreak | undefined {
  if (!failed || !model) return undefined;
  return { model, count: prev?.model === model ? prev.count + 1 : 1 };
}
/** What the ladder says about a streak: nothing below the threshold or off the ladder; at it, a line
 *  for the worker report — a suggestion, or (the repo's `modelEscalation: "apply"`) the move Orca
 *  made, in `moveTo`. At the top there is nowhere to go, and the line says so. */
export function ladderStep(streak: FailStreak | undefined, mode: "suggest" | "apply", at: { repo: string; branch: string }): { line: string; moveTo?: string } | undefined {
  if (!streak || streak.count < LADDER_FAILURES || !MODEL_LADDER.some((m) => m.id === streak.model)) return undefined;
  const head = `Model ladder: ${streak.count} failures in a row on ${streak.model}`;
  const next = nextLadderModel(streak.model);
  if (!next) return { line: `${head}, the top of the ladder — another attempt is unlikely to differ; tell the user.` };
  if (mode === "apply") return { moveTo: next, line: `${head} — Orca moved this workstream up to ${next}; your retry (orca send) runs on it.` };
  return { line: `${head} — Orca suggests the next model up for the retry: orca send --repo ${at.repo} --branch ${at.branch} --model ${next} "…"` };
}

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
/** Commands that change something — what a wake that died must not repeat. `orca` verbs and the
 *  `gh pr` writes the orchestrator runs with its shell. */
const ACTING_COMMAND = /\b(orca\s+(?:spawn|send|address|archive|move|merge|preview|notes\s+set|post|ask-user|thread\s+link)|gh\s+pr\s+(?:merge|create|ready|close|edit|comment))\b/g;
/** What a wake that was cut off had already done, condensed for the next wake's prompt: each acting
 *  command it ran with the first line of what it printed, then the reply it had started (its text,
 *  tail-clipped). Built from the steps the run recorded as it went, so it survives the process. Empty
 *  when it had done nothing that matters. Pure. */
export function wakeProgress(steps: AgentStep[] | undefined): string {
  if (!steps?.length) return "";
  const results = new Map(steps.filter((s) => s.kind === "result" && s.id).map((s) => [s.id!, s]));
  const actions: string[] = [];
  for (const s of steps) {
    if (s.kind !== "tool" || s.name !== "Bash") continue;
    const command = String(((s.input ?? {}) as { command?: unknown }).command ?? s.detail ?? "");
    const verbs = [...new Set([...command.matchAll(ACTING_COMMAND)].map((m) => m[1]!.replace(/\s+/g, " ")))];
    if (!verbs.length) continue;
    const r = s.id ? results.get(s.id) : undefined;
    const said = r?.output?.trim().split("\n").filter(Boolean).slice(0, 3).join(" / ");
    const outcome = !r ? "no result recorded — it may or may not have happened" : r.isError ? `failed: ${clip(said ?? "", 200)}` : clip(said || "(no output)", 300);
    actions.push(`- ${verbs.join(", ")}: \`${clip(command.replace(/\s+/g, " ").trim(), 240)}\` → ${outcome}`);
  }
  const text = steps.filter((s) => s.kind === "text" && s.text?.trim()).map((s) => s.text!.trim()).join("\n\n");
  return [
    ...(actions.length ? ["What it had already done (do NOT do these again; check the board for their effect):", ...actions] : []),
    ...(text ? [`${actions.length ? "\n" : ""}What it had started to tell the user:`, text.length > 1500 ? `…${text.slice(-1500)}` : text] : []),
  ].join("\n");
}
/** A resumed session re-reads its whole history on every wake, so cost per wake grows with it. Says
 *  so once a wake costs half its cap or the context is half full — a hint only, nothing is reset. Pure. */
export function sessionHint(input: { contextPct?: number; lastWakeUsd?: number; budgetUsd?: number }): string | undefined {
  const costly = input.budgetUsd !== undefined && (input.lastWakeUsd ?? 0) >= input.budgetUsd / 2;
  if (!costly && (input.contextPct ?? 0) < 50) return undefined;
  return "Large session: each wake re-reads all of it, so a fresh session would be much cheaper.";
}
/** The orchestrator header's live line — what it is doing right now: "Idle", or "Working · 1m 12s",
 *  then "2 queued" and "3 workers running" when any. The last wake's cost and the large-session
 *  advice are the tooltip, not the text; `warn` is the small amber dot that says the advice is there. Pure. */
export function orchestratorStatus(input: {
  running: boolean; startedAt?: number; queued?: number; workers: number; lastWakeUsd?: number; hint?: string; now?: number;
}): { text: string; tooltip?: string; warn: boolean } {
  const now = input.now ?? Date.now();
  const state = !input.running ? "Idle" : input.startedAt === undefined ? "Working" : `Working · ${formatDuration(now - input.startedAt)}`;
  const parts = [
    state,
    ...(input.queued ? [`${input.queued} queued`] : []),
    ...(input.workers ? [`${input.workers} worker${input.workers === 1 ? "" : "s"} running`] : []),
  ];
  const tips = [
    ...(input.lastWakeUsd !== undefined ? [`Last wake cost $${input.lastWakeUsd.toFixed(2)}`] : []),
    ...(input.hint ? [input.hint] : []),
  ];
  return { text: parts.join(" · "), tooltip: tips.length ? tips.join("\n") : undefined, warn: Boolean(input.hint) };
}

// First line of the message that wakes the orchestrator when a worker finishes. Also how a queue of
// pending wakes is told apart from something the user typed (see server/orchestrator.ts).
export const WORKER_EVENT_MARKER = "[worker finished]";
export const isWorkerEvent = (text: string): boolean => text.startsWith(WORKER_EVENT_MARKER);
/** A report that needs the orchestrator now: the run did not end cleanly, or its commit failed
 *  Orca's check. Read off the report text, so a queued one can be judged after the fact. */
export const isWorkerProblem = (text: string): boolean => {
  const [head = "", next = ""] = text.split("\n");
  return !(head.endsWith(" — done") || head.endsWith(" — merged")) || next.startsWith("Orca's check") && next.includes("FAILED");
};
/** One wake can carry several messages (sent while it worked, drained together). Joined with a
 *  break line, not a blank line — a message has paragraphs of its own, and with "\n\n" three sends
 *  read back as one message, in the chat and to the model alike. */
export const MESSAGE_BREAK = "\n\n—— next message ——\n\n";
export const joinMessages = (messages: string[]): string => messages.join(MESSAGE_BREAK);
/** A wake's instruction back into its messages. Rows written before the break was used were joined
 *  with "\n\n": those still split there when it separates worker reports (the old reading), and
 *  otherwise read as one message — their boundaries are gone. */
export function splitMessages(instruction: string): string[] {
  if (instruction.includes(MESSAGE_BREAK)) return instruction.split(MESSAGE_BREAK);
  const parts = instruction.split("\n\n");
  return parts.some(isWorkerEvent) ? parts : [instruction];
}
/** Who a wake answers, from the messages it carried: worker reports alone → `agents`; anything you
 *  said (typed, quick-ask, the palette, a toast's Ask, the New-draft box) → `human`. */
export const turnSource = (messages: string[]): TurnSource =>
  messages.length > 0 && messages.every(isWorkerEvent) ? "agents" : "human";
/** Reports that may wait: every part is a clean worker report. */
export const onlyCleanReports = (messages: string[]): boolean =>
  messages.length > 0 && messages.every((m) => isWorkerEvent(m) && !isWorkerProblem(m));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The `orca-shot` PNGs a worker's reply names, each with its line's label (`before`, `after`) —
 *  how before/after shots ride a worker report without the transcript. Pure. */
export function reportedShots(text: string): string[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(/\/\S*\/shots\/(shot-[\w-]+)\.png/g)) {
    if (seen.has(m[0])) continue;
    const label = m[1]!.match(/-(before|after|[a-z]+)$/i)?.[1];
    seen.set(m[0], label && !/^[0-9a-f]{8}$/i.test(label) ? `${label}: ${m[0]}` : m[0]);
  }
  return [...seen.values()].slice(0, 8);
}

/** One `orca-shot` PNG a reply names: its id (`/api/screenshots/<id>` serves it), the path the
 *  worker printed, the `--label` kept in its file name and when it was taken (also in the name). */
export type ShotRef = { id: string; path: string; label?: string; at?: number };
const SHOT_ID = /^shot-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-[0-9a-f]{8}(?:-(.+))?$/i;
/** Every shot path in `text`, in order, each once. Pure. */
export function shotRefs(text: string): ShotRef[] {
  const out = new Map<string, ShotRef>();
  for (const m of text.matchAll(/\/\S*\/shots\/(shot-[\w-]+)\.png/g)) {
    const id = m[1]!;
    if (out.has(id)) continue;
    const parts = id.match(SHOT_ID);
    const iso = parts?.[1]?.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");
    const at = iso ? Date.parse(iso) : NaN;
    out.set(id, { id, path: m[0], ...(parts?.[2] ? { label: parts[2] } : {}), ...(Number.isFinite(at) ? { at } : {}) });
  }
  return [...out.values()];
}
export const shotUrl = (id: string) => `/api/screenshots/${id}`;

/** The shots one turn reported. */
export type TurnShots = { runId: string; at?: number; shots: ShotRef[] };
/** Every screenshot a workstream's turns reported — its reply and its Verification section —
 *  grouped by turn, newest turn first and newest shot first within one; a shot named again by a
 *  later turn counts there only. Pure: the agent page's Screenshots and the PR's both read this. */
export function workstreamShots(turns: Pick<AgentTurn, "id" | "response" | "structured" | "startedAt" | "finishedAt">[]): TurnShots[] {
  const seen = new Set<string>();
  const out: TurnShots[] = [];
  for (const t of [...turns].reverse()) {
    const shots = shotRefs([t.response ?? "", ...(t.structured?.verification ?? [])].join("\n"))
      .filter((s) => !seen.has(s.id) && seen.add(s.id))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    if (shots.length) out.push({ runId: t.id, at: t.finishedAt ?? t.startedAt, shots });
  }
  return out;
}

/** A worker report's body with its `Screenshots (Read to view):` list taken out, and the shots it
 *  named — so the chat draws them as thumbnails rather than paths. Pure. */
export function reportShots(body: string): { text: string; shots: ShotRef[] } {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^Screenshots \(Read to view\):\s*$/.test(l));
  if (start < 0) return { text: body, shots: [] };
  let end = start + 1;
  while (end < lines.length && /^- /.test(lines[end]!)) end++;
  return { text: [...lines.slice(0, start), ...lines.slice(end)].join("\n"), shots: shotRefs(lines.slice(start + 1, end).join("\n")) };
}

// ---- screenshots in a PR's description (server/prShots.ts) ----

/** How many of a workstream's newest shots its PR shows. */
export const PR_SHOTS_MAX = 6;
const SHOTS_HEADING = /^## Screenshots[ \t]*\r?$/m;
const SHOTS_MARKER = /<!-- orca:screenshots ([\w,-]*) -->/;
/** The ref the images are pushed to, in the PR's own repo: `pr-assets/<pr>-<slug of the branch>`. */
export function prAssetsRef(pr: number, branch: string): string {
  const slug = (branch.split("/").at(-1) ?? branch).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `pr-assets/${pr}${slug ? `-${slug}` : ""}`;
}
/** The `## Screenshots` section for these hosted images (newest first). The marker names the shot
 *  ids, so a later update can tell nothing changed. Empty when there are none. Pure. */
export function screenshotsSection(images: { id: string; url: string; alt: string }[]): string {
  if (!images.length) return "";
  return ["## Screenshots", "", `<!-- orca:screenshots ${images.map((i) => i.id).join(",")} -->`,
    ...images.map((i) => `![${i.alt.replace(/[[\]]/g, "")}](${i.url})`)].join("\n");
}
/** The shot ids a body's Screenshots section was made from (its marker), or [] without one. */
export function prShotIds(body: string): string[] {
  const at = body.search(SHOTS_HEADING);
  return at < 0 ? [] : (body.slice(at).match(SHOTS_MARKER)?.[1] ?? "").split(",").filter(Boolean);
}
/** `body` with its `## Screenshots` section — from that heading to the next `## ` heading or the
 *  end — replaced by `section`, appended when there was none, removed when `section` is empty.
 *  Everything else is left exactly as it was, so applying it twice is applying it once. Pure. */
export function withScreenshotsSection(body: string, section: string): string {
  const at = body.search(SHOTS_HEADING);
  if (at < 0) return section ? `${body.replace(/\s+$/, "")}${body.trim() ? "\n\n" : ""}${section}\n` : body;
  const rest = body.slice(at).slice(1).search(/^## /m);
  const before = body.slice(0, at), after = rest < 0 ? "" : body.slice(at + 1 + rest);
  if (!section) return after ? `${before}${after}` : `${before.replace(/\s+$/, "")}\n`;
  return `${before}${section}\n${after ? `\n${after}` : ""}`;
}

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
    ...list("Screenshots (Read to view)", reportedShots([input.response ?? "", ...(o?.verification ?? [])].join("\n"))),
    `Full turn: orca read --run ${input.runId}`,
  ].join("\n");
}

// ---- merge queue (server/mergeQueue.ts): merge-when-green, decided here ----

/** A repo's merge policy (`mergePolicy` in its config). Absent = nothing is merged on its own. */
export type MergePolicy = {
  /** Which PRs may be marked merge-when-green: `never` (the default), `small` (only ones marked
   *  small — `orca merge --small`), or `any`. */
  whenGreen?: "never" | "small" | "any";
  /** Paths never merged on their own, whatever the mark: globs (`*` within a segment, `**` across),
   *  a trailing `/` or a bare directory covering everything under it. E.g. `server/db.ts` (Orca's
   *  migrations), `server/cgroup.ts`, `deploy/`. */
  denyPaths?: string[];
  /** Open a PR for an orchestrated worker's branch when its run finishes clean (title from the
   *  workstream, body from its outcome), so the orchestrator never opens one by hand. */
  autoPr?: boolean;
};
export const MERGE_WHEN_GREEN = ["never", "small", "any"] as const;

/** Does `path` match one deny glob? Pure. */
export function pathMatches(path: string, glob: string): boolean {
  const g = glob.trim().replace(/^\.?\//, "");
  if (!g) return false;
  if (g.endsWith("/")) return path.startsWith(g);
  if (!/[*?]/.test(g)) return path === g || path.startsWith(`${g}/`);
  const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}
/** The changed paths a policy's denylist catches. Pure. */
export const deniedPaths = (files: string[], globs: string[] | undefined): string[] =>
  files.filter((f) => (globs ?? []).some((g) => pathMatches(f, g)));

/** A PR marked merge-when-green, as stored on its branch's enrichment (`mergeWhenGreen`). */
export type MergeMark = {
  pr?: number; // absent until the branch has a PR (marked before the worker finished)
  small?: boolean; by?: "orchestrator" | "user"; at: number;
  /** The head commit a red/conflict was last reported for — once per push, not once per poll. */
  reportedSha?: string;
};
/** What the queue reads about the PR (gh.prMergeGate's shape, minus what it doesn't need). */
export type MergeGateLike = {
  state: string; isDraft?: boolean; mergeable: string; ciStatus: string;
  files: string[]; changedFiles: number; failingChecks?: string[];
};
export type MergeVerdict =
  | { action: "merge" }
  | { action: "wait"; why: string }
  | { action: "red"; why: string } // keep the mark: it merges once fixed and green
  | { action: "refuse"; why: string } // drop the mark: the policy says a person merges this
  | { action: "gone"; why: string };

/** Why the policy refuses to merge this PR on its own, or undefined when it may. The files are
 *  re-read on every poll, since a push can add a denied path after the mark. Pure. */
export function mergeRefusal(policy: MergePolicy | undefined, mark: Pick<MergeMark, "small">, pr?: Pick<MergeGateLike, "files" | "changedFiles">): string | undefined {
  const when = policy?.whenGreen ?? "never";
  if (when === "never") return "this repo's mergePolicy.whenGreen is \"never\": merging is the user's";
  if (when === "small" && !mark.small) return "this repo only merges PRs marked small on green (--small); merging this one is the user's";
  if (!pr) return undefined;
  const denied = deniedPaths(pr.files, policy?.denyPaths);
  if (denied.length) return `it touches ${denied.slice(0, 5).join(", ")}${denied.length > 5 ? ` and ${denied.length - 5} more` : ""}, which this repo never merges on its own (mergePolicy.denyPaths)`;
  if (policy?.denyPaths?.length && pr.changedFiles > pr.files.length) return `it changes ${pr.changedFiles} files, more than GitHub lists, so the denylist can't be checked`;
  return undefined;
}

/** Whether a marked PR's workstream currently has agent activity the queue must wait out: its agent
 *  is mid-turn, or a message is queued behind it (about to be delivered and change the branch).
 *  Merging under either would strand that work on an already-merged branch. */
export type AgentActivity = { running: boolean; queued: number };

/** The merge queue's one decision for a marked PR. Never merges red; merges only when every check
 *  passed (no checks yet is not green — a fresh push has none) and GitHub says it merges clean. A
 *  busy agent (running, or a message queued for it) holds it at "wait" even when already green —
 *  the policy/gone checks still run, since those don't depend on the agent finishing. Pure. */
export function mergeVerdict(policy: MergePolicy | undefined, mark: Pick<MergeMark, "small">, pr: MergeGateLike, activity?: AgentActivity): MergeVerdict {
  if (pr.state !== "OPEN") return { action: "gone", why: `the PR is ${pr.state.toLowerCase()}` };
  const refused = mergeRefusal(policy, mark, pr);
  if (refused) return { action: "refuse", why: refused };
  if (activity?.running) return { action: "wait", why: "waiting for agent to finish" };
  if (activity && activity.queued > 0) return { action: "wait", why: `waiting for agent to finish (${activity.queued} message${activity.queued === 1 ? "" : "s"} queued)` };
  if (pr.ciStatus === "failing") return { action: "red", why: `CI failing${pr.failingChecks?.length ? `: ${pr.failingChecks.join(", ")}` : ""}` };
  if (pr.mergeable === "CONFLICTING") return { action: "red", why: "merge conflicts with its base" };
  if (pr.ciStatus !== "passing") return { action: "wait", why: pr.ciStatus === "none" ? "no checks reported yet" : "checks still running" };
  if (pr.mergeable !== "MERGEABLE") return { action: "wait", why: "GitHub is still computing mergeability" };
  return { action: "merge" };
}

/** The report the orchestrator hears from the queue — a worker-report line, so the chat and the
 *  batching rules treat it like one: `— merged` is clean, `— merge blocked: …` wakes it. Pure. */
export function mergeQueueReport(input: { repo: string; branch: string; title?: string; pr: number; verdict: MergeVerdict; url?: string }): string {
  const head = `${WORKER_EVENT_MARKER} ${input.repo}/${input.branch}${input.title ? ` "${input.title}"` : ""}`;
  const v = input.verdict;
  if (v.action === "merge") return [`${head} — merged`, `Merge queue: squash-merged PR #${input.pr} on green.${input.url ? ` ${input.url}` : ""}`].join("\n");
  if (v.action === "red") return [`${head} — merge blocked: ${v.why} (PR #${input.pr})`, `Merge queue: still marked merge-when-green; it merges itself once this is fixed and green. To fix it: orca address --repo ${input.repo} --branch ${input.branch}`].join("\n");
  return [`${head} — merge refused: ${v.why} (PR #${input.pr})`, "Merge queue: unmarked. Say it is ready for the user to merge."].join("\n");
}

// ---- automatic PR upkeep (server/upkeep.ts): Address PR without anyone pressing it ----

/** What makes an open PR need an agent: conflicts with its base, a required check failed on its
 *  head, or actionable review threads no agent has been handed yet. */
export type UpkeepReason = "conflicts" | "ci" | "review";
const UPKEEP_REASON_LABEL: Record<UpkeepReason, string> = { conflicts: "conflicts", ci: "CI", review: "review" };
/** The last automatic attempt, on the branch's enrichment (`upkeep`) — shared and restart-proof. */
export type UpkeepRecord = {
  /** The head commit the attempts below were made on. */
  sha: string;
  /** Reasons already addressed on this head — one automatic address per (head, reason). */
  tried: UpkeepReason[];
  /** What the latest attempt addressed — the card's "auto-addressing: …". */
  reasons: UpkeepReason[];
  /** Automatic addresses launched on this head. */
  attempts: number;
  /** Consecutive automatic addresses (across heads) without the PR seen healthy in between. */
  streak: number;
  at: number;
  /** Set once it gave up on this head (and the user was told). */
  gaveUp?: string;
};
/** At most two automatic attempts on one head; a third would be a loop. */
export const UPKEEP_MAX_ATTEMPTS_PER_HEAD = 2;
/** Each address pushes a new head, so a PR that keeps going red on every fix could loop across heads:
 *  this many automatic addresses in a row with no healthy look in between is the end of it too. */
export const UPKEEP_MAX_STREAK = 4;
/** Concurrent automatic address runs on one instance, unless the app config says otherwise. */
export const UPKEEP_DEFAULT_CONCURRENCY = 2;

export type UpkeepInput = {
  pr: { state: string; isDraft?: boolean; mergeable: string; ciStatus: string; head?: string };
  orchestrated: boolean;
  /** The repo's `autoUpkeep: false`, or the branch's own `upkeepOff`. */
  optedOut: boolean;
  /** The orchestrator's `orca status --waiting` for it. */
  waitingOn?: string;
  activity: AgentActivity;
  /** Actionable unresolved review threads not yet handed to an agent (undefined: not fetched). */
  unresolved?: number;
  last?: UpkeepRecord;
  /** Automatic address runs going on this instance right now, and the cap. */
  active: number; cap: number;
};
export type UpkeepDecision =
  | { action: "address"; reasons: UpkeepReason[]; record: UpkeepRecord }
  | { action: "give_up"; reasons: UpkeepReason[]; why: string; record: UpkeepRecord }
  | { action: "healthy" } // nothing to do: the caller clears a stale record
  | { action: "skip"; why: string };

/** Waiting on the user (rather than on CI or a teammate): the orchestrator's status says so. */
export const waitingOnUser = (waitingOn: string | undefined): boolean =>
  Boolean(waitingOn && /\b(user|finn|you|human|me|input|answer|decision)\b/i.test(waitingOn));

/** Which upkeep triggers a PR has right now. Pure. */
export function upkeepReasons(pr: UpkeepInput["pr"], unresolved: number | undefined): UpkeepReason[] {
  const out: UpkeepReason[] = [];
  if (pr.mergeable === "CONFLICTING") out.push("conflicts");
  if (pr.ciStatus === "failing") out.push("ci");
  if ((unresolved ?? 0) > 0) out.push("review");
  return out;
}

/** The upkeep loop's one decision for an open PR: address it, give up on it (tell the user), or
 *  leave it — with the reason. The guards come first, so a busy, opted-out or waiting workstream is
 *  never touched; then the dedup per (head, reason), the per-head and cross-head backoff, and last
 *  the concurrency cap (giving up costs nothing, so the cap never delays that). Pure. */
export function upkeepDecision(input: UpkeepInput, now: number): UpkeepDecision {
  const { pr, last } = input;
  if (pr.state !== "OPEN") return { action: "skip", why: `the PR is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { action: "skip", why: "draft PR" };
  if (!input.orchestrated) return { action: "skip", why: "not an orchestrated workstream" };
  if (input.optedOut) return { action: "skip", why: "opted out of auto-upkeep" };
  if (waitingOnUser(input.waitingOn)) return { action: "skip", why: `waiting on the user (${input.waitingOn})` };
  if (!pr.head) return { action: "skip", why: "head commit unknown" };
  if (last?.gaveUp && last.sha === pr.head) return { action: "skip", why: `gave up on this head: ${last.gaveUp}` };
  if (input.activity.running) return { action: "skip", why: "agent running" };
  if (input.activity.queued > 0) return { action: "skip", why: "messages queued for the agent" };
  const reasons = upkeepReasons(pr, input.unresolved);
  if (!reasons.length) {
    // Healthy only once settled: CI still running on a fresh push (or not yet reported, after a CI
    // fix) is not, or a fix that goes red on every push would reset the streak and loop.
    const ciSettled = pr.ciStatus === "passing" || (pr.ciStatus === "none" && !last?.tried.includes("ci"));
    return ciSettled && pr.mergeable === "MERGEABLE" ? { action: "healthy" } : { action: "skip", why: "waiting for CI / mergeability to settle" };
  }
  const sameHead = last?.sha === pr.head;
  const fresh = sameHead ? reasons.filter((r) => !last!.tried.includes(r)) : reasons;
  const label = upkeepReasonText(reasons);
  const giveUp = (why: string): UpkeepDecision => ({ action: "give_up", reasons, why, record: { tried: sameHead ? last!.tried : [], reasons: [], attempts: sameHead ? last!.attempts : 0, streak: last?.streak ?? 0, sha: pr.head!, at: now, gaveUp: why } });
  if (sameHead && last!.attempts >= UPKEEP_MAX_ATTEMPTS_PER_HEAD) return giveUp(`${label} still there after ${last!.attempts} automatic addresses on this commit`);
  if (sameHead && !fresh.length) return giveUp(`${label} still there after an automatic address on this commit`);
  if ((last?.streak ?? 0) >= UPKEEP_MAX_STREAK) return giveUp(`${label} after ${last!.streak} automatic addresses in a row`);
  if (input.active >= input.cap) return { action: "skip", why: `at the concurrency cap (${input.active}/${input.cap} automatic addresses running)` };
  return {
    action: "address", reasons: fresh,
    record: { sha: pr.head, tried: sameHead ? [...last!.tried, ...fresh] : fresh, reasons: fresh, attempts: sameHead ? last!.attempts + 1 : 1, streak: (last?.streak ?? 0) + 1, at: now },
  };
}

/** "conflicts, CI" — the reasons as the card and the notification say them. */
export const upkeepReasonText = (reasons: UpkeepReason[]): string => reasons.map((r) => UPKEEP_REASON_LABEL[r]).join(", ");

/** The card's line for the upkeep record: what it is auto-addressing while that run goes, or that it
 *  gave up. Nothing once the run is over and it has not given up. Pure. */
export function upkeepLabel(rec: UpkeepRecord | undefined, running: boolean): string | undefined {
  if (!rec) return undefined;
  if (rec.gaveUp) return `auto-upkeep gave up: ${rec.gaveUp}`;
  if (running && rec.reasons?.length) return `auto-addressing: ${upkeepReasonText(rec.reasons)}`;
  return undefined;
}

/** The body Orca opens a finished worker's PR with: its outcome, decisions and verification, then
 *  the commits — what a reviewer needs, from what the worker already reported. Pure. */
export function workerPrBody(input: { outcome?: AgentOutcome; response?: string; commits: string[] }): string {
  const o = input.outcome;
  const list = (label: string, items: string[] | undefined) => (items?.length ? [`## ${label}`, ...items.map((i) => `- ${i}`), ""] : []);
  return [
    ...(o?.outcome ? ["## Outcome", o.outcome.trim(), ""] : input.response?.trim() ? ["## Summary", clip(input.response.trim(), 4000), ""] : []),
    ...list("Decisions", o?.decisions), ...list("Verification", o?.verification), ...list("Remaining", o?.remaining),
    ...list("Commits", input.commits),
    "Opened by Orca when the workstream's agent finished.",
  ].join("\n");
}

/** The orchestrator's own short record of a workstream (`orca status`), stored on its enrichment as
 *  `orchStatus` and shown on the board: its plan for it, what it is waiting on, and its merge class —
 *  `small` (fine to merge on green) or `needs-finn` (the user merges). Per workstream, so the
 *  orchestrator's free-text notes are left holding only preferences and standing facts. */
export const MERGE_CLASSES = ["small", "needs-finn"] as const;
export type MergeClass = (typeof MERGE_CLASSES)[number];
export type OrchStatus = { plan?: string; waitingOn?: string; mergeClass?: MergeClass; at?: string };
export const ORCH_STATUS_MAX = 300; // per field: a status line, not a second notes blob
const ORCH_STATUS_FLAGS = { plan: "plan", waiting: "waitingOn", merge: "mergeClass" } as const;

/** `orca status`'s flags applied to the current record: a flag sets its field, an empty one clears
 *  it, `clear` drops them all. Returns the new record (null when nothing is left), or undefined when
 *  no flag was given — a read. Throws with a message the model can act on. */
export function orchStatusUpdate(prev: OrchStatus | undefined, args: Record<string, unknown>, now: string): OrchStatus | null | undefined {
  if ("clear" in args) return null;
  const given = Object.keys(ORCH_STATUS_FLAGS).filter((f) => f in args) as (keyof typeof ORCH_STATUS_FLAGS)[];
  if (!given.length) return undefined;
  const next: OrchStatus = { ...prev };
  for (const flag of given) {
    const value = String(args[flag] ?? "").replace(/\s+/g, " ").trim();
    if (value.length > ORCH_STATUS_MAX) throw new Error(`--${flag} is limited to ${ORCH_STATUS_MAX} characters (got ${value.length}); keep the detail in the brief or your notes`);
    if (flag === "merge" && value && !(MERGE_CLASSES as readonly string[]).includes(value)) throw new Error(`--merge must be one of: ${MERGE_CLASSES.join(", ")}`);
    const field = ORCH_STATUS_FLAGS[flag];
    if (value) (next as Record<string, string>)[field] = value; else delete next[field];
  }
  delete next.at;
  return Object.keys(next).length ? { ...next, at: now } : null;
}

/** The record as one line — the board's `status:` and `orca status`'s answer. */
export function orchStatusText(s: OrchStatus | undefined): string {
  if (!s) return "";
  return [
    s.plan && `plan: ${s.plan}`,
    s.waitingOn && `waiting on: ${s.waitingOn}`,
    s.mergeClass && `merge: ${s.mergeClass}`,
  ].filter(Boolean).join("; ");
}

/** One line of the board as the orchestrator reads it. */
export type BoardRow = {
  repo: string; branch: string; title?: string; worktreePath?: string; agent: string;
  pr?: { number: number; isDraft?: boolean; reviewStatus?: string; ciStatus?: string; mergeable?: string; merged?: boolean };
  check?: boolean; orchestrated?: boolean; last?: string;
  /** The instance holding its worktree, when there is more than one instance. */
  instance?: string;
  /** Its `orca status` record. */
  status?: OrchStatus;
};
export function boardText(rows: BoardRow[]): string {
  if (!rows.length) return "(no workstreams)";
  return rows.map((r) => {
    const pr = r.pr
      ? r.pr.merged ? `PR #${r.pr.number} merged` : `PR #${r.pr.number}${r.pr.isDraft ? " draft" : ""}${r.pr.reviewStatus ? ` review:${r.pr.reviewStatus}` : ""}${r.pr.ciStatus ? ` ci:${r.pr.ciStatus}` : ""}${r.pr.mergeable === "CONFLICTING" ? " CONFLICTS" : ""}`
      : "no PR";
    return [
      `${r.repo}/${r.branch}${r.title ? ` "${r.title}"` : ""}`,
      pr, `agent:${r.agent}`,
      ...(r.instance ? [`on:${r.instance}`] : []),
      ...(r.check === undefined ? [] : [`check:${r.check ? "passed" : "FAILED"}`]),
      ...(r.orchestrated ? ["yours"] : []),
      ...(r.worktreePath ? [r.worktreePath] : []),
      ...(r.status && orchStatusText(r.status) ? [`status: ${orchStatusText(r.status)}`] : []),
      ...(r.last ? [`last: ${clip(r.last.replace(/\s+/g, " "), 160)}`] : []),
    ].join(" | ");
  }).join("\n");
}

// The `orca` command reference. In EVERY wake (not just the role text a session sees once): a
// session resumed for days otherwise never learns a verb added since it started — it planned a
// send → archive → re-spawn when `orca move` would have done.
/** How the repo switcher names a repo: `owner/name` once the repos span more than one GitHub owner
 *  (a work account and a personal one on the same board), else just the name. Pure. */
export function repoLabel(repos: ReadonlyArray<{ name: string; owner?: string }>, name: string): string {
  const owners = new Set(repos.map((r) => r.owner).filter(Boolean));
  const repo = repos.find((r) => r.name === name);
  return owners.size > 1 && repo?.owner ? `${repo.owner}/${name}` : name;
}

const ORCA_COMMANDS = [
  "  orca board                      every workstream: PR state, agent status, Orca's check verdict",
  "  orca spawn --repo <repo> --title \"<2-5 words>\" --model <id> [--on <instance>] --objective \"…\" --output \"…\" --boundaries \"…\" [--context \"…\"] [--attach <id|path>]…",
  "      --on places the worktree on another instance (the board shows each workstream's `on:`; a `[new draft]`",
  "      that says `on: <instance>` wants that one). Without it, the repo's default instance.",
  "  orca send --repo <repo> --branch <branch> [--model <id>] [--attach <id|path>]… \"<message>\"     continue an existing workstream (--model moves it to another model)",
  "      --attach (repeatable) hands the worker a file on whatever instance it runs on: an id from ## Attachments, or a file path on this machine",
  "  orca address --repo <repo> --branch <branch>              have its agent fix conflicts, CI and review on its PR",
  "  orca pr-shots --repo <repo> --branch <branch> [--pr <n>]  put the workstream's newest reported screenshots in",
  "                                  its open PR's description (## Screenshots, replaced on rerun). Orca does it",
  "                                  for PRs it opens and on later runs; call it after you open one with gh pr create",
  "  orca move --repo <repo> --branch <branch> --to <instance>  move its worktree to another instance (not while it runs)",
  "  orca archive --repo <repo> --branch <branch>              cancel a workstream you spawned or sent to: stop its agent,",
  "                                  drop anything queued for it, archive the card. Refuses one you don't own.",
  "  orca stop --repo <repo> --branch <branch> [--drop-queue]  stop the running agent and keep everything — the",
  "                                  worktree, commits, queued messages and session — so a later `orca send` resumes",
  "                                  the same conversation. Use when the user says stop or a run goes the wrong way.",
  "                                  --drop-queue clears anything queued first instead of sending it at once.",
  "                                  Refuses one you don't own.",
  "  orca sweep [--confirm]          list finished worktrees, dead previews and orphan branches on every instance;",
  "                                  --confirm removes the ones marked \"would remove\" (never anything with",
  "                                  uncommitted or unpushed work). Merged PRs are already cleaned up on their own",
  "  orca preview --repo <repo> --branch <branch> [--status]   start (or restart) its local preview; --status prints",
  "                                  starting / running + URL / failed, and the tail of each service's log",
  "  orca preview --repo <repo> --branch <branch> --push-to-template [--confirm]   make that preview the",
  "                                  starting point of every later preview: its whole database replaces the",
  "                                  repo's template database (the old one kept as a backup) and its",
  "                                  integration env vars go back into the source env file. Without --confirm",
  "                                  it only prints the plan and the env diff (values masked)",
  "  orca merge --repo <repo> (--pr <n> | --branch <branch>) --when-green [--small]   Orca squash-merges it once",
  "                                  checks pass and it merges clean — never red; you hear back when it merges or",
  "                                  goes red. Don't watch CI yourself. The repo's mergePolicy decides what may be",
  "                                  queued (--small for a small PR); a refusal says why. --cancel unmarks it.",
  "  orca chats [\"<search terms>\"]   list conversations, or full-text search every past one (merged ones too)",
  "  orca read --chat <id> | --run <runId>                     one conversation's turns, or one full turn",
  "  orca status --repo <repo> --branch <branch> [--plan \"…\"] [--waiting \"…\"] [--merge small|needs-finn] [--clear]",
  "                                  your short record of one workstream, shown on the board and the user's",
  "                                  cards: your plan for it, what it waits on, its merge class (small: fine to",
  "                                  merge on green; needs-finn: the user merges). An empty flag clears that",
  "                                  field; no flags prints it",
  "  orca repo list [--user <login>]  every GitHub repo each signed-in gh account can see, newest first; ✓ = already in Orca",
  "  orca repo add <owner/name> [--on <instance>] [--name <slug>]   set a repo up in Orca: clone it on that instance",
  "                                  (the one whose account owns it, else the default), add it to the config with its",
  "                                  default branch and no previews. Do this when the user names work on a repo the",
  "                                  board doesn't have, then spawn on it",
  "  orca notes                      print your notes",
  "  orca notes set \"<the whole new text>\"",
  "  orca channels                   the channel links (Slack, Discord, email…), subscriptions and pairing codes",
  "  orca post --link <id> [--thread <id> | --repo <repo> --branch <branch>] \"<text>\"   post through a channel",
  "                                  link (retried if it fails); with --repo/--branch, in that workstream's thread.",
  "                                  Answer an outside sender on the link their message came from",
  "  orca thread link <adapter> <thread-id> --repo <repo> --branch <branch> [--link <id>]   send replies in that",
  "                                  external thread to the workstream",
  "  orca ask-user \"<question>\"      ask the user in Orca and on every channel subscribed to questions",
].join("\n");

const ORCHESTRATOR_ROLE = [
  "You are Orca's orchestrator. The user talks only to you. You get work done by delegating to worker",
  "agents: each is a headless coding agent in its own git worktree, and one branch is one workstream",
  "is one conversation. You never edit a repo's code yourself.",
  "",
  "Your tools are the `orca` command (run it with Bash) and Read/Grep/Glob over the repos, whose",
  "worktree paths are on the board. The `## Access` line of each message says what else you may run.",
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
  "- `--push-to-template` replaces what every future preview starts from, so run it only when the user",
  "  asks: first without --confirm, show them the plan, then with it. Relay its restore instructions.",
  "- You cannot promote or post to Slack as the user (only through a link with `orca post`), and you merge only through `orca merge --when-green` — never",
  "  `gh pr merge`. Where the repo's policy refuses, say the PR is ready for the user to merge.",
  "- Keep open PRs mergeable without being asked. On every wake, scan the board for PRs with failing",
  "  CI, merge conflicts, or unresolved review comments or threads, and run `orca address` on each",
  "  such workstream yourself — one at a time per workstream, never while its agent is already",
  "  running — then report what you addressed. The user should never have to ask you to address a PR.",
  "- When the user cancels a workstream you own, `orca archive` it rather than just telling the worker",
  "  to stop — one step removes the card and can't be restarted by a message still queued behind it.",
  "- Per-workstream state — the plan for it, what it waits on, whether it is small or needs the user",
  "  to merge — goes in `orca status` on that workstream, which the board carries back every wake.",
  "  Your notes are your memory across context resets for everything else: the user's preferences,",
  "  standing facts and decisions that span workstreams, in roughly 1500 words or fewer.",
  "- Keep replies short and concrete: what you did, what is running, what needs the user. Write them,",
  "  your briefs and your notes in STE, as the `## Writing` section of every message says.",
].join("\n");

/** The dead wake's own record (wakeProgress), under the cut-off notice — kept apart from it so a
 *  wake that died twice (its message dropped, no notice) still tells the next one what it did. */
function cutOffProgressSection(progress: string | undefined): string[] {
  return progress?.trim() ? ["", "## What the cut-off wake did", progress.trim(), "Finish the reply from here: say what was done, and do only what is left."] : [];
}

/** The orchestrator's prompt for one wake. The role goes in only when the session starts (or
 *  restarts after a context reset); the notes and a fresh board go in EVERY time, because they are
 *  what makes the session disposable — everything it needs to carry on is outside its context. */
export function orchestratorPrompt(input: { fresh: boolean; notes?: string; board: string; messages: string[]; shell?: boolean; cutOff?: string; cutOffProgress?: string }): string {
  const human = input.messages.filter((m) => !isWorkerEvent(m)), reports = input.messages.filter(isWorkerEvent);
  return [
    ...(input.fresh ? [ORCHESTRATOR_ROLE, ""] : []),
    // Every wake, not just the first: the setting can change under a session that is being resumed.
    "## Access",
    input.shell
      ? "Everything Claude Code has in a terminal: shell, files, web, subagents, MCP. Use it the way a manager uses their own hands — find things out, read and digest, run and inspect, fix the machine (a missing toolchain version, a preview that won't start), draft and send messages. Code changes to a repo are the one thing that goes to a workstream: a worker owns its branch, and an edit you make in a worktree is an edit it doesn't know about. Ask before anything destructive or hard to undo."
      : "The `orca` command, reading files, the web and read-only subagents. Any other command is denied: when a fix needs one, give the user the exact command to run.",
    "", "## Commands", ORCA_COMMANDS,
    // Every wake too — not just the role text — because a resumed session only ever sees the role
    // once, and the model rule is the one most worth repeating: without it every worker got the
    // config default, which was the biggest model.
    "", "## Models",
    "`spawn` requires --model. Start from Opus; step DOWN to Sonnet for small, clear tasks and UP to Fable only when Opus has failed:",
    ...MODEL_LADDER.map((m) => `  ${m.id}: ${m.when}`),
    "Move a workstream along the ladder with send --model when a run fails, stalls, or turns out smaller than it looked; say which model you chose and why.",
    `Orca counts a worker's failures on one model: after ${LADDER_FAILURES} in a row its report carries a \`Model ladder:\` line — the next model up to retry on, or that Orca has already moved it there.`,
    `A message opening with \`${NEW_DRAFT_MARKER}\` is the user's New-draft box: spawn exactly ONE workstream for it, in the repo it names, with a brief you write from it and a model you choose. Reply with one line: branch and model.`,
    // Every wake as well: a resumed session sees the role once, and the user wants STE ALWAYS.
    "", WRITING_STYLE,
    "", "## Your notes", input.notes?.trim() || "(empty)",
    "", "## Board", input.board,
    // The wake before this one died mid-turn: say so, or the user has to ask why it went quiet.
    ...(input.cutOff ? ["", "## Previous wake was cut off", `Your previous wake ${input.cutOff} before it finished its turn, so the user got no reply. What it was handling is below again. It may already have acted: check the board before you spawn or send (never start the same work twice), then finish the reply.`] : []),
    ...cutOffProgressSection(input.cutOffProgress),
    // What the user said and what the workers reported, in separate labelled sections — the user
    // first — so a report's text is never read as an instruction from them, nor theirs as a report.
    // Each message stays its own: several sent while you worked are separate messages, in order.
    ...(human.length ? ["", "## From the user", ...(human.length > 1 ? [`${human.length} separate messages, oldest first.`, ""] : []), joinMessages(human)] : []),
    ...(reports.length ? ["", "## Worker reports", "Automated, from Orca as your workers finish — not the user.", "", joinMessages(reports)] : []),
    // The files those messages carried, by id: the paths above are on THIS machine, so a worker
    // elsewhere gets one only through `--attach <id>`.
    ...attachmentSection(input.messages),
  ].join("\n");
}

/** The orchestrator's side panel: how wide it may be on a `vw`-wide viewport. Never narrower than a
 *  readable chat, never wider than leaves the page beside it usable — and a width remembered from a
 *  bigger screen is pulled back in. */
export const PANEL_MIN_W = 360, PANEL_DEFAULT_W = 460;
export function clampPanelWidth(w: number, vw: number): number {
  const max = Math.max(PANEL_MIN_W, Math.min(960, vw - 240));
  return Math.round(Math.min(vw, Math.max(PANEL_MIN_W, Math.min(max, Number.isFinite(w) ? w : PANEL_DEFAULT_W))));
}

/** Chat timestamps are grouped by day: a divider where the calendar day changes between two turns,
 *  reading "Today", "Yesterday", or the date. */
export const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();
export function dayLabel(at: number, now = Date.now()): string {
  if (sameDay(at, now)) return "Today";
  if (sameDay(at, now - 86_400_000)) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// ---- @ PR picker (the chat composer's autocomplete) ----
// Typing `@` in a composer lists the PRs the board already polled; picking one inserts `#123`, or
// `repo#123` when the number alone wouldn't say which repo. Pure, so the trigger/filter/insert rules
// are unit-tested without a DOM.

export type PrRefState = "open" | "draft" | "approved" | "merged";
export type PrRef = { repo: string; number: number; title: string; state: PrRefState; mergedAt?: string };

/** The `@query` the caret is in, if any: an `@` at the start of the text or after whitespace or an
 *  opening bracket (so `a@b.dev` and `https://x.dev/@user` don't fire), followed by a non-blank query on
 *  the same line up to the caret. Spaces are allowed after the first character so title words can
 *  narrow it; the picker closes by itself once nothing matches. */
export function prTrigger(text: string, caret: number): { start: number; query: string } | null {
  const line = text.slice(0, caret).split("\n").pop()!;
  const at = line.lastIndexOf("@");
  if (at < 0) return null;
  const before = line[at - 1];
  if (before !== undefined && !/[\s([{]/.test(before)) return null;
  const query = line.slice(at + 1);
  if (/^\s/.test(query) || query.length > 60) return null; // a lone `@ `, or a long-dead trigger
  return { start: caret - line.length + at, query };
}

/** Open PRs before merged ones; open newest-numbered first (gh's own list order, a proxy for recent
 *  activity), merged most-recently-merged first. Each word of the query must prefix the number, the
 *  repo name or a word of the title. */
export function filterPrRefs(refs: PrRef[], query: string, limit = 8): PrRef[] {
  const words = query.toLowerCase().replace(/^[#@]/, "").split(/\s+/).filter(Boolean);
  const hit = (r: PrRef) => {
    const titleWords = r.title.toLowerCase().split(/[^a-z0-9]+/);
    return words.every((w) => String(r.number).startsWith(w) || r.repo.toLowerCase().startsWith(w) || titleWords.some((t) => t.startsWith(w)));
  };
  const rank = (r: PrRef) => (r.state === "merged" ? 1 : 0);
  return refs.filter(hit).sort((a, b) =>
    rank(a) - rank(b)
    || (a.state === "merged" ? (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "") : b.number - a.number)).slice(0, limit);
}

/** The text a pick inserts: `#123`, qualified as `repo#123` when another repo has the same number,
 *  or when several repos are configured and the composer isn't the PR's own repo (the orchestrator,
 *  or a workstream in another repo). */
export function prRefLabel(ref: PrRef, refs: PrRef[], repoCount: number, contextRepo?: string): string {
  const clash = refs.some((r) => r.number === ref.number && r.repo !== ref.repo);
  return clash || (repoCount > 1 && contextRepo !== ref.repo) ? `${ref.repo}#${ref.number}` : `#${ref.number}`;
}

/** Replace the typed `@query` (from `start` to the caret) with `label`, plus a space unless one
 *  already follows; returns the new text and where the caret goes. */
export function insertPrRef(text: string, start: number, caret: number, label: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  const ins = /^\s/.test(rest) ? label : `${label} `;
  return { text: text.slice(0, start) + ins + rest, caret: start + ins.length };
}

// The same picker also lists every live workstream (with or without a PR, on any instance), so a
// local branch with no PR yet can be named too. A workstream with a PR is listed once, as its PR.

export type WorkstreamRef = { repo: string; branch: string; title: string; instance?: string; prNumber?: number };
/** One option in the `@` picker. */
export type MentionRef = { kind: "pr"; ref: PrRef } | { kind: "workstream"; ref: WorkstreamRef };

/** Each word of the query must start at a word boundary of the repo name, the branch or the title,
 *  so `at-ref` finds `orca/at-reference-…`. Board order is kept. */
export function filterWorkstreamRefs(refs: WorkstreamRef[], query: string, limit = 8): WorkstreamRef[] {
  const words = query.toLowerCase().replace(/^[#@]/, "").split(/\s+/).filter(Boolean);
  const atBoundary = (hay: string, w: string) => {
    for (let i = hay.indexOf(w); i >= 0; i = hay.indexOf(w, i + 1)) if (i === 0 || !/[a-z0-9]/.test(hay[i - 1]!)) return true;
    return false;
  };
  const hit = (r: WorkstreamRef) => {
    const hays = [r.repo, r.branch, r.title].map((h) => h.toLowerCase());
    return words.every((w) => hays.some((h) => atBoundary(h, w)));
  };
  return refs.filter(hit).slice(0, limit);
}

/** The picker's options: open PRs, then workstreams with no PR among `prs`, then merged PRs. */
export function filterMentions(prs: PrRef[], workstreams: WorkstreamRef[], query: string, limit = 8): MentionRef[] {
  const prKeys = new Set(prs.map((p) => `${p.repo}#${p.number}`));
  const own = workstreams.filter((w) => w.prNumber === undefined || !prKeys.has(`${w.repo}#${w.prNumber}`));
  const prHits = filterPrRefs(prs, query, limit);
  return [
    ...prHits.filter((p) => p.state !== "merged").map((ref): MentionRef => ({ kind: "pr", ref })),
    ...filterWorkstreamRefs(own, query, limit).map((ref): MentionRef => ({ kind: "workstream", ref })),
    ...prHits.filter((p) => p.state === "merged").map((ref): MentionRef => ({ kind: "pr", ref })),
  ].slice(0, limit);
}

/** The text a workstream pick inserts: `` `branch` ``, qualified as `` `repo/branch` `` — the name the
 *  orchestrator's board gives it — when the composer has no repo of its own (the orchestrator) or
 *  is in another repo of several. There is no server-side expansion: the agent reads this text. */
export function workstreamRefLabel(ref: WorkstreamRef, repoCount: number, contextRepo?: string): string {
  return contextRepo === undefined || (repoCount > 1 && contextRepo !== ref.repo) ? `\`${ref.repo}/${ref.branch}\`` : `\`${ref.branch}\``;
}

/** The text a pick of either kind inserts. */
export function mentionLabel(m: MentionRef, prs: PrRef[], repoCount: number, contextRepo?: string): string {
  return m.kind === "pr" ? prRefLabel(m.ref, prs, repoCount, contextRepo) : workstreamRefLabel(m.ref, repoCount, contextRepo);
}

// ---- The overview (the board's default List view) ----
// Every number on the stat tiles, the list's filter + sort, and the activity feed are derived here
// from the same assembled rows the swimlanes render — no endpoint of their own, so the two views can
// never disagree about how many PRs are mergeable.

export type OverviewLane = "LOCAL" | "DRAFT" | "IN_REVIEW" | "MERGEABLE" | "DONE";
export const OVERVIEW_LANES: OverviewLane[] = ["LOCAL", "DRAFT", "IN_REVIEW", "MERGEABLE", "DONE"];
export const LANE_LABELS: Record<OverviewLane, string> = {
  LOCAL: "Local", DRAFT: "Draft", IN_REVIEW: "In review", MERGEABLE: "Mergeable", DONE: "Done today",
};

export type PillTone = "default" | "blue" | "green" | "purple";
/** The lane's own pill, with no auto-merge override — the DONE lane's "Merged" rather than its
 *  swimlane title "Done today". */
export const lanePill = (lane: OverviewLane): { label: string; tone: PillTone } => ({
  label: lane === "DONE" ? "Merged" : LANE_LABELS[lane],
  tone: lane === "MERGEABLE" ? "blue" : lane === "DONE" ? "green" : "default",
});

/** Everything the PR status pill needs: the lane it would otherwise show, whether CI is failing,
 *  and both ways a PR can be set to merge itself — GitHub's own auto-merge, or Orca's
 *  merge-when-green queue mark (#169). */
export type PrPillLike = {
  lane: OverviewLane;
  ciStatus?: CiStatus;
  autoMergeEnabled?: boolean;
  autoMergeMethod?: string;
  mergeWhenGreen?: Pick<MergeMark, "by">;
};

/** The PR status pill shown on an agents-list row, a board card and the agent page's Details card:
 *  Merged (and a closed PR, which never reaches here — gh only lists open ones) and failing CI still
 *  win, but armed auto-merge replaces an otherwise in-review/mergeable reading with one purple
 *  "Auto-merge" state, so "it'll merge itself" is visible without opening the PR. Pure. */
export function prPill(row: PrPillLike): { label: string; tone: PillTone; tooltip?: string } {
  const base = lanePill(row.lane);
  if (row.lane !== "IN_REVIEW" && row.lane !== "MERGEABLE") return base; // Local/Draft/Merged: unaffected
  if (row.ciStatus === "failing") return base; // a known-red PR isn't about to merge itself
  if (row.autoMergeEnabled) {
    return { label: "Auto-merge", tone: "purple", tooltip: `GitHub auto-merge is enabled${row.autoMergeMethod ? ` (${row.autoMergeMethod})` : ""}` };
  }
  if (row.mergeWhenGreen) {
    return { label: "Auto-merge", tone: "purple", tooltip: `Orca's merge queue will merge it when green${row.mergeWhenGreen.by ? ` (queued by ${row.mergeWhenGreen.by})` : ""}` };
  }
  return base;
}

/** The subset of a board row the overview reads. Structural, so the store's Row satisfies it. */
export type OverviewRow = {
  repo: string; branch: string; title: string; prompt?: string; lane: OverviewLane;
  prNumber?: number; worktreePath?: string; instance?: string;
  agentStatus?: "idle" | "running" | "done" | "error";
  agentStartedAt?: number;
  mergeable?: Mergeable; mergeClean?: "clean" | "conflict";
  ciStatus?: CiStatus; reviewStatus?: ReviewStatus;
  orchestrated?: boolean; mergedAt?: string; queued?: number;
  transcript?: (Pick<AgentTurn, "instruction" | "prompt" | "startedAt" | "finishedAt" | "failed" | "stopped" | "provider"> & Partial<Pick<AgentTurn, "response" | "structured" | "stopReason">>)[];
  // Read only by the status hover card (rowStatus), never by the tone itself.
  agentError?: string; agentMeta?: { model?: string };
  agentCheck?: { ok: boolean; command?: string; exitCode?: number };
  prHead?: string; failingChecks?: string[];
  cleanupBlocked?: { why?: string; at?: string };
};

export type Attention = "check failed" | "agent error" | "run stopped" | "CI failing" | "conflicts" | "changes requested" | "message held";

/** Why a workstream is waiting on YOU — empty when it isn't. A running agent is working on it, so
 *  nothing is asked of you yet; a merged one is finished. */
export function attentionReasons(row: OverviewRow): Attention[] {
  if (row.lane === "DONE" || row.agentStatus === "running") return [];
  const out: Attention[] = [];
  if (row.agentCheck && !row.agentCheck.ok) out.push("check failed");
  if (row.agentStatus === "error") out.push("agent error");
  if (row.ciStatus === "failing") out.push("CI failing");
  if (row.mergeable === "CONFLICTING" || row.mergeClean === "conflict") out.push("conflicts");
  if (row.reviewStatus === "changes_requested") out.push("changes requested");
  // You stopped its last run (resumable, but nothing will happen until you say what next).
  if (row.agentStatus !== "error" && row.transcript?.[row.transcript.length - 1]?.stopped) out.push("run stopped");
  // A message queued behind a run that is no longer running: it will not send itself.
  if ((row.queued ?? 0) > 0) out.push("message held");
  return out;
}

/** The status dot: blue running, red failed (a check, CI or the run itself), amber needs you
 *  (conflicts, changes requested), green ready to merge or merged, neutral otherwise. */
export type RowTone = "running" | "failed" | "attention" | "ready" | "neutral";
export function rowTone(row: OverviewRow): RowTone {
  return rowStatus(row).tone;
}

/** The status chip's hover card: the tone (so the label it explains is `rowTone`'s, by
 *  construction), each real input behind it as one line, and at most one obvious next step. */
export type RowStatus = { tone: RowTone; reasons: string[]; action?: "address" };

/** Pure. `unresolved` is the review digest's actionable thread count when the cache has it — it
 *  is shown as a reason but never moves the tone, so every label stays as `rowTone` gives it.
 *  `model` is the card's model label, used while the run has not reported its own. */
export function rowStatus(row: OverviewRow, opts: { now?: number; unresolved?: number; model?: string } = {}): RowStatus {
  const now = opts.now ?? Date.now();
  const tone = statusTone(row);
  const reasons: string[] = [];
  const last = row.transcript?.[row.transcript.length - 1];
  const sha = row.prHead ? ` on commit ${row.prHead.slice(0, 7)}` : "";
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const unresolved = row.lane === "DONE" ? 0 : opts.unresolved ?? 0;
  if (tone === "running") {
    // The run's own model and start when the bridge has them, else the card's pin and the open turn.
    const name = row.agentMeta?.model ?? opts.model;
    const model = name ? ` on ${name}` : "";
    const since = row.agentStartedAt ?? (last && !last.finishedAt ? last.startedAt : undefined);
    reasons.push(since ? `The agent runs${model} for ${formatDuration(now - since)}.` : `The agent runs${model}.`);
    if ((row.queued ?? 0) > 0) reasons.push(`${plural(row.queued!, "message")} queued, sent when this run ends.`);
  } else {
    for (const why of attentionReasons(row)) {
      if (why === "check failed") reasons.push(`Orca's check failed on the last commit${row.agentCheck?.command ? `: \`${row.agentCheck.command}\` exited ${row.agentCheck.exitCode}` : ""}.`);
      if (why === "agent error") reasons.push(`The last run failed${row.agentError ? `: ${firstLine(row.agentError, 120)}` : ""}.`);
      if (why === "CI failing") reasons.push(`CI failed${sha}${row.failingChecks?.length ? `: ${row.failingChecks.slice(0, 3).join(", ")}${row.failingChecks.length > 3 ? ` +${row.failingChecks.length - 3}` : ""}` : ""}.`);
      if (why === "conflicts") reasons.push(row.prNumber ? "The PR has merge conflicts with its base." : "The branch conflicts with its base.");
      if (why === "changes requested") reasons.push("A reviewer requested changes.");
      if (why === "run stopped") reasons.push("You stopped the last run.");
      if (why === "message held") reasons.push(`${plural(row.queued!, "queued message")} wait, and no run is active to send them.`);
    }
    if (last && !last.failed && !last.stopped && asksForInput({ stopReason: last.stopReason, response: last.response, outcome: last.structured })) {
      const text = last.structured ? [last.structured.outcome, ...last.structured.remaining].join("\n") : last.response ?? "";
      reasons.push(`The agent asked a question: ${firstLine(text.split("\n").filter((l) => l.trim()).at(-1) ?? "", 120)}`);
    }
    if (tone === "ready" && row.lane === "DONE") reasons.push(`The PR merged${row.mergedAt ? ` ${ago(Date.parse(row.mergedAt), now)}` : ""}.`);
    if (tone === "ready" && row.lane === "MERGEABLE") {
      reasons.push(row.prNumber ? "The PR is approved." : "The branch is promoted.");
      if (row.ciStatus === "passing") reasons.push(`CI passes${sha}.`);
      if (row.ciStatus === "pending") reasons.push(`CI still runs${sha}.`);
      if (row.mergeable === "MERGEABLE" || row.mergeClean === "clean") reasons.push(row.prNumber ? "The PR merges clean." : "The branch merges clean.");
    }
    if (tone === "neutral") {
      const at = lastActivity(row);
      reasons.push(at ? `Idle since ${ago(at, now)}.` : "No agent ran on it yet.");
      if (last && last.finishedAt) {
        const result = last.structured?.outcome || last.response || "";
        reasons.push(`Last run ${last.failed ? "failed" : "done"}${result ? `: ${firstLine(result, 120)}` : "."}`);
      }
      if (row.lane === "DRAFT") reasons.push("The PR is a draft.");
      if (row.lane === "IN_REVIEW") reasons.push("The PR waits for an approval.");
      if (row.ciStatus === "pending") reasons.push(`CI still runs${sha}.`);
      if (row.ciStatus === "passing" && row.lane !== "DONE") reasons.push(`CI passes${sha}.`);
    }
  }
  if (unresolved > 0) reasons.push(`${plural(unresolved, "unresolved review thread")}.`);
  if (row.cleanupBlocked) reasons.push(`Cleanup blocked${row.cleanupBlocked.why ? `: ${row.cleanupBlocked.why}` : ""}.`);
  const addressable = row.prNumber !== undefined && row.lane !== "DONE" && row.agentStatus !== "running"
    && (row.ciStatus === "failing" || row.mergeable === "CONFLICTING" || row.mergeClean === "conflict" || row.reviewStatus === "changes_requested" || unresolved > 0);
  return { tone, reasons, ...(addressable ? { action: "address" as const } : {}) };
}

function statusTone(row: OverviewRow): RowTone {
  if (row.agentStatus === "running") return "running";
  const why = attentionReasons(row);
  if (why.some((w) => w === "check failed" || w === "agent error" || w === "CI failing")) return "failed";
  if (why.length) return "attention";
  if (row.lane === "MERGEABLE" || row.lane === "DONE") return "ready";
  return "neutral";
}

/** Newest thing that happened on a workstream (ms): its last turn, its live run, or its merge. 0
 *  when nothing is known (a PR Orca never ran an agent on). */
export function lastActivity(row: OverviewRow): number {
  const turns = row.transcript ?? [];
  const last = turns[turns.length - 1];
  return Math.max(0, last?.finishedAt ?? 0, last?.startedAt ?? 0, row.agentStartedAt ?? 0, row.mergedAt ? Date.parse(row.mergedAt) || 0 : 0);
}

export type OverviewStats = {
  running: number;
  attention: number;
  local: number;
  prs: { draft: number; inReview: number; mergeable: number; total: number };
  mergedToday: number;
  /** Turns started per hour over the last 24h, oldest first — the activity chart. */
  turnsByHour: number[];
};

export function overviewStats(rows: OverviewRow[], now = Date.now()): OverviewStats {
  const open = rows.filter((r) => r.prNumber && r.lane !== "DONE");
  const count = (lane: OverviewLane) => open.filter((r) => r.lane === lane).length;
  const prs = { draft: count("DRAFT"), inReview: count("IN_REVIEW"), mergeable: count("MERGEABLE"), total: open.length };
  return {
    running: rows.filter((r) => r.agentStatus === "running").length,
    attention: rows.filter((r) => attentionReasons(r).length > 0).length,
    local: rows.filter((r) => r.lane === "LOCAL").length,
    prs,
    mergedToday: rows.filter((r) => r.lane === "DONE").length,
    turnsByHour: turnsByHour(rows, now),
  };
}

/** Turns started in each of the last `hours` hours (oldest bucket first, the current hour last). */
export function turnsByHour(rows: OverviewRow[], now = Date.now(), hours = 24): number[] {
  const buckets = new Array<number>(hours).fill(0);
  const HOUR = 3_600_000;
  for (const r of rows) {
    for (const t of r.transcript ?? []) {
      if (!t.startedAt) continue;
      const ago = Math.floor((now - t.startedAt) / HOUR);
      if (ago >= 0 && ago < hours) buckets[hours - 1 - ago]!++;
    }
  }
  return buckets;
}

/** Instance display order: `cloud` first, then `local`, then any others alphabetically — so cloud
 *  always leads wherever instances are listed or stacked (Overview, the switcher, filters), no
 *  matter which machine is viewing. The one place this is decided, so it can't drift per call site. */
export function instanceOrder(names: string[]): string[] {
  const rank = (n: string) => (n === "cloud" ? 0 : n === "local" ? 1 : 2);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export type ListFilter = {
  repo: string; // "all" or a repo name
  instance: string; // "all" or an instance name
  state: "all" | OverviewLane;
  attention: boolean;
  q: string;
};
export const DEFAULT_LIST_FILTER: ListFilter = { repo: "all", instance: "all", state: "all", attention: false, q: "" };

/** Where a row's worktree lives — `here` unless the bridge said otherwise. None without a worktree
 *  (a PR Orca hasn't adopted, a merged one). */
export const rowInstance = (row: OverviewRow, here?: string): string | undefined =>
  row.worktreePath ? (row.instance ?? here) : undefined;

export function filterRows<R extends OverviewRow>(rows: R[], f: ListFilter, here?: string): R[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.repo !== "all" && r.repo !== f.repo) return false;
    if (f.instance !== "all" && rowInstance(r, here) !== f.instance) return false;
    if (f.state !== "all" && r.lane !== f.state) return false;
    if (f.attention && attentionReasons(r).length === 0) return false;
    if (words.length) {
      const hay = `${r.title} ${r.branch} ${r.repo} ${r.prNumber ? `#${r.prNumber}` : ""} ${r.prompt ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export type ListSort = "updated" | "attention" | "state" | "title" | "repo";
export const SORT_LABELS: Record<ListSort, string> = {
  updated: "Last activity", attention: "Needs you first", state: "State", title: "Title", repo: "Repo",
};

/** A sorted copy. Ties fall back to last activity, then title, so the order is stable across polls. */
export function sortRows<R extends OverviewRow>(rows: R[], by: ListSort): R[] {
  const byActivity = (a: R, b: R) => lastActivity(b) - lastActivity(a) || a.title.localeCompare(b.title);
  const key: Record<ListSort, (a: R, b: R) => number> = {
    updated: () => 0,
    attention: (a, b) => attentionReasons(b).length - attentionReasons(a).length || Number(b.agentStatus === "running") - Number(a.agentStatus === "running"),
    state: (a, b) => OVERVIEW_LANES.indexOf(a.lane) - OVERVIEW_LANES.indexOf(b.lane),
    title: (a, b) => a.title.localeCompare(b.title),
    repo: (a, b) => a.repo.localeCompare(b.repo),
  };
  return [...rows].sort((a, b) => key[by](a, b) || byActivity(a, b));
}

export type ActivityItem = {
  repo: string; branch: string; title: string; lane: OverviewLane; prNumber?: number;
  text: string; at: number; status: "running" | "failed" | "stopped" | "done";
};

/** The newest turns across every workstream — the "Recent activity" feed. Each turn shows what you
 *  (or the board action) asked, not the scaffolded prompt. */
export function recentActivity(rows: OverviewRow[], limit = 12): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const r of rows) {
    for (const t of r.transcript ?? []) {
      const at = t.finishedAt ?? t.startedAt;
      if (!at) continue;
      items.push({
        repo: r.repo, branch: r.branch, title: r.title, lane: r.lane, prNumber: r.prNumber,
        text: (t.instruction ?? promptInstruction(t.prompt)).replace(/\s+/g, " ").trim(),
        at,
        status: t.failed ? "failed" : t.stopped ? "stopped" : t.finishedAt ? "done" : "running",
      });
    }
  }
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** "just now" / "4m" / "3h" / "2d" — compact relative time for a dense list. */
export function ago(ms: number, now = Date.now()): string {
  if (!ms) return "—";
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---- review signal: who approved, what humans said, what the AI reviewers flagged, what's open ----
// Pure derivations over gh.reviewSignal (one PR's reviews, comments and inline threads), shared by
// the list row's review cluster and the PR page's Review panel.

/** AI code reviewers, matched as a case-insensitive substring of the login (their accounts vary:
 *  `claude[bot]`, `gemini-code-assist`, `copilot-pull-request-reviewer`, `coderabbitai`…). Any login
 *  ending in `[bot]`, or flagged a Bot by GitHub, is a bot too. Grow this list, not the checks. */
export const AI_REVIEWERS = ["claude", "gemini", "copilot", "coderabbit", "cursor", "codex"];

export function isBotAuthor(login?: string, bot?: boolean): boolean {
  if (bot || !login) return true; // a deleted ("ghost") account has no login: not a person you can ask
  const l = login.toLowerCase();
  return l.endsWith("[bot]") || AI_REVIEWERS.some((name) => l.includes(name));
}

export type Severity = "critical" | "warning";
const SEVERITY_WINDOW = 300;
const CRITICAL_RE = /🔴|\bcritical\b|\bsevere\b|\bhigh[- ]severity\b|\bhigh[- ]priority\b|\bblock(?:ing|er)\b|\bmust[- ]fix\b|\bsecurity\b/i;
const WARNING_RE = /🟠|\u26a0|\bwarning\b/i;
const EMOJI_MARKER_RE = /🔴|🟠|\u26a0/;
const SUMMARY_RE = /^\s*(?:<!--[^]*?-->\s*)*(?:#{1,6}\s*|\*\*)?(?:summary\b|walkthrough\b|review summary\b|pr summary\b|code review\b|pull request overview\b)/i;
const STATUS_RE = /^\s*(?:\*\*)?(?:status\b|fyi\b|note:|update:|heads[- ]up\b|lgtm\b|✅)/i;
const NIT_RE = /^\s*(?:\*\*|\[)?\(?nit(?:pick)?\b/i;

/** The severity a (bot) review comment declares near its top — an emoji marker, a Gemini priority
 *  badge (`high-priority.svg`), or a word like "critical" / "must fix" / "warning" in the first 300
 *  characters. One function, so the heuristic is tuned in one place. */
export function commentSeverity(body: string): Severity | undefined {
  const top = body.slice(0, SEVERITY_WINDOW);
  if (CRITICAL_RE.test(top)) return "critical";
  if (WARNING_RE.test(top)) return "warning";
  return undefined;
}

/** A bot's walkthrough / "## Summary" comment: an overview, not a request for a change. */
export const isSummaryComment = (body: string) => SUMMARY_RE.test(body);
/** "Status: …", "FYI", "Note:" — an update, not something to address. */
export const isStatusUpdate = (body: string) => STATUS_RE.test(body);
export const isNit = (body: string) => NIT_RE.test(body);

/** The first readable line of a comment: badges, HTML comments and heading/emphasis marks dropped. */
export function firstLine(body: string, max = 140): string {
  const text = body.replace(/<!--[^]*?-->/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<[^>]+>/g, "").replace(/\*\*/g, "");
  const line = text.split(/\r?\n/).map((l) => l.replace(/^[\s#>*_-]+|[*_]+$/g, "").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type ReviewItem = {
  id: string; kind: "thread" | "comment" | "review"; author?: string; body: string; url?: string;
  createdAt?: string; path?: string; severity?: Severity; bot: boolean;
  /** What to show: the first readable line, or for a severe finding the line that flags it (a
   *  Claude review opens with "Claude finished…", not the finding). */
  line: string;
};

/** The first line in the severity window that carries a marker — the finding itself. */
function severityLine(body: string): string | undefined {
  const top = body.slice(0, SEVERITY_WINDOW);
  const hit = top.split(/\r?\n/).find((l) => CRITICAL_RE.test(l) || WARNING_RE.test(l));
  return hit ? firstLine(hit) || undefined : undefined;
}

/** Everything someone else said that is still worth reading: every conversation comment and review
 *  body, and every UNRESOLVED inline thread not opened by the PR's author. Newest first. */
function reviewItems(s: ReviewSignal): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const c of s.comments) {
    if (!c.body.trim()) continue; // a bare approval: shown as an approver, not a comment
    items.push({ id: c.id, kind: c.kind, author: c.author, body: c.body, url: c.url, createdAt: c.createdAt, bot: isBotAuthor(c.author, c.bot), line: firstLine(c.body) });
  }
  for (const t of s.threads) {
    if (t.resolved || (s.prAuthor && t.author === s.prAuthor) || !t.body.trim()) continue;
    items.push({ id: t.id, kind: "thread", author: t.author, body: t.body, url: t.url, createdAt: t.createdAt, path: t.path, bot: isBotAuthor(t.author, t.bot), line: firstLine(t.body) });
  }
  return items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Logins whose latest DECISIVE review is an approval. A later plain "commented" review does not
 *  withdraw an approval on GitHub, so only APPROVED / CHANGES_REQUESTED / DISMISSED count. */
export function approvers(s: ReviewSignal): string[] {
  const latest = new Map<string, string>();
  for (const r of [...s.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (r.kind !== "review" || !r.author || !r.state || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
    latest.delete(r.author); // re-insert so the order is by latest decision
    latest.set(r.author, r.state);
  }
  return [...latest].filter(([, state]) => state === "APPROVED").map(([login]) => login);
}

/** Comments and open threads from people (not bots / AI reviewers). */
export const humanComments = (s: ReviewSignal): ReviewItem[] => reviewItems(s).filter((i) => !i.bot);

/** Bot / AI comments that declare a severity near their top. A summary comment counts only when it
 *  carries an explicit emoji marker — its prose ("improves security…") is not a finding. A top-level
 *  comment or review body (kind "comment" | "review") has no "resolved" bit on GitHub — once posted
 *  it sits there forever — so it only counts when it was posted AFTER the PR's latest commit; an
 *  older one was superseded by work the worker has since done. An unresolved inline thread (kind
 *  "thread") always counts: GitHub lets it be resolved, and `reviewItems` already drops it once it is. */
export function severeAiComments(s: ReviewSignal): ReviewItem[] {
  return reviewItems(s).flatMap((i) => {
    if (!i.bot || (isSummaryComment(i.body) && !EMOJI_MARKER_RE.test(i.body.slice(0, SEVERITY_WINDOW)))) return [];
    if (i.kind !== "thread" && s.headCommitAt && i.createdAt && i.createdAt <= s.headCommitAt) return [];
    const severity = commentSeverity(i.body);
    // A badge-only line (Gemini's priority image) has no text of its own: keep the first line then.
    return severity ? [{ ...i, severity, line: (/!\[/.test(severityLine(i.body) ?? "") ? undefined : severityLine(i.body)) ?? i.line }] : [];
  });
}

/** Unresolved inline threads that ask for a change: not opened by the PR's author, not a status
 *  update, not a bot's summary. Nits still count — `nits` says how many of them are. */
const isActionableThread = (s: ReviewSignal, t: ReviewSignal["threads"][number]): boolean =>
  !t.resolved && !(s.prAuthor && t.author === s.prAuthor) && !isStatusUpdate(t.body) && !isSummaryComment(t.body);
export function actionableUnresolved(s: ReviewSignal): { count: number; nits: number } {
  let count = 0, nits = 0;
  for (const t of s.threads) {
    if (!isActionableThread(s, t)) continue;
    count++;
    if (isNit(t.body)) nits++;
  }
  return { count, nits };
}

/** Actionable unresolved threads no agent has been handed yet (Address PR records the ids it sent as
 *  `handedReviewThreadIds`) — what auto-upkeep's review trigger counts, so a thread the agent answered
 *  but nobody resolved doesn't re-fire on every push. Pure. */
export const unhandedActionable = (s: ReviewSignal, handed: readonly string[] = []): number =>
  s.threads.filter((t) => isActionableThread(s, t) && !handed.includes(t.id)).length;

export type ReviewDigest = {
  approvers: string[]; human: ReviewItem[]; severe: ReviewItem[];
  unresolved: { count: number; nits: number }; worst?: Severity;
};

export function reviewDigest(s: ReviewSignal): ReviewDigest {
  const severe = severeAiComments(s);
  return {
    approvers: approvers(s), human: humanComments(s), severe, unresolved: actionableUnresolved(s),
    worst: severe.some((i) => i.severity === "critical") ? "critical" : severe.length ? "warning" : undefined,
  };
}

/** The instance chip's history graphs: samples → SVG polyline `points` strings, x by time across
 *  [from, to] (so an outage reads as a gap, not as a compressed line) and y from 0 to `max`. A run
 *  is broken where consecutive samples are more than `gapMs` apart — the sampler writes once a
 *  minute, so a longer silence means the box (or its bridge) was down. */
export function sparklineSegments(
  points: { at: number; v: number }[], opts: { from: number; to: number; max: number; w: number; h: number; gapMs?: number },
): string[] {
  const { from, to, max, w, h, gapMs = 5 * 60_000 } = opts;
  const span = Math.max(1, to - from), top = max > 0 ? max : 1;
  const segs: string[][] = [];
  let prev: number | undefined;
  for (const p of points) {
    if (p.at < from || p.at > to) continue;
    if (prev === undefined || p.at - prev > gapMs) segs.push([]);
    const x = ((p.at - from) / span) * w, y = h - (Math.min(Math.max(p.v, 0), top) / top) * h;
    segs[segs.length - 1]!.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    prev = p.at;
  }
  return segs.map((s) => s.join(" "));
}

/** Which of a preview service's URLs this page should open. `url` is the owner's address (its
 *  tailnet name), reachable from any device; `localUrl` is the same service on the answering
 *  bridge's loopback — the only secure context a plain-http preview can have. A page served from
 *  localhost (the laptop's own bridge) opens `localUrl` when there is one; anything else (a phone,
 *  a browser pointed at the box) opens `url`, since ITS localhost is not that bridge. */
export function previewHref(svc: { url: string; localUrl?: string }, pageHost: string): string {
  if (isLoopbackHost(pageHost)) return svc.localUrl ?? svc.url;
  // A page reached over the tailnet (a phone) never opens localhost: that is the phone itself. An
  // owner with no ORCA_PREVIEW_HOST and no `instances` entry hands out `http://localhost:<port>`;
  // the bridge that served this page is the one that answered, so its tailnet name is the host.
  try {
    const u = new URL(svc.url);
    if (isLoopbackHost(u.hostname)) { u.hostname = pageHost; return svc.url.endsWith("/") ? u.toString() : u.toString().replace(/\/$/, ""); }
  } catch { /* not a URL — hand it back as-is */ }
  return svc.url;
}

const isLoopbackHost = (h: string): boolean => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";

/** The host:port a preview link shows as its label — the address it will open, so a phone shows the
 *  tailnet name rather than a bare port. */
export const previewLabel = (href: string): string => { try { return new URL(href).host; } catch { return href; } };

// ---- the GitHub PR preview (deploy-preview URL the pr-preview action posts), distinct from the
// local preview above: one click away wherever a PR shows, instead of only on the PR detail page.
export type PrPreviewState = "hidden" | "add" | "pending" | "ready";
export type PrPreviewRow = { prNumber?: number; previewUrl?: string; hasPreviewLabel?: boolean };

/** `configured`: the repo has a `previewLabel` or opted into RepoFeatures.previews — otherwise there
 *  is nothing a click could do, so the control hides rather than offering a button that 404s.
 *  `justAdded`: an optimistic flag the control sets right after a successful Add click, so it reads
 *  as pending at once rather than waiting for the next PR poll to carry `hasPreviewLabel`. */
export function prPreviewState(row: PrPreviewRow, configured: boolean, justAdded = false): PrPreviewState {
  if (!row.prNumber || !configured) return "hidden";
  if (row.previewUrl) return "ready";
  if (row.hasPreviewLabel || justAdded) return "pending";
  return "add";
}

// ---- freshness: the stale indicator and the new-build banner ----

/** How long the board's data may go unrefreshed before the top bar says so: two idle poll periods. */
export const STALE_AFTER_MS = 75_000;
/** The age of the board's data when it is stale, else null (fresh, or nothing loaded yet). Pure. */
export function staleAge(lastSyncAt: number, now: number, after = STALE_AFTER_MS): number | null {
  if (!lastSyncAt) return null;
  const age = now - lastSyncAt;
  return age > after ? age : null;
}

/** When the bridge's database went away, read off the `x-orca-database` header every API answer
 *  carries while it is down (`unreachable since <iso>`); null for no header or an unreadable one. Pure. */
export function databaseDownSince(header: string | null | undefined): number | null {
  const m = /^unreachable since (\S+)$/.exec(header ?? "");
  const at = m ? Date.parse(m[1]!) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** The one banner's text while the database is down: the time (with the day, past today), and what
 *  the page is doing about it. Pure. */
export function databaseBannerText(since: number, now: number): string {
  const d = new Date(since);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const when = sameDay ? hhmm : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hhmm}`;
  return `Database unreachable since ${when} · showing cached data · retrying`;
}

/** A newer build has been deployed: the served `version.json` names a different build than the one
 *  running. A dev server (no build id) or an unreadable answer never prompts. Pure. */
export const newerBuild = (running: string | undefined, served: unknown): boolean =>
  !!running && running !== "dev" && typeof served === "object" && served !== null
  && typeof (served as { build?: unknown }).build === "string" && (served as { build: string }).build !== running;

// ---- the Vercel-style console: usage rows, metric charts, durations, chat log, repos ----
// Pure pieces the Overview / Agents / Agent / Usage / Repos pages render, so each number is tested
// without a DOM.

/** Compact countdown to a window's reset, e.g. "45m", "1h 15m", "2h", "7d 2h" — null if unknown or
 *  already past. */
export function untilReset(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) {
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  }
  const days = Math.floor(mins / (24 * 60));
  const hours = Math.floor((mins % (24 * 60)) / 60);
  return `${days}d${hours ? ` ${hours}h` : ""}`;
}

/** Money carried as minor units (+ exponent) in its own currency, e.g. 8535/2/GBP → "£85.35". */
export function formatMoney(minor: number, exponent: number, currency: string): string {
  const amount = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: exponent }).format(amount);
  } catch {
    return `${amount.toFixed(exponent)} ${currency}`;
  }
}

type Window = { utilization: number; resetsAt: string | null };
type ClaudeReading = { fiveHour: Window; sevenDay: Window; fable?: Window | null; extra: { usedMinor: number; limitMinor: number; currency: string; exponent: number; utilization: number } | null };
type UsageReading = {
  claude: ClaudeReading | null;
  codex: { windows: (Window & { label: string })[] } | null;
  profiles?: LoginReading[];
  routing?: { hydra: boolean; shim: boolean };
};

/** One line of the Usage card, Vercel's shape: a ring at `pct`, a label, and value / limit. */
export type UsageRow = {
  key: string; label: string; pct: number; value: string; limit: string; resetsIn: string | null;
  /** Said in the countdown's place when there is no reset to count to: a window not yet opened. */
  resetNote?: string;
};
/** A block of rows under one heading: the fleet, one hydra login, Codex. `state` is hydra's verdict
 *  when it isn't "ok"; `dim` when hydra can't route to that login. `name` is the hydra login name
 *  (set only for a `login:` group) — what the enable/disable toggle sends back to the server.
 *  `instance` is which host's reading `state`/the rows came from (the bridge already picked the
 *  freshest OK one — see mergeInstanceProfiles server-side); `hosts` is every host that reported
 *  this login with ITS OWN state, so a login that is `ok` overall but stale on one machine can still
 *  show that as a secondary hint and send Refresh at the right host. */
export type UsageGroup = {
  key: string; title: string; subtitle?: string; state?: string; dim?: boolean; name?: string; rows: UsageRow[];
  instance?: string; hosts?: { instance: string; state?: string }[];
};

const CLAUDE_WINDOWS: [keyof Pick<ClaudeReading, "fiveHour" | "sevenDay" | "fable">, string][] = [["fiveHour", "5-hour window"], ["sevenDay", "Weekly"], ["fable", "Fable weekly"]];
type LoginReading = {
  name: string; usage: ClaudeReading | null; state?: string; email?: string;
  instance?: string; hosts?: { instance: string; state?: string }[];
};

/** Logins hydra can't route to right now: no reading, or deliberately out of the rotation. Exhausted
 *  and locked logins DO count — they hold a real reading and are exactly what pulls the fleet up. */
/** A window as it stands NOW — hydra's own rule (its `eff`): once the reset time has passed, the
 *  window has rolled over and is empty, whatever the (older) reading said. A stale login's reading
 *  keeps a past `resets`; carried as-is it hid the fleet's 5-hour countdown (the soonest reset was
 *  that past time, which `untilReset` drops) and showed a used-up window that had already reset. */
export function liveWindow(w: Window, now = Date.now()): Window {
  return w.resetsAt && Date.parse(w.resetsAt) <= now ? { utilization: 0, resetsAt: null } : w;
}

/** A hydra login's state as ONE word for its pill, the full reason in its tooltip. hydra's states:
 *  `hydra`'s `state()` — not signed in on this machine, disabled, locked, exhausted, token stale —
 *  refreshes on next launch, no usage data yet, ok. Anything newer reads as its first word. */
export function loginStatus(state: string): { label: string; detail: string; tone: "default" | "amber" | "red" } {
  if (state === "not signed in on this machine") return { label: "Signed-out", detail: "Not signed in on this machine — hydra login <name> to add it", tone: "default" };
  if (state === "disabled") return { label: "Disabled", detail: "Disabled — out of hydra's rotation until you enable it", tone: "default" };
  if (state === "locked") return { label: "Locked", detail: "Locked — hydra won't route to this login", tone: "red" };
  if (state === "exhausted") return { label: "Limited", detail: "Exhausted — a usage window is at hydra's threshold; skipped until it resets", tone: "red" };
  if (state.startsWith("token stale")) return { label: "Stale", detail: "Access token expired — Orca renews it (Refresh now, or its 30-minute check); the usage shown may be old", tone: "amber" };
  if (state === "no usage data yet") return { label: "New", detail: "No usage data yet — it fills in after the first run", tone: "default" };
  if (/expired/i.test(state)) return { label: "Expired", detail: state.charAt(0).toUpperCase() + state.slice(1), tone: "red" };
  const word = state.split(/[\s—-]+/)[0] ?? state;
  return { label: word.charAt(0).toUpperCase() + word.slice(1), detail: state.charAt(0).toUpperCase() + state.slice(1), tone: "default" };
}

/** A login's OTHER hosts — every one that reported it with a state different from the one already
 *  shown as the group's own pill (merged across instances, the pill shows whichever host's reading
 *  was picked). This is "finnformica: stale on local" when a cloud box's fresh reading hides a
 *  stale token on the laptop that still blocks launching there. Pure. */
export function hostHints(g: Pick<UsageGroup, "instance" | "state" | "hosts">): { instance: string; state: string }[] {
  if (!g.hosts || g.hosts.length < 2) return [];
  // A host in the same state as the pill says nothing new — a login disabled everywhere is just
  // "Disabled", not "Disabled" plus "Disabled on local".
  return g.hosts.filter((h): h is { instance: string; state: string } =>
    Boolean(h.state) && h.state !== "ok" && h.state !== g.state);
}

export const outOfRotation = (p: { usage: unknown; state?: string }): boolean => !p.usage || p.state === "disabled" || p.state === "not signed in on this machine";

/** The login toggle's optimistic update: flip one profile's `state` before `POST
 *  /api/usage/profile` round-trips, so the switch, the row's dim styling and the fleet mean move at
 *  once. Disabling always lands on "disabled"; enabling clears to undefined ("ok") as a best guess —
 *  the server's authoritative list (applied once it answers) corrects it if the login was actually
 *  something else, e.g. still token-stale. Pure, and a no-op when the name isn't in the list (a
 *  profile that disappeared from a fleet poll mid-click). */
export function withProfileEnabled<P extends { name: string; state?: string }>(profiles: P[], name: string, enabled: boolean): P[] {
  return profiles.map((p) => p.name === name ? { ...p, state: enabled ? undefined : "disabled" } : p);
}

export type FleetUsage = { count: number; exhausted: number; fiveHour: Window; sevenDay: Window; fable: Window | null };

/** One reading for the whole fleet: the mean utilization per window across the logins in rotation,
 *  with the soonest reset still to come (`liveWindow`). Null when nothing is in rotation. */
export function aggregateProfiles(profiles: LoginReading[], now = Date.now()): FleetUsage | null {
  const live = profiles.filter((p) => !outOfRotation(p));
  if (!live.length) return null;
  const mean = (raw: Window[]): Window => {
    const ws = raw.map((w) => liveWindow(w, now));
    return {
      utilization: Math.round(ws.reduce((s, w) => s + w.utilization, 0) / ws.length),
      resetsAt: ws.map((w) => w.resetsAt).filter((r): r is string => Boolean(r)).sort()[0] ?? null,
    };
  };
  const fables = live.map((p) => p.usage!.fable).filter((w): w is Window => Boolean(w));
  return {
    count: live.length,
    exhausted: live.filter((p) => p.state === "exhausted" || p.state === "locked").length,
    fiveHour: mean(live.map((p) => p.usage!.fiveHour)),
    sevenDay: mean(live.map((p) => p.usage!.sevenDay)),
    fable: fables.length ? mean(fables) : null,
  };
}

function claudeRows(key: string, c: ClaudeReading, now: number): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const [field, label] of CLAUDE_WINDOWS) {
    const raw = c[field] as Window | null | undefined;
    if (!raw) continue;
    const w = liveWindow(raw, now);
    // No reset and nothing used: the window opens on the next message (Claude's 5-hour window is
    // counted from its first use), so there is nothing to count down to yet — say that, not nothing.
    rows.push({ key: `${key}:${field}`, label, pct: w.utilization, value: `${w.utilization}%`, limit: "100%", resetsIn: untilReset(w.resetsAt, now),
      ...(!w.resetsAt && w.utilization === 0 ? { resetNote: "starts on next use" } : {}) });
  }
  if (c.extra) rows.push({
    key: `${key}:extra`, label: "Extra usage", pct: c.extra.utilization,
    value: formatMoney(c.extra.usedMinor, c.extra.exponent, c.extra.currency), limit: formatMoney(c.extra.limitMinor, c.extra.exponent, c.extra.currency), resetsIn: null,
  });
  return rows;
}

/** The Usage card's groups: with hydra, the fleet (mean per window over the logins in rotation)
 *  then every login; without it, the one Claude login. Codex after. Empty when nothing is signed in. */
export function usageGroups(u: UsageReading | null, now = Date.now()): UsageGroup[] {
  if (!u) return [];
  const groups: UsageGroup[] = [];
  const profiles = u.profiles ?? [];
  if (profiles.length) {
    const fleet = aggregateProfiles(profiles, now);
    groups.push(fleet ? {
      key: "fleet", title: "Claude", subtitle: `${fleet.count} login${fleet.count === 1 ? "" : "s"} in rotation${fleet.exhausted ? ` · ${fleet.exhausted} exhausted` : ""}`,
      rows: claudeRows("fleet", { fiveHour: fleet.fiveHour, sevenDay: fleet.sevenDay, fable: fleet.fable, extra: null }, now),
    } : { key: "fleet", title: "Claude", subtitle: "no login in rotation", rows: [] });
    for (const p of profiles) {
      groups.push({
        key: `login:${p.name}`, title: p.name, subtitle: p.email, state: p.state && p.state !== "ok" ? p.state : undefined, dim: outOfRotation(p), name: p.name,
        rows: p.usage ? claudeRows(`login:${p.name}`, p.usage, now) : [],
        instance: p.instance, hosts: p.hosts,
      });
    }
  } else if (u.claude) groups.push({ key: "claude", title: "Claude", rows: claudeRows("claude", u.claude, now) });
  if (u.codex?.windows.length) groups.push({
    key: "codex", title: "Codex",
    rows: u.codex.windows.map((w, i) => ({
      key: `codex:${i}`, label: w.label === "wk" ? "Weekly" : w.label === "5h" ? "5-hour window" : w.label, pct: w.utilization, value: `${w.utilization}%`, limit: "100%", resetsIn: untilReset(w.resetsAt, now),
    })),
  });
  return groups;
}

/** Hydra is installed but the bridge's `claude` isn't its shim: every run silently uses one login. */
export const routingBroken = (u: UsageReading | null): boolean => Boolean(u?.routing?.hydra && !u.routing.shim);

/** The header meter's one number: EXACTLY the figure UsageCard's headline Claude row shows for the
 *  5-hour window — the fleet mean across logins in rotation (or, with no hydra, the one login's own
 *  window) — by reusing `usageGroups`, the same computation the card renders. A header that computed
 *  its own per-login pick once showed 33% beside a card whose headline row read 54% for the same
 *  account: two numbers for one thing. Per-login detail (which login, its own state) lives only in
 *  the hover card's full UsageCard, never in the header's own number or tooltip. Null when the
 *  headline row itself has nothing to show (no provider signed in, or nothing in rotation) — the
 *  header hides rather than drawing an empty ring. */
export type HeaderUsage = { pct: number; tooltip: string };
export function headerUsage(u: UsageReading | null, now = Date.now()): HeaderUsage | null {
  const head = usageGroups(u, now).find((g) => g.key === "fleet" || g.key === "claude");
  const row = head?.rows.find((r) => r.key.endsWith(":fiveHour"));
  if (!head || !row) return null;
  return { pct: row.pct, tooltip: head.subtitle ? `5-hour window · ${head.subtitle}` : "5-hour window" };
}

/** Usage zone by how much of an allowance is burned: fine, caution (≥75%), the red zone (≥90%). */
export const usageZone = (pct: number): "ok" | "warn" | "danger" => (pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok");

/** The instance card's range picker. */
export const HISTORY_RANGES = [{ label: "6h", hours: 6 }, { label: "24h", hours: 24 }, { label: "7d", hours: 168 }] as const;

/** At most `max` points, each the mean of its time bucket — a week of minute samples is 10k points,
 *  which no 600px line needs. Gaps survive: an empty bucket emits nothing. */
export function downsample(points: { at: number; v: number }[], max: number, from: number, to: number): { at: number; v: number }[] {
  if (points.length <= max) return points;
  const width = Math.max(1, (to - from) / max);
  const out: { at: number; v: number }[] = [];
  let bucket = -1, sumV = 0, sumAt = 0, n = 0;
  const flush = () => { if (n) out.push({ at: sumAt / n, v: sumV / n }); sumV = sumAt = n = 0; };
  for (const p of points) {
    const b = Math.floor((p.at - from) / width);
    if (b !== bucket) { flush(); bucket = b; }
    sumV += p.v; sumAt += p.at; n++;
  }
  flush();
  return out;
}

/** One vitals sample, recorded (instance_metric) or live (/api/health). */
export type VitalSample = { at: number; cpuPct: number; memUsedGb: number; runningAgents?: number; diskUsedGb?: number; oomKills?: number };
type Pt = { at: number; v: number };
export type InstanceSeries = {
  cpu: Pt[]; mem: Pt[]; agents: Pt[]; disk: Pt[];
  /** Samples that recorded agent runs OOM-killed in their own scope — the Memory chart's markers. */
  ooms: { at: number; n: number }[];
  /** The newest sample — what the card's header stats show, and exactly every chart's last point. */
  latest: { at: number; cpuPct: number; memUsedGb: number; runningAgents: number } | null;
};

/** Every instance chart's points, from the recorded history plus the live reading. The header stats
 *  and the charts once disagreed for two reasons: the header read the live poll (every 15s) while the
 *  chart's newest point was the history's (every 60s, up to a minute older), and `downsample` made
 *  that point the MEAN of its bucket (at 7d, ~34 minutes of samples). Here the live reading, when it
 *  is newer, becomes the newest sample, and the newest sample is kept raw as every series' last point
 *  — so `latest` (the header) and the last point are the same reading. Disk skips samples with no
 *  reading (a `df` that failed) rather than drawing them as 0. */
export function instanceSeries(history: VitalSample[], live: VitalSample | null | undefined, from: number, to: number, max = 300): InstanceSeries {
  const samples = history.filter((p) => p.at >= from && p.at <= to);
  const last = samples[samples.length - 1];
  if (live && live.at <= to && (!last || live.at > last.at)) samples.push({ ...live, oomKills: 0 });
  if (!samples.length) return { cpu: [], mem: [], agents: [], disk: [], ooms: [], latest: null };
  const series = (pts: Pt[]) => pts.length ? [...downsample(pts.slice(0, -1), max - 1, from, to), pts[pts.length - 1]!] : [];
  const newest = samples[samples.length - 1]!;
  return {
    cpu: series(samples.map((p) => ({ at: p.at, v: p.cpuPct }))),
    mem: series(samples.map((p) => ({ at: p.at, v: p.memUsedGb }))),
    agents: series(samples.map((p) => ({ at: p.at, v: p.runningAgents ?? 0 }))),
    disk: series(samples.flatMap((p) => (p.diskUsedGb == null ? [] : [{ at: p.at, v: p.diskUsedGb }]))),
    ooms: samples.flatMap((p) => (p.oomKills ? [{ at: p.at, n: p.oomKills }] : [])),
    latest: { at: newest.at, cpuPct: newest.cpuPct, memUsedGb: newest.memUsedGb, runningAgents: newest.runningAgents ?? 0 },
  };
}

// ---- the machine's uptime ledger (what EC2 bills) ----
// EC2 bills per second while the instance RUNS, whatever Orca is doing. So the month's cost counts
// from the KERNEL's boots (`instance_boot`: one row per boot_id, its boot time and the last time it
// was seen alive — backfilled from `journalctl --list-boots`, heartbeated by the metrics sampler),
// never from Orca's own samples, which stop whenever the bridge is down, hung or redeploying and
// are pruned after a month.

/** One kernel boot of one machine: from `bootedAt` to the last moment it was seen up. */
export type BootSpan = { bootId: string; bootedAt: number; lastSeen: number };

/** A gap between two boots no longer than this is a REBOOT — EC2 keeps an instance running (and
 *  billing) through one, and a reboot takes about a minute (the box's 2026-10-13 one: 36s). A longer
 *  gap is presumably a STOP, which doesn't bill — but without AWS nobody here can tell a stop from a
 *  kernel that hung silent for a while, so it is counted as down and reported as UNKNOWN (the
 *  card's range). The edges are the journal's first/last entry of each boot, so the gap is the time
 *  the kernel itself was gone, not the time Orca was. */
export const REBOOT_GAP_MS = 10 * 60_000;

export type BilledUptime = {
  /** Billed ms in [from, now): every boot, plus the reboots between them, plus `assumedMs`. */
  billedMs: number;
  /** Of `billedMs`: time before the ledger's first boot, after the configured billing start —
   *  assumed running because the config says the machine was billing then. */
  assumedMs: number;
  /** NOT billed but uncertain: gaps between boots over `REBOOT_GAP_MS` (a stop, or a long silent
   *  hang), and — with no billing start configured — the month before the ledger's first boot. */
  unknownMs: number;
  /** The ledger's first boot, or null with no boots at all. */
  ledgerFrom: number | null;
};

/** The billed time in [from, now) from a machine's boots. `currentBootId` (the machine answering)
 *  is up right now, so its span runs to `now` however stale its heartbeat — an Orca that hung for an
 *  hour loses nothing. `billingSince`: when the machine started billing (its launch), so nothing
 *  before it counts and the time from it to the ledger's first boot is assumed running. Overlapping
 *  spans (a boot seen under two ids) are merged, never counted twice. Pure. */
export function billedUptime(boots: BootSpan[], o: { from: number; now: number; currentBootId?: string; billingSince?: number }): BilledUptime {
  const { now } = o;
  const from = Math.max(o.from, o.billingSince ?? -Infinity);
  const clip = (a: number, b: number) => Math.max(0, Math.min(b, now) - Math.max(a, from));
  const spans = boots
    .map((b) => ({ a: b.bootedAt, b: b.bootId === o.currentBootId ? Math.max(now, b.lastSeen) : Math.max(b.bootedAt, b.lastSeen) }))
    .sort((x, y) => x.a - y.a);
  const merged: { a: number; b: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.a <= last.b) last.b = Math.max(last.b, s.b); else merged.push({ ...s });
  }
  let billedMs = 0, unknownMs = 0, assumedMs = 0;
  merged.forEach((s, i) => {
    billedMs += clip(s.a, s.b);
    const next = merged[i + 1];
    if (!next) return;
    const gap = clip(s.b, next.a);
    if (next.a - s.b <= REBOOT_GAP_MS) billedMs += gap; else unknownMs += gap;
  });
  const first = merged[0]?.a ?? now;
  if (o.billingSince !== undefined) assumedMs = clip(o.billingSince, first);
  else unknownMs += clip(from, first);
  return { billedMs: billedMs + assumedMs, assumedMs, unknownMs, ledgerFrom: merged[0]?.a ?? null };
}

/** `journalctl --list-boots -o json` → boots: each boot's first and last journal entry (µs since
 *  the epoch) as its span, the id without hyphens (`/proc/sys/kernel/random/boot_id` has them —
 *  `bootKey` makes both one key). Anything unparseable is skipped. Pure. */
export function journalBoots(json: string): BootSpan[] {
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const { boot_id, first_entry, last_entry } = (r ?? {}) as Record<string, unknown>;
    if (typeof boot_id !== "string" || typeof first_entry !== "number" || typeof last_entry !== "number") return [];
    return [{ bootId: bootKey(boot_id), bootedAt: Math.round(first_entry / 1000), lastSeen: Math.round(last_entry / 1000) }];
  });
}

/** One spelling of a boot id, whichever source read it. */
export const bootKey = (id: string): string => id.trim().replace(/-/g, "").toLowerCase();

export type MonthCostInfo = { usd: number; upHours: number; unknownHours?: number; assumedHours?: number; usdMax?: number; ledgerFrom?: number | null; billingSince?: number };

const hrs = (h: number) => `${Math.round(h * 10) / 10} h`;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The instance card's Cost cell: this month's cost, and how it was reached (its tooltip): the
 *  rate, the billed hours from the boot ledger, what was assumed and what is unknown — `*` on the
 *  value when some hours are unknown, the tooltip giving the figure if they were billed. Pure. */
export function monthCostLabel(month: MonthCostInfo | undefined, rate: { hourlyUsd: number; source: string; instanceType?: string } | undefined): { value: string; detail: string } | null {
  if (!month || !rate || !(rate.hourlyUsd > 0)) return null;
  const r = rate.hourlyUsd;
  const est = rate.source === "estimate" ? ` est.${rate.instanceType ? ` (${rate.instanceType})` : ""}` : "";
  const lines = [`$${r.toFixed(r >= 0.1 ? 2 : 3)}/h${est} × ${hrs(month.upHours)} up this month (UTC), from the machine's boot ledger`];
  if (month.ledgerFrom) lines.push(`Ledger from ${day(month.ledgerFrom)}${month.billingSince ? `; billing since ${day(month.billingSince)}` : ""}`);
  if (month.assumedHours) lines.push(`${hrs(month.assumedHours)} before the ledger assumed running (billing start in config)`);
  const unknown = month.unknownHours ?? 0;
  if (unknown >= 0.05) lines.push(`${hrs(unknown)} unknown — counted as stopped; $${(month.usdMax ?? month.usd).toFixed(2)} if the machine was running`);
  return { value: `$${month.usd.toFixed(2)}${unknown >= 0.05 ? "*" : ""}`, detail: lines.join("\n") };
}

/** The agents axis's top: a small whole count, even so its midpoint tick is whole too (0 · 2 · 4). */
export function countMax(v: number): number {
  return Math.max(2, Math.ceil(Math.max(0, v) / 2) * 2);
}

/** A round axis maximum at or above `v`: 1, 2, 2.5 or 5 × 10^k. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * exp >= v) ?? 10) * exp;
}

/** `n` evenly spaced x-axis labels across [from, to]: clock time within a day, the date beyond; the
 *  right edge is "now" (a 24h axis would otherwise read the same clock time at both ends). */
export function timeTicks(from: number, to: number, n = 4): { at: number; label: string }[] {
  const span = to - from;
  return Array.from({ length: n }, (_, i) => {
    const at = from + (span * i) / (n - 1);
    if (i === n - 1) return { at, label: "now" };
    const d = new Date(at);
    const label = span > 36 * 3_600_000
      ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return { at, label };
  });
}

/** "44s", "1m 12s", "2h 5m" — Vercel's duration column. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** How long the agent has been at it (running) or took (its last turn). Undefined when unknown. */
export function rowDuration(row: Pick<OverviewRow, "agentStatus" | "agentStartedAt" | "transcript">, now = Date.now()): number | undefined {
  if (row.agentStatus === "running" && row.agentStartedAt) return now - row.agentStartedAt;
  const last = row.transcript?.[row.transcript.length - 1];
  return last?.startedAt && last.finishedAt ? last.finishedAt - last.startedAt : undefined;
}

export type RepoSummary = { repo: string; total: number; running: number; attention: number; openPrs: number; local: number; mergedToday: number; lastActivity: number };

/** One line per configured repo for the Repos page — the overview's numbers, scoped. */
export function repoSummaries(rows: OverviewRow[], repos: string[]): RepoSummary[] {
  return repos.map((repo) => {
    const mine = rows.filter((r) => r.repo === repo);
    const s = overviewStats(mine);
    return {
      repo, total: mine.length, running: s.running, attention: s.attention, openPrs: s.prs.total, local: s.local, mergedToday: s.mergedToday,
      lastActivity: Math.max(0, ...mine.map(lastActivity)),
    };
  });
}

/** What the agent page's Details card puts in its red box, Vercel's "Build Failed": the run's error,
 *  or Orca's check failing on the commit — the run's own failure first. Undefined when neither. */
export function agentFailure(row: { agentStatus?: string; agentError?: string; agentCheck?: TurnCheck }): { title: string; detail: string } | undefined {
  if (row.agentStatus === "error") return { title: "Run failed", detail: row.agentError?.trim() || "The agent exited with an error." };
  if (row.agentCheck && !row.agentCheck.ok) {
    const tail = row.agentCheck.output.trim().split("\n").slice(-12).join("\n");
    return { title: "Check failed", detail: `Command "${row.agentCheck.command}" exited with ${row.agentCheck.exitCode}${tail ? `\n\n${tail}` : ""}` };
  }
  return undefined;
}

// ---- the Agents page's quick filters ----
// One-click chips above the list, Vercel's filter row: toggleable and combinable — AND across
// groups, OR within one (local OR cloud, Open PRs OR Merged today) — and kept in the URL query so a
// filtered view is a link. Each chip shows how many rows it would show with the other groups' chips.

export type QuickFilter = {
  status: ("attention" | "running")[];
  pr: ("open" | "mergeable" | "merged")[];
  by: ("mine" | "orchestrated")[];
  on: string[];
  repo: string[];
  notMerged: boolean; // default ON: hide merged workstreams unless the "merged" pr chip asks for them
};
export type QuickGroup = Exclude<keyof QuickFilter, "notMerged">;
// The identity element for the URL round-trip: a plain `/agents` has no query, so parsing "" must
// produce exactly this — which is why notMerged defaults true here, not false.
export const NO_QUICK_FILTER: QuickFilter = { status: [], pr: [], by: [], on: [], repo: [], notMerged: true };
export const QUICK_GROUPS: QuickGroup[] = ["status", "pr", "by", "on", "repo"];
const QUICK_VALUES: Partial<Record<QuickGroup, readonly string[]>> = {
  status: ["attention", "running"], pr: ["open", "mergeable", "merged"], by: ["mine", "orchestrated"],
};

/** `?status=attention&on=cloud,local` → the filter. Unknown values are dropped, so a stale link is
 *  merely less filtered, never broken. `notMerged` is omitted from the query when it's at its
 *  default (true), so a bare URL still means "not merged" is on. */
export function parseQuickFilter(search: string): QuickFilter {
  const params = new URLSearchParams(search);
  const out: QuickFilter = { status: [], pr: [], by: [], on: [], repo: [], notMerged: true };
  for (const g of QUICK_GROUPS) {
    const values = [...new Set((params.get(g) ?? "").split(",").map((v) => v.trim()).filter(Boolean))];
    const allowed = QUICK_VALUES[g];
    (out[g] as string[]) = allowed ? values.filter((v) => allowed.includes(v)) : values;
  }
  if (params.has("notMerged")) out.notMerged = params.get("notMerged") !== "0";
  return out;
}

/** The filter as a query string ("" when nothing is on), groups in a fixed order so a link is stable. */
export function quickFilterQuery(f: QuickFilter): string {
  const parts = QUICK_GROUPS.filter((g) => f[g].length).map((g) => `${g}=${f[g].map(encodeURIComponent).join(",")}`);
  if (!f.notMerged) parts.push("notMerged=0"); // only carried when it differs from the default (on)
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Flip one chip on or off. */
export function toggleQuick(f: QuickFilter, group: QuickGroup, value: string): QuickFilter {
  const has = (f[group] as string[]).includes(value);
  return { ...f, [group]: has ? (f[group] as string[]).filter((v) => v !== value) : [...(f[group] as string[]), value] };
}

/** Flip the "Not merged" toggle. */
export function toggleNotMerged(f: QuickFilter): QuickFilter {
  return { ...f, notMerged: !f.notMerged };
}

function matchesChip(row: OverviewRow, group: QuickGroup, value: string, here?: string): boolean {
  switch (group) {
    case "status": return value === "running" ? row.agentStatus === "running" : attentionReasons(row).length > 0;
    case "pr": return value === "merged" ? row.lane === "DONE" : value === "mergeable" ? row.lane === "MERGEABLE" : Boolean(row.prNumber) && row.lane !== "DONE";
    case "by": return value === "orchestrated" ? Boolean(row.orchestrated) : !row.orchestrated;
    case "on": return rowInstance(row, here) === value;
    case "repo": return row.repo === value;
  }
}

// `notMerged` hides merged (DONE) rows unless the pr group explicitly asks for them ("Merged
// today") — otherwise the default-on toggle would make that chip permanently empty. When probing
// the pr group's own chips (skip === "pr", from quickCount), the exclusion is suspended entirely:
// it only ever matches a DONE row through the "merged" value anyway, so this is a no-op for the
// other pr values and exactly what's needed for "merged"'s own count. `skip === "notMerged"` (from
// notMergedCount) suspends it too, for the same reason `quickCount` skips a chip's OWN group: the
// count must not depend on whether the toggle it's labelling happens to be on or off right now.
type PassesSkip = QuickGroup | "notMerged";
const passes = (row: OverviewRow, f: QuickFilter, here: string | undefined, skip?: PassesSkip) => {
  if (skip !== "pr" && skip !== "notMerged" && f.notMerged && !f.pr.includes("merged") && row.lane === "DONE") return false;
  return QUICK_GROUPS.every((g) => g === skip || !f[g].length || (f[g] as string[]).some((v) => matchesChip(row, g, v, here)));
};

export function applyQuickFilter<R extends OverviewRow>(rows: R[], f: QuickFilter, here?: string): R[] {
  return rows.filter((r) => passes(r, f, here));
}

/** A chip's count: the rows it matches among those the OTHER groups' chips let through — so it says
 *  what turning it on (alone in its group) would show. */
export function quickCount(rows: OverviewRow[], f: QuickFilter, group: QuickGroup, value: string, here?: string): number {
  return rows.filter((r) => passes(r, f, here, group) && matchesChip(r, group, value, here)).length;
}

/** The "Not merged" chip's count: the number of NOT merged workstreams — rows that pass every
 *  OTHER active group's chips (status/pr/by/on/repo, exactly as currently selected) and aren't
 *  DONE, the same question `quickCount` answers for a real chip, with the toggle's own effect (the
 *  `notMerged` exclusion above) ignored so the count doesn't flip depending on whether it's
 *  currently on or off. */
export function notMergedCount(rows: OverviewRow[], f: QuickFilter, here?: string): number {
  return rows.filter((r) => passes(r, f, here, "notMerged") && r.lane !== "DONE").length;
}

export const quickActive = (f: QuickFilter): boolean => QUICK_GROUPS.some((g) => f[g].length > 0) || !f.notMerged;

// ---- the Agents list's columns ----
// Only what you act on: the workstream, its run status, the PR (state + number), checks and the
// review signal, and the actions. The latest instruction, branch and model went into the title's
// subline and tooltip, the PR # into the state cell, and the per-row repo icon was dropped (the
// repo is in the subline). The instance column was dropped too — it's a row menu action ("Move to
// …") and a tooltip, not something worth a whole column — and the width it held goes to the
// flexible tracks (workstream, signals) via their own `grow`. Each column has a floor in rem; the
// flexible ones share what is left, so the row never needs a horizontal scroll.
export type ListColumn = { key: "workstream" | "status" | "pr" | "signals" | "actions"; label: string; minRem: number; grow?: number };
export function listColumns(): ListColumn[] {
  return [
    { key: "workstream", label: "Workstream", minRem: 10, grow: 2 },
    { key: "status", label: "Status", minRem: 8.5 },
    { key: "pr", label: "PR", minRem: 8.5 },
    { key: "signals", label: "Checks & review", minRem: 6, grow: 1 },
    // Fixed, wide enough for the row's quick-action icons (two at most — quickActions never applies
    // more to one state), the local preview link + its Stop and the ⋯ menu, all size-7 at gap-1, so
    // the column never shifts between states and nothing overflows into a sideways scroll. The PR-preview icon that used to
    // sit here moved to a text link next to the model name (PrPreviewInline) — the ⋯ menu's PR
    // submenu still carries Open/Add PR preview.
    { key: "actions", label: "Actions", minRem: 10 },
  ];
}
/** The CSS grid-template-columns for a column set: fixed floors, `minmax(floor, Nfr)` for the flexible. */
export const listGridTemplate = (cols: ListColumn[]): string =>
  cols.map((c) => (c.grow ? `minmax(${c.minRem}rem,${c.grow}fr)` : `${c.minRem}rem`)).join(" ");
/** The row's gap (gap-x-3) and horizontal padding (px-4) in px — kept in step with the row's classes. */
export const LIST_GAP_PX = 12, LIST_PAD_PX = 32;
/** The narrowest a row can be before it would overflow: every floor, every gap, the padding. */
export const listMinWidth = (cols: ListColumn[], remPx = 16): number =>
  cols.reduce((n, c) => n + c.minRem * remPx, 0) + LIST_GAP_PX * (cols.length - 1) + LIST_PAD_PX;
/** What the shell takes off the viewport beside the list: the expanded sidebar (w-60), main's px-6
 *  on both sides, the card's 1px border on both sides. */
export const LIST_CHROME_PX = 240 + 48 + 2;
export const listFits = (cols: ListColumn[], viewportPx: number): boolean => listMinWidth(cols) <= viewportPx - LIST_CHROME_PX;

/** A running agent's live elapsed time, clock-style so the width holds still as it ticks:
 *  "0:07", "12:05", "1:02:03". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** A row's model as a readable label (never initials): what its last run reported (`agentMeta.model`,
 *  already prettified — "Opus 5.5", "Codex") else the pinned model's catalog name. The tooltip spells
 *  out the provider and, when they differ, the model the next run will use. */
export function modelBadge(ran: string | undefined, pinned: string | undefined): { label: string; title: string } | undefined {
  const pinnedLabel = pinned ? (MODELS.find((m) => m.id === pinned)?.label ?? prettyModel(pinned)) : undefined;
  const label = ran ?? pinnedLabel;
  if (!label) return undefined;
  const next = pinned ? modelLabel(pinned) : undefined;
  const title = ran
    ? `Last run on ${ran}${next && pinnedLabel !== ran ? ` · next run: ${next}` : ""}`
    : `Model: ${next}`;
  return { label, title };
}

// ---- Action failures (an `action_failed` notification's text — lib/notificationStore `actionFailed`; a button's ✗ tooltip is `firstLine`) ----

/** A failed action on a workstream: which verb, on what, and GitHub's/the bridge's own message. */
export type ActionFailure = { action: string; title?: string; repo: string; branch: string; prNumber?: number; error: string };

/** What Copy puts on the clipboard: the message plus where it happened, ready to paste anywhere. */
export function actionFailureCopy(f: ActionFailure): string {
  return [
    `Action: ${f.action}`, `Repo: ${f.repo}`, `Branch: ${f.branch}`,
    ...(f.prNumber ? [`PR: #${f.prNumber}`] : []),
    `Error:`, f.error,
  ].join("\n");
}

/** What "Ask the orchestrator" prefills in its composer — one message it can act on. */
export function actionFailureAsk(f: ActionFailure): string {
  return `Action ${f.action} on ${f.repo}/${f.branch}${f.prNumber ? ` (PR #${f.prNumber})` : ""} failed: ${f.error}. Please investigate and fix.`;
}

/** The overlay an installed app's home-screen shortcut asks for (`/?open=new`, `/?open=orchestrator`,
 *  web/public/manifest.webmanifest), or null. Pure. */
export function launchOverlay(search: string): "new" | "orchestrator" | null {
  const v = new URLSearchParams(search).get("open");
  return v === "new" || v === "orchestrator" ? v : null;
}

// ---- touch gestures (lib/gestures.ts): the thresholds, pure ----

/** A swipe down on a sheet's handle: close when dragged a quarter of the sheet (at most 120px), or
 *  flicked — 40px+ at more than 0.6px/ms. Anything less springs back. */
export function swipeDecision(g: { dy: number; ms: number; height: number }): "close" | "snap" {
  if (g.dy >= Math.min(120, g.height * 0.25)) return "close";
  return g.dy >= 40 && g.dy / Math.max(1, g.ms) > 0.6 ? "close" : "snap";
}

/** The edge a drawer comes from; it is dismissed by a swipe back toward that edge — a bottom sheet
 *  down, a left drawer left, a right drawer right. */
export type SwipeEdge = "bottom" | "left" | "right";
/** How far a finger moved by (dx, dy) has carried the drawer toward its edge (never negative). */
export function swipeOffset(edge: SwipeEdge, dx: number, dy: number): number {
  return Math.max(0, edge === "bottom" ? dy : edge === "left" ? -dx : dx);
}
/** Movement under this many px is a tap's wobble: no verdict yet. */
export const SWIPE_SLOP_PX = 8;
/** Whether a touch on a drawer's scrolling body becomes its dismiss drag: "wait" inside the slop,
 *  "drag" when the move is mostly along the dismiss axis toward the edge AND the content is at its
 *  start (`atStart`: scrolled to the top for a bottom sheet), else "scroll" — the content's own pan. */
export function swipeArm(g: { edge: SwipeEdge; dx: number; dy: number; atStart: boolean }): "wait" | "drag" | "scroll" {
  const along = g.edge === "bottom" ? g.dy : g.edge === "left" ? -g.dx : g.dx;
  const across = g.edge === "bottom" ? g.dx : g.dy;
  if (Math.max(Math.abs(along), Math.abs(across)) < SWIPE_SLOP_PX) return "wait";
  if (along <= 0 || Math.abs(across) >= Math.abs(along) || !g.atStart) return "scroll";
  return "drag";
}

/** Pull to refresh: how far the finger has pulled (from the top of the page) → what the indicator
 *  shows and how tall it is (damped, capped). Past PULL_REFRESH_PX, letting go refreshes. */
export const PULL_REFRESH_PX = 70;
export function pullState(dy: number): { phase: "idle" | "pull" | "release"; offset: number } {
  if (dy < 10) return { phase: "idle", offset: 0 };
  return { phase: dy * 0.5 >= PULL_REFRESH_PX ? "release" : "pull", offset: Math.min(Math.round(dy * 0.5), 96) };
}

// ---- notification quick actions ----

/** What a notification's quick-action row can do. The component maps each id to the existing handler
 *  (store.addressPr, followUp, testLocally, stopPreview, navigation) — none of the logic is here. */
export type NotificationActionId =
  | "address" | "viewPr" | "fix" | "viewOutput" | "open" | "reply" | "retry" | "openChat"
  | "openPreview" | "stopPreview" | "retryPreview" | "viewLog" | "openOrchestrator" | "ask" | "copy" | "undo";
export type NotificationActionSpec = { id: NotificationActionId; label: string; primary?: boolean };

/** What the live row behind a notification makes possible: an agent verb needs the row, View PR its
 *  GitHub URL, Fix a failed check to hand over, Stop a running preview's key. */
export type NotificationActionContext = { row?: boolean; prUrl?: boolean; failedCheck?: boolean; previewKey?: boolean };

type ActionRule = { id: NotificationActionId; label: string; needs?: keyof NotificationActionContext };
const NOTIFICATION_ACTION_RULES: Record<string, ActionRule[]> = {
  pr_ci_failed: [{ id: "address", label: "Address PR", needs: "row" }, { id: "viewPr", label: "View PR", needs: "prUrl" }],
  pr_conflicts: [{ id: "address", label: "Address PR", needs: "row" }, { id: "viewPr", label: "View PR", needs: "prUrl" }],
  check_failed: [{ id: "fix", label: "Fix", needs: "failedCheck" }, { id: "viewOutput", label: "View output" }],
  finished: [{ id: "reply", label: "Reply" }],
  needs_input: [{ id: "reply", label: "Reply" }],
  failed: [{ id: "retry", label: "Retry", needs: "row" }, { id: "openChat", label: "Open chat" }],
  stopped: [{ id: "retry", label: "Retry", needs: "row" }, { id: "openChat", label: "Open chat" }],
  preview_ready: [{ id: "openPreview", label: "Open preview" }, { id: "stopPreview", label: "Stop", needs: "previewKey" }],
  preview_failed: [{ id: "retryPreview", label: "Retry test", needs: "row" }, { id: "viewLog", label: "View log" }],
  merged: [{ id: "viewPr", label: "View PR", needs: "prUrl" }],
  merge_refused: [{ id: "viewPr", label: "View PR", needs: "prUrl" }],
  auto_address: [{ id: "viewPr", label: "View PR", needs: "prUrl" }],
  upkeep_gave_up: [{ id: "address", label: "Address PR", needs: "row" }, { id: "viewPr", label: "View PR", needs: "prUrl" }],
  // A failed action (a local notification): hand it to the orchestrator, or copy the message and
  // where it happened — each only when the notification carries its text.
  action_failed: [{ id: "ask", label: "Ask the orchestrator" }, { id: "copy", label: "Copy" }],
  // A just-sent draft (also local): Undo while it's still fresh.
  draft_sent: [{ id: "undo", label: "Undo" }],
};

/** A notification's quick actions: up to two for its kind, then ALWAYS Open, last — so every toast
 *  and centre row has it in the same place, labelled just "Open": the workstream's Chat tab, or the
 *  orchestrator's panel for its own wake (which has nothing else; Reply there would be the same window). The first action is
 *  the primary. An action whose prerequisite is missing (no live row, no PR URL, no failed check) is
 *  left out rather than shown broken; an unknown kind gets only Open. There is no Read: taking any
 *  action marks it read, and the card's own × (not listed here) is "read, and out of view". */
export function notificationActions(
  n: { kind: string; link?: { url?: string; orchestrator?: boolean }; ask?: string; copy?: string; onUndo?: () => void },
  ctx: NotificationActionContext = {},
): NotificationActionSpec[] {
  const open: ActionRule = n.link?.orchestrator ? { id: "openOrchestrator", label: "Open" } : { id: "open", label: "Open" };
  const has = { ...ctx } as Record<string, boolean | undefined>;
  const rules = n.link?.orchestrator ? [] : (NOTIFICATION_ACTION_RULES[n.kind] ?? [])
    .filter((r) => (r.id === "openPreview" ? Boolean(n.link?.url) : r.id === "ask" || r.id === "copy" ? Boolean(n[r.id]) : r.id === "undo" ? Boolean(n.onUndo) : !r.needs || has[r.needs]))
    .slice(0, 2);
  return [...rules, open].map((r, i) => ({ id: r.id, label: r.label, ...(i === 0 ? { primary: true } : {}) }));
}

/** What Retry sends: a follow-up on the same session, picking up where the run stopped. */
export const RETRY_INSTRUCTION = "Continue where you left off.";

// ---- chat pagination: pure pieces of ChatPanel's paging and scroll anchoring ----

/** How many turns a chat loads at a time: the newest page on open, one more each time you reach
 *  the top. The orchestrator's conversation runs to hundreds of turns, nearly all of them old. */
export const TURN_PAGE_SIZE = 50;

/** What `/api/turns?limit=` answered, as a page. A bridge from before paging ignores `limit` and
 *  sends the whole conversation as a plain array (a preview's Vite proxy points at the main
 *  checkout's bridge; a deploy window has one side ahead of the other): that is the page, with
 *  nothing older. Anything else malformed is an empty page rather than a crash mid-render. */
export function asTurnPage<T>(body: unknown): { turns: T[]; older: string | null } {
  if (Array.isArray(body)) return { turns: body as T[], older: null };
  const page = body as { turns?: unknown; older?: unknown } | null;
  if (!page || !Array.isArray(page.turns)) return { turns: [], older: null };
  return { turns: page.turns as T[], older: typeof page.older === "string" ? page.older : null };
}

/** Turns identify by run id; a re-fetched page replaces what it covers and keeps what it doesn't. */
type Keyed = { id: string };

/** The conversation after the NEWEST page is re-fetched (a turn started or finished): everything
 *  already loaded that the fresh page doesn't carry stays in front of it — the older pages you
 *  scrolled back through aren't thrown away by a refresh — and a turn the page re-delivers (now
 *  finished, with its steps) takes its fresh form. */
export function mergeLatestPage<T extends Keyed>(loaded: T[], latest: T[]): T[] {
  const fresh = new Set(latest.map((t) => t.id));
  return [...loaded.filter((t) => !fresh.has(t.id)), ...latest];
}

/** The optimistic "sending…" messages a chat still has to draw: those the bridge has not yet recorded
 *  as an UNFINISHED turn's message (one of the messages a wake carried — `splitMessages`) or a queued
 *  entry. Prefix match: attachments are appended to the stored text. A finished turn never matches,
 *  so the same line sent twice still shows the second time. Drawing both would show the text twice. */
export function unlandedSends<M extends { text: string }>(
  sending: M[], turns: { finishedAt?: number; instruction?: string }[] | null, queued: { instruction: string }[],
): M[] {
  const recorded = [
    ...(turns ?? []).filter((t) => !t.finishedAt && t.instruction).flatMap((t) => splitMessages(t.instruction!)),
    ...queued.map((m) => m.instruction),
  ];
  return sending.filter((m) => !recorded.some((r) => r.startsWith(m.text)));
}

/** The queued entries a chat still has to draw: those no turn has delivered yet. A turn delivers an
 *  entry when it started at or after the entry was queued and carries its text as one of its
 *  messages (`splitMessages`, attachment list dropped). The queue is a separate read from the turns,
 *  so a slow or missed read (a stream reconnect, an answer that landed out of order) once left a
 *  delivered message drawn twice — in the chat and as queued — until a refresh. A turn from before
 *  the entry never matches, so the same line queued again still shows. */
export function undeliveredQueued<Q extends { instruction: string; createdAt: number }>(
  queued: Q[], turns: { startedAt?: number; instruction?: string }[] | null,
): Q[] {
  const norm = (s: string) => withoutAttachmentList(s).trim();
  const after = (turns ?? []).filter((t) => t.instruction);
  return queued.filter((q) => !after.some((t) =>
    (t.startedAt ?? 0) >= q.createdAt && splitMessages(t.instruction!).some((m) => norm(m) === norm(q.instruction))));
}

/** The composer's ↑ history for one chat: every message YOU sent in it, newest first, each once
 *  (its most recent send wins the position). Read off what the chat already holds — the loaded
 *  turns' instructions (split per message, attachment list dropped), then the bridge's queue, then
 *  the optimistic "sending…" outbox — so it is the server transcript, not this tab's session, and a
 *  message sent from anywhere (quick-ask, the palette, a toast) is in it. Worker reports and Orca's
 *  own autofix instruction are not yours, so they are left out. */
export function composerHistory(
  turns: { instruction?: string; prompt?: string }[] | null,
  queued: { instruction: string }[] = [],
  sending: { text: string }[] = [],
): string[] {
  const sent = [
    ...(turns ?? []).flatMap((t) => splitMessages(t.instruction ?? promptInstruction(t.prompt ?? ""))),
    ...queued.map((m) => m.instruction),
    ...sending.map((m) => m.text),
  ].map((m) => withoutAttachmentList(m).trim())
    .filter((m) => m && !isWorkerEvent(m) && !m.startsWith(AUTOFIX_MARKER));
  return [...new Set(sent.reverse())];
}

/** What an arrow key in the composer means for history, or null to leave it to the textarea. Like a
 *  terminal: ↑ recalls only with the caret on the FIRST line (an empty box qualifies), ↓ only on the
 *  LAST line — anywhere else they move the caret a line. Never with a selection, an open menu (the @
 *  picker owns the arrows), mid-IME composition, or a modifier held.
 *  A logical line with no "\n" can still be several VISUAL rows once it soft-wraps — the caret can
 *  sit on its second or third row while `value.slice(0, selectionStart)` still has no "\n" in it, so
 *  that check alone isn't enough: `box.firstVisualRow` / `lastVisualRow` carry what the textarea's own
 *  layout says (measured by the caller, which has the real DOM; undefined — no measurement, or a line
 *  that can't wrap — leaves the "\n" check as the whole answer). */
export function historyKey(
  key: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean },
  box: { value: string; selectionStart: number; selectionEnd: number; menuOpen?: boolean; firstVisualRow?: boolean; lastVisualRow?: boolean },
): "up" | "down" | null {
  if (key.key !== "ArrowUp" && key.key !== "ArrowDown") return null;
  if (key.shiftKey || key.altKey || key.ctrlKey || key.metaKey || key.isComposing || box.menuOpen) return null;
  if (box.selectionStart !== box.selectionEnd) return null;
  if (key.key === "ArrowUp") {
    if (box.value.slice(0, box.selectionStart).includes("\n")) return null;
    return box.firstVisualRow === false ? null : "up";
  }
  if (box.value.slice(box.selectionEnd).includes("\n")) return null;
  return box.lastVisualRow === false ? null : "down";
}

/** Where a history walk stands: `idx` into the newest-first list (null = your own draft), and the
 *  draft as it was when the walk began, so walking back down past the newest gives it back exactly. */
export type HistoryWalk = { idx: number | null; draft: string };
export const NO_WALK: HistoryWalk = { idx: null, draft: "" };
/** One step of the walk: the new position and the text the box should hold, or null when there is
 *  nowhere to go (↑ at the oldest, ↓ while not walking) — the key is then the textarea's. An edit to
 *  a recalled message is sent as edited; stepping away from it drops the edit (as Claude Code does),
 *  but never the draft. */
export function historyStep(walk: HistoryWalk, dir: "up" | "down", history: string[], value: string): { walk: HistoryWalk; text: string } | null {
  if (dir === "up") {
    const idx = walk.idx === null ? 0 : walk.idx + 1;
    if (idx >= history.length) return null;
    return { walk: { idx, draft: walk.idx === null ? value : walk.draft }, text: history[idx]! };
  }
  if (walk.idx === null) return null;
  if (walk.idx === 0) return { walk: NO_WALK, text: walk.draft };
  return { walk: { ...walk, idx: walk.idx - 1 }, text: history[walk.idx - 1]! };
}

/** An older page arrives: it goes in front of what's loaded, minus anything already there (a turn
 *  that moved between the two fetches, or a page requested twice). */
export function prependOlderPage<T extends Keyed>(older: T[], loaded: T[]): T[] {
  const have = new Set(loaded.map((t) => t.id));
  return [...older.filter((t) => !have.has(t.id)), ...loaded];
}

/** Where the scroller must sit so the turn you were reading stays put after content was added ABOVE
 *  it: the old offset plus however much taller the content got. */
export const anchoredScrollTop = (prevScrollTop: number, prevScrollHeight: number, nextScrollHeight: number): number =>
  prevScrollTop + (nextScrollHeight - prevScrollHeight);

/** Is a scroll position "at the bottom" — within `slack` px of it — i.e. still following the tail? */
export const atBottom = (scrollTop: number, scrollHeight: number, clientHeight: number, slack: number): boolean =>
  scrollHeight - scrollTop - clientHeight < slack;

// ---- the chat's mounted window and compact history (ChatPanel) ----
// Paging bounds what is FETCHED; this bounds what is MOUNTED. A long conversation scrolled back
// through is hundreds of markdown turns in the DOM — the "bloated" orchestrator chat — so only a window
// of CHAT_WINDOW turns renders. Turns outside it stay loaded (they're text) but unmounted, and come
// back as you scroll toward them. Like Slack's and Linear's long threads, the window moves with you:
// revealing turns on one side and trimming the far side, never both edges in one commit, so the
// scroll anchor (anchoredScrollTop: a height delta above the viewport) stays exact.

/** The most turns a chat keeps mounted: two pages. */
export const CHAT_WINDOW = 2 * TURN_PAGE_SIZE;
/** The mounted turns, by run id: `first` null = from the oldest loaded, `last` null = through the
 *  newest (following the tail). `dir` is the way it last moved — the cap trims the OTHER side. */
export type TurnWindow = { first: string | null; last: string | null; dir: "up" | "down" };
export const TAIL_WINDOW: TurnWindow = { first: null, last: null, dir: "down" };

/** The window as indices into the loaded turns, [start, end). An id no longer loaded reads as open. */
export function windowRange(turns: Keyed[], w: TurnWindow): { start: number; end: number } {
  const at = (id: string | null) => (id === null ? -1 : turns.findIndex((t) => t.id === id));
  const f = at(w.first), l = at(w.last);
  const start = f < 0 ? 0 : f;
  return { start, end: l < 0 ? turns.length : Math.max(start, l + 1) };
}

/** Over the cap: trim the side away from the last move (moving up drops the newest mounted, moving
 *  down — or following new output — drops the oldest). Null when within it. */
export function capWindow(turns: Keyed[], w: TurnWindow, cap = CHAT_WINDOW): TurnWindow | null {
  const { start, end } = windowRange(turns, w);
  if (end - start <= cap) return null;
  return w.dir === "up" ? { ...w, last: turns[start + cap - 1]!.id } : { ...w, first: turns[end - cap]!.id };
}

/** Bring `step` more loaded turns into the window above / below it. */
export function revealAbove(turns: Keyed[], w: TurnWindow, step = TURN_PAGE_SIZE): TurnWindow {
  const s = Math.max(0, windowRange(turns, w).start - step);
  return { ...w, first: s === 0 ? null : turns[s]!.id, dir: "up" };
}
export function revealBelow(turns: Keyed[], w: TurnWindow, step = TURN_PAGE_SIZE): TurnWindow {
  const e = windowRange(turns, w).end + step;
  return { ...w, last: e >= turns.length ? null : turns[e - 1]!.id, dir: "down" };
}

/** How many of the newest turns render in full; older ones render compact (first lines + Show more). */
export const RECENT_FULL = 3;
/** A reply worth collapsing when old: more than a few lines, or a structured outcome. */
export const longReply = (t: { response?: string; structured?: unknown }): boolean =>
  Boolean(t.structured) || (t.response ?? "").split("\n").length > 4 || (t.response ?? "").length > 320;

/** A message of yours too long to read at a glance in its bubble: it is cut to its first lines with a
 *  Show more (any age — unlike a reply, which is cut only once it is old). */
export const longMessage = (text: string): boolean => text.split("\n").length > 8 || text.length > 600;

// ---- worker traffic in the orchestrator's chat ----
// One stream. Your turns and its replies to them read as the conversation; the worker traffic — the
// wakes worker reports caused and its replies to those — is split out of it: a run of agent turns is
// ONE collapsed block ("3 worker reports · 2 replies"), so you know they happened without the bulk.
// (History: a Chat | Agents toggle split them into two channels; a wake carrying your message AND
// reports counted as yours, so most worker traffic never reached Agents — the user asked for this.)

type Sourced = { source?: TurnSource; instruction?: string; prompt?: string; finishedAt?: number; startedAt?: number };

/** A turn's source: recorded since migration 18; a row without it (a worker's turn, a client ahead of
 *  the backfill) is read off its instruction the same way. */
export const sourceOf = (t: Sourced): TurnSource =>
  t.source ?? turnSource(splitMessages(t.instruction ?? promptInstruction(t.prompt ?? "")));

export type ChatItem<T> = { kind: "turn"; turn: T } | { kind: "agents"; turns: T[] };
/** What the orchestrator's chat renders: your turns, with each run of agent turns between them as one
 *  collapsed block. */
export function chatItems<T extends Sourced>(turns: T[]): ChatItem<T>[] {
  const out: ChatItem<T>[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (sourceOf(t) === "human") out.push({ kind: "turn", turn: t });
    else if (last?.kind === "agents") last.turns.push(t);
    else out.push({ kind: "agents", turns: [t] });
  }
  return out;
}

/** The collapsed block's line for a run of agent turns. */
export function agentsMarker(turns: Sourced[]): string {
  const reports = turns.reduce((n, t) => n + splitMessages(t.instruction ?? promptInstruction(t.prompt ?? "")).filter(isWorkerEvent).length, 0);
  const replies = turns.filter((t) => t.finishedAt).length;
  const working = turns.length - replies;
  return [
    `${reports} worker report${reports === 1 ? "" : "s"}`,
    `${replies} repl${replies === 1 ? "y" : "ies"}`,
    ...(working ? ["working"] : []),
  ].join(" · ");
}

// ---- the PR page's checks: failing first, then running, the rest folded into one line ----

/** One check as the PR page shows it (gh.ts `PrCheck`). */
export type CheckRow = { name: string; status: CiStatus; url?: string; startedAt?: string; completedAt?: string; skipped?: boolean };
export type CheckGroups<T extends CheckRow = CheckRow> = { failing: T[]; running: T[]; passing: T[]; skipped: T[] };

/** Sorted by what needs you: failing, then running / pending (the two you watch), each by name; the
 *  passing and the skipped / neutral ones are what the PR page folds behind one summary line. */
export function checkGroups<T extends CheckRow>(checks: T[]): CheckGroups<T> {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const of = (keep: (c: T) => boolean) => checks.filter(keep).sort(byName);
  return {
    failing: of((c) => c.status === "failing"),
    running: of((c) => c.status === "pending" || c.status === "none"),
    passing: of((c) => c.status === "passing" && !c.skipped),
    skipped: of((c) => c.status === "passing" && Boolean(c.skipped)),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The card's header: "1 failing · 2 running · 24 passing · 3 skipped", zero counts left out. */
export const checkSummary = (g: CheckGroups<CheckRow>): string =>
  [g.failing.length && `${g.failing.length} failing`, g.running.length && `${g.running.length} running`,
    g.passing.length && `${g.passing.length} passing`, g.skipped.length && `${g.skipped.length} skipped`].filter(Boolean).join(" · ") || "No checks";

/** The folded row's label: "24 passing" / "24 passing, 3 skipped" / "3 skipped". */
export const foldedChecksLabel = (g: CheckGroups<CheckRow>): string =>
  [g.passing.length && `${g.passing.length} passing`, g.skipped.length && `${g.skipped.length} skipped`].filter(Boolean).join(", ");

/** How long a check ran (or has been running), in ms. GitHub sends `0001-01-01T00:00:00Z` for a
 *  time that hasn't happened yet (a queued run's start, a running one's end), which parses negative. */
export function checkDuration(c: CheckRow, now = Date.now()): number | undefined {
  const start = c.startedAt ? Date.parse(c.startedAt) : NaN;
  if (!(start > 0)) return undefined;
  const done = c.completedAt ? Date.parse(c.completedAt) : NaN;
  const end = done > 0 ? done : c.status === "pending" ? now : NaN;
  return end >= start ? end - start : undefined;
}

// ---- the PR page's conversation, GitHub-style ----
// Chronological, as GitHub shows it (replies and "fixed in abc" read in context), with a summary
// line of counts and a jump to the first unresolved thread. Resolved and outdated threads fold to
// one line; a long body is clamped behind Show more; every bot comment (preview notices, billing
// notices, QA reports) goes into ONE folded row at the top instead of between the people.

export type PrComment = { author: string; body: string; createdAt?: string; url?: string; bot?: boolean };
export type PrReview = { author: string; state: string; body?: string; submittedAt?: string; url?: string; bot?: boolean };

export type ConversationEntry =
  | { kind: "comment"; id: string; author: string; body: string; createdAt?: string; url?: string; long: boolean }
  | { kind: "review"; id: string; author: string; state: string; body: string; createdAt?: string; url?: string; long: boolean }
  | { kind: "thread"; id: string; author: string; body: string; createdAt?: string; url?: string; path?: string; line?: number;
      resolved: boolean; outdated: boolean; collapsed: boolean; long: boolean };

export type PrConversation = {
  entries: ConversationEntry[];
  bots: ConversationEntry[];
  counts: { comments: number; threads: number; unresolved: number; resolved: number; outdated: number; bots: number };
  /** The id of the first thread still open (not resolved, not outdated) — the jump target. */
  firstUnresolved?: string;
};

/** Past this a body is clamped behind Show more — a measure that needs no layout. */
export const LONG_BODY_CHARS = 600;
export const LONG_BODY_LINES = 10;
export const isLongBody = (body: string) => body.length > LONG_BODY_CHARS || body.split("\n").length > LONG_BODY_LINES;

export function prConversation(input: { comments: PrComment[]; reviews: PrReview[]; threads?: ReviewThreadEvidence[] }): PrConversation {
  const people: ConversationEntry[] = [];
  const bots: ConversationEntry[] = [];
  input.comments.forEach((c, i) => {
    if (!c.body.trim()) return;
    (c.bot ? bots : people).push({ kind: "comment", id: `c${i}`, author: c.author, body: c.body, createdAt: c.createdAt, url: c.url, long: isLongBody(c.body) });
  });
  input.reviews.forEach((r, i) => {
    const body = r.body?.trim() ?? "";
    // A bare COMMENTED review is only the wrapper of inline threads, which show on their own.
    if (!body && (r.state === "COMMENTED" || r.state === "PENDING")) return;
    (r.bot ? bots : people).push({ kind: "review", id: `r${i}`, author: r.author, state: r.state, body, createdAt: r.submittedAt, url: r.url, long: isLongBody(body) });
  });
  for (const t of input.threads ?? []) {
    const outdated = Boolean(t.outdated);
    people.push({
      kind: "thread", id: `t:${t.id}`, author: t.author ?? "unknown", body: t.body, createdAt: t.createdAt, url: t.url, path: t.path, line: t.line,
      resolved: t.resolved, outdated, collapsed: t.resolved || outdated, long: isLongBody(t.body),
    });
  }
  // Stable: undated items keep their order, ahead of the dated ones.
  const chrono = (a: ConversationEntry, b: ConversationEntry) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  people.sort(chrono);
  bots.sort(chrono);
  const threads = people.filter((e): e is Extract<ConversationEntry, { kind: "thread" }> => e.kind === "thread");
  const open = threads.filter((t) => !t.collapsed);
  return {
    entries: people,
    bots,
    counts: {
      comments: people.length - threads.length, threads: threads.length, unresolved: open.length,
      resolved: threads.filter((t) => t.resolved).length, outdated: threads.filter((t) => t.outdated && !t.resolved).length, bots: bots.length,
    },
    firstUnresolved: open[0]?.id,
  };
}

/** "3 comments · 5 threads (2 unresolved, 2 resolved, 1 outdated) · 4 bot" — zero parts left out. */
export function conversationSummary(c: PrConversation["counts"]): string {
  const threadParts = [c.unresolved && `${c.unresolved} unresolved`, c.resolved && `${c.resolved} resolved`, c.outdated && `${c.outdated} outdated`].filter(Boolean).join(", ");
  return [c.comments && plural(c.comments, "comment"), c.threads && `${plural(c.threads, "thread")}${threadParts ? ` (${threadParts})` : ""}`, c.bots && `${c.bots} bot`]
    .filter(Boolean).join(" · ") || "No comments";
}

/** The bridge that answered `/api/config` (server/index.ts `bridgeInfo`). */
export type BridgeInfo = { preview: boolean; branch?: string; port: number };

/** What a page should say about the bridge behind its `/api`, or null when there is nothing to say
 *  (the real Orca). A branch preview's frontend once proxied to MAIN's bridge silently, so its Cost
 *  chart read main's numbers and everyone took them for the branch's. A preview page now always
 *  says which answered, and warns when it is main's. Pure. */
export function bridgeLabel(bridge: BridgeInfo | undefined, previewPage: boolean): { text: string; warn: boolean; title: string } | null {
  if (!previewPage && !bridge?.preview) return null;
  if (bridge?.preview) {
    return { text: `API: this branch's bridge${bridge.branch ? ` (${bridge.branch})` : ""}`, warn: false,
      title: `Answered by the branch's own bridge on :${bridge.port}, reading the shared database. Read-only: actions are refused.` };
  }
  return { text: "API: main bridge — not this branch", warn: true,
    title: `Answered by the main bridge${bridge ? ` (${bridge.branch ?? "?"} on :${bridge.port})` : ""}: data and actions here are main's code, not this branch's.` };
}

// ---- cleanup after finished work ----

/** How long a merged / closed PR's worktree is kept before it is reaped: long enough to glance at
 *  the Done card, re-open a closed PR or catch a late follow-up, short enough that finished work
 *  doesn't pile up on disk. */
export const CLEANUP_GRACE_MS = 10 * 60_000;

export type CleanupDecision = { action: "reap" } | { action: "wait" | "flag"; why: string };

/** What to do with a worktree whose work is finished (its PR merged or closed, or its workstream
 *  archived). Wait while an agent runs on it or within the grace period; then never remove anything
 *  that would lose work — uncommitted changes or commits that exist nowhere else are FLAGGED for you
 *  instead; otherwise reap. `doneAt` unknown counts as past the grace period. */
export function cleanupDecision(f: {
  doneAt?: number; now: number; graceMs?: number; running: boolean; dirty: string[]; unpushed: number;
}): CleanupDecision {
  if (f.running) return { action: "wait", why: "an agent is running on it" };
  const grace = f.graceMs ?? CLEANUP_GRACE_MS;
  if (f.doneAt !== undefined && f.now - f.doneAt < grace) {
    return { action: "wait", why: `grace period (${Math.ceil((grace - (f.now - f.doneAt)) / 60_000)} min left)` };
  }
  const why = [
    f.dirty.length ? `${f.dirty.length} uncommitted change${f.dirty.length === 1 ? "" : "s"} (${f.dirty.slice(0, 3).join(", ")}${f.dirty.length > 3 ? ", …" : ""})` : "",
    f.unpushed ? `${f.unpushed} unpushed commit${f.unpushed === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join("; ");
  return why ? { action: "flag", why } : { action: "reap" };
}

/** One instance's sweep: finished worktrees still on disk, previews with nothing behind them, and
 *  Orca's own branches left with no worktree and no open PR. `done` says whether it was applied. */
export type SweepReport = {
  instance: string; confirmed: boolean; error?: string;
  worktrees: { repo: string; branch: string; worktreePath: string; reason: string; action: "remove" | "keep"; why?: string; done?: boolean }[];
  previews: { key: string; why: string; done?: boolean }[];
  branches: { repo: string; branch: string; action: "remove" | "keep"; why: string; done?: boolean }[];
  /** Bun / preview-wrapper processes whose cwd was deleted — a stray bridge on a reaped worktree's
   *  code. Optional: an instance on older code doesn't report it. */
  processes?: { pid: number; command: string; cwd: string; done?: boolean }[];
};

/** The sweep as text — what `orca sweep` prints, dry run or applied. */
export function sweepText(reports: SweepReport[]): string {
  const confirmed = reports.some((r) => r.confirmed);
  const verb = (done?: boolean) => (confirmed ? (done ? "removed" : "FAILED") : "would remove");
  const out: string[] = [confirmed ? "Sweep applied." : "Sweep dry run — nothing was changed. Re-run with --confirm to remove what is marked \"would remove\"."];
  for (const r of reports) {
    out.push("", `## ${r.instance}`);
    if (r.error) { out.push(`  unreachable: ${r.error}`); continue; }
    const wts = r.worktrees.map((w) => `  ${w.action === "remove" ? verb(w.done) : "keep"}  ${w.repo}/${w.branch} (${w.reason}) ${w.worktreePath}${w.why ? ` — ${w.why}` : ""}`);
    const pvs = r.previews.map((p) => `  ${verb(p.done)}  ${p.key} — ${p.why}`);
    const brs = r.branches.map((b) => `  ${b.action === "remove" ? verb(b.done) : "keep"}  ${b.repo}/${b.branch} — ${b.why}`);
    out.push("Worktrees:", ...(wts.length ? wts : ["  (none)"]), "Previews:", ...(pvs.length ? pvs : ["  (none)"]), "Branches:", ...(brs.length ? brs : ["  (none)"]));
    if (r.processes) {
      const kill = (done?: boolean) => (confirmed ? (done ? "stopped" : "FAILED") : "would stop");
      const ps = r.processes.map((p) => `  ${kill(p.done)}  pid ${p.pid} ${p.command.length > 100 ? `${p.command.slice(0, 100)}…` : p.command} — cwd deleted: ${p.cwd.replace(/ \(deleted\)$/, "")}`);
      out.push("Stray processes:", ...(ps.length ? ps : ["  (none)"]));
    }
  }
  return out.join("\n");
}

// ---- the actions bar's state-aware quick actions (WorkstreamActions) ----

/** A toolbar verb the actions bar shows as a button. Each maps onto an existing store verb:
 *  createPr → promote, markReady, addressPr, slack → sendSlack, merge, autoMerge, disableAutoMerge.
 *  (Merge when green is not one: Orca's queue merges what it can by itself — `orca merge` and the
 *  server's merge queue are untouched.) */
export type QuickActionId = "createPr" | "markReady" | "addressPr" | "slack" | "merge" | "autoMerge" | "disableAutoMerge";
export type QuickAction = {
  id: QuickActionId; label: string;
  /** Set → the button shows, disabled, with this as its tooltip (why it can't run now). */
  disabled?: string;
  /** For `slack`: a first message, or a bump of one already sent. */
  slackKind?: "notify" | "bump";
  /** The tooltip, when it says more than the label (a bump's "posted 3h ago", auto-merge being on). */
  tip?: string;
  /** Auto-merge is already on: the icon is drawn lit (filled). */
  on?: boolean;
};
export type QuickActionRow = {
  lane: OverviewLane; prNumber?: number; isDraft?: boolean; hasRemote?: boolean;
  mergeable?: Mergeable; mergeClean?: "clean" | "conflict"; ciStatus?: CiStatus; reviewStatus?: ReviewStatus;
  agentStatus?: "idle" | "running" | "done" | "error";
  autoMergeEnabled?: boolean;
  /** Orca's merge-queue mark (`orca merge --when-green`) — the row's pill reads "Auto-merge" for it too. */
  mergeWhenGreen?: unknown;
  slackNotifiedAt?: string;
};
export type QuickActionContext = {
  /** The branch has commits of its own (a local branch with nothing on it can't become a PR). */
  hasWork: boolean;
  /** Review findings that are a real problem (`reviewProblems` over the digest); undefined: not
   *  fetched, so only what the row itself knows decides. */
  reviewProblems?: number;
  /** The repo has a Slack channel to post to. */
  slackChannel?: boolean;
  now?: number;
};

/** Review findings worth an agent run: every severe (warning / critical) bot item, plus every
 *  unresolved inline thread from a PERSON that isn't a nit, a status update or a summary — a
 *  person's comment with no severity marker counts as a warning, so people are never ignored.
 *  Nits and info-level bot threads are not problems. Pure. */
export function reviewProblems(d: Pick<ReviewDigest, "severe" | "human">): number {
  const human = d.human.filter((i) => i.kind === "thread" && !isNit(i.body) && !isStatusUpdate(i.body) && !isSummaryComment(i.body));
  return d.severe.length + human.length;
}

/** The workstream's quick actions: at most two icons (the Agents list's column fits two), the first
 *  matching rule wins. Open and the ⋯ menu always remain beside them, so every verb stays reachable.
 *  1. No PR: a local branch with commits → Create PR (Promote with no remote); a promoted, clean
 *     local branch (MERGEABLE) → Merge.
 *  2. A draft PR → Ready for review, plus Address PR only for a real problem (rule 3).
 *  3. A real problem — conflicts, failing CI, changes requested, or `reviewProblems` — → Address PR
 *     alone (disabled with the reason while an agent runs); no Slack: don't ask for review of a
 *     PR that needs work.
 *  4/5. Open, not approved, nothing worse than nits / info-level bot threads → Send to Slack (Bump
 *     on Slack once posted, its tooltip saying when) + auto-merge (rule 7). Still shown while an
 *     agent runs (rule 8).
 *  6. Approved (or the Mergeable lane) with nothing outstanding → Merge + auto-merge.
 *  7. Auto-merge: Enable auto-merge (GitHub's), or — once GitHub has it on — Disable auto-merge
 *     drawn lit, its tooltip saying it merges once checks and reviews pass. A PR on Orca's own merge
 *     queue shows the same lit icon, disabled (a non-clickable indicator; `orca merge --cancel`
 *     unqueues it) — offering to enable what already merges itself would be noise.
 *  9. Merged → nothing.
 *  Pure. */
export function quickActions(row: QuickActionRow, ctx: QuickActionContext): QuickAction[] {
  if (row.lane === "DONE") return [];
  const running = row.agentStatus === "running" ? "An agent is already running on this branch" : undefined;
  if (!row.prNumber) {
    if (row.lane === "MERGEABLE") return [{ id: "merge", label: "Merge" }]; // a promoted, clean local branch
    if (row.lane !== "LOCAL" || !ctx.hasWork) return [];
    return [{ id: "createPr", label: row.hasRemote ? "Create PR" : "Promote", disabled: running }];
  }
  const conflicting = row.mergeable === "CONFLICTING" || row.mergeClean === "conflict";
  const problem = conflicting || row.ciStatus === "failing" || row.reviewStatus === "changes_requested" || (ctx.reviewProblems ?? 0) > 0;
  const address: QuickAction = { id: "addressPr", label: "Address PR", disabled: running };
  if (row.isDraft) return [{ id: "markReady", label: "Ready for review" }, ...(problem ? [address] : [])];
  if (problem) return [address];

  const autoMerge: QuickAction = row.autoMergeEnabled
    ? { id: "disableAutoMerge", label: "Disable auto-merge", on: true, tip: "Auto-merge on — GitHub merges it once checks and reviews pass. Click to turn it off" }
    : row.mergeWhenGreen
      ? { id: "autoMerge", label: "Auto-merge on", on: true, disabled: "Auto-merge on — Orca's merge queue merges it once checks pass and it merges clean" }
      : { id: "autoMerge", label: "Enable auto-merge", tip: "Enable auto-merge — GitHub merges it once checks and reviews pass" };
  if (row.reviewStatus === "approved" || row.lane === "MERGEABLE") return [{ id: "merge", label: "Merge" }, autoMerge];
  const out: QuickAction[] = [];
  if (ctx.slackChannel) {
    const posted = row.slackNotifiedAt ? Date.parse(row.slackNotifiedAt) : NaN;
    out.push(row.slackNotifiedAt
      ? { id: "slack", label: "Bump on Slack", slackKind: "bump", tip: Number.isNaN(posted) ? undefined : `Bump on Slack — posted ${ago(posted, ctx.now)}` }
      : { id: "slack", label: "Send to Slack", slackKind: "notify" });
  }
  out.push(autoMerge);
  return out;
}

// ---- the instance web terminal (components/InstanceTerminal.tsx, server/terminal.ts) ----

/** The phone's extra-keys row, left to right: what each key sends to the shell. `ctrl` and `paste`
 *  are not bytes — Ctrl applies to the next key, Paste reads the clipboard. */
export const TERMINAL_KEYS: { id: string; label: string; send?: string }[] = [
  { id: "esc", label: "Esc", send: "\x1b" },
  { id: "tab", label: "Tab", send: "\t" },
  { id: "ctrl", label: "Ctrl" },
  { id: "left", label: "←", send: "\x1b[D" },
  { id: "up", label: "↑", send: "\x1b[A" },
  { id: "down", label: "↓", send: "\x1b[B" },
  { id: "right", label: "→", send: "\x1b[C" },
  { id: "paste", label: "Paste" },
];

/** Ctrl + a typed key, as the terminal byte: `c` → ETX (0x03), `[` → ESC. Anything without a control
 *  form (a digit, a word pasted in) is sent as typed. */
export function ctrlChord(data: string): string {
  if (data.length !== 1) return data;
  const c = data.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // @ A-Z [ \ ] ^ _
  if (data === "?") return "\x7f";
  if (data === " ") return "\x00";
  return data;
}

/** Where the browser opens an instance's terminal, or why it can't. Each machine serves only its own
 *  shell and no bridge relays one (box-to-box traffic is blocked on purpose), so the socket goes
 *  STRAIGHT to that machine: the API's own server (`apiBase` when the server switcher chose another
 *  one, else this page's host on the bridge's port — Vite's Bun proxy can't forward an upgrade) for
 *  the instance it says it is, else the instance's configured address. A page on loopback can't open
 *  another machine's terminal: that machine trusts only Orca's tailnet pages. */
export type TerminalTargetContext = {
  page: { protocol: string; hostname: string };
  apiBase: string; apiPort: string;
  /** The instance the API's server is (`/api/config`'s `instance`). */
  here?: string;
  /** Every instance's address (`/api/config`'s `instanceUrls`). */
  urls: Record<string, string>;
};
const LOOPBACK_HOST = /^(localhost|127(?:\.\d+){3}|::1|\[::1\])$/i;
export function terminalTarget(instance: string, ctx: TerminalTargetContext, cols = 80, rows = 24): { url: string } | { reason: string } {
  const q = new URLSearchParams({ instance, cols: String(cols), rows: String(rows) });
  const ws = (u: URL) => `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/api/terminal?${q}`;
  if (!ctx.here || instance === ctx.here) {
    if (ctx.apiBase) return { url: ws(new URL(ctx.apiBase)) };
    const host = ctx.page.hostname.includes(":") ? `[${ctx.page.hostname}]` : ctx.page.hostname;
    return { url: ws(new URL(`${ctx.page.protocol}//${host}${ctx.apiPort ? `:${ctx.apiPort}` : ""}`)) };
  }
  const raw = ctx.urls[instance];
  let target: URL;
  try { target = new URL(raw ?? ""); } catch { return { reason: `No address for ${instance} in the config` }; }
  if (LOOPBACK_HOST.test(ctx.page.hostname) && !LOOPBACK_HOST.test(target.hostname)) {
    return { reason: `Open Orca by its tailnet address to reach ${instance}` };
  }
  return { url: ws(target) };
}

/** Why a machine's Open terminal is disabled, or null when it can open. Off first: it is the one
 *  the user can change on the same row. */
export function terminalBlocked(instance: string, on: boolean, ctx: TerminalTargetContext): string | null {
  if (!on) return "Terminal is off";
  const t = terminalTarget(instance, ctx);
  return "reason" in t ? t.reason : null;
}

/** After a close, retry in this many ms, or null to stay closed. Only a dropped connection (no
 *  reason, not a clean end) of a session that was open is retried — a phone that slept, a network
 *  blip — three times, backing off. The server's own refusals (off, full, idle, shell exited) carry a
 *  reason and are final: the Reconnect button is the user's to press. */
export const TERMINAL_RETRIES = 3;
export function terminalRetry(code: number, reason: string, wasOpen: boolean, attempts: number): number | null {
  if (!wasOpen || reason || code === 1000 || code >= 4000 || attempts >= TERMINAL_RETRIES) return null;
  return 1000 * 2 ** attempts;
}

/** One session's connection, as its status dot shows it. */
export type TerminalStatus = "connecting" | "connected" | "reconnecting" | "closed";
export const TERMINAL_STATUS: Record<TerminalStatus, { label: string; tone: "ready" | "building" | "neutral" }> = {
  connecting: { label: "Connecting…", tone: "building" },
  connected: { label: "Connected", tone: "ready" },
  reconnecting: { label: "Reconnecting…", tone: "building" },
  closed: { label: "Closed", tone: "neutral" },
};

// ---- the terminal panel's tabs (components/InstanceTerminal.tsx) ----
// One tab per session; a session is one shell on one machine. The panel stays mounted while closed,
// so its sessions survive moving around the app; only closing a tab ends its shell.

export type TerminalTab = { id: string; instance: string };
export type TerminalPanelState = { open: boolean; tabs: TerminalTab[]; active: string | null; next: number };
export const TERMINAL_PANEL_INITIAL: TerminalPanelState = { open: false, tabs: [], active: null, next: 1 };

/** Open the panel on a NEW session on `instance` (the + menu). */
export function terminalNewTab(s: TerminalPanelState, instance: string): TerminalPanelState {
  const id = `t${s.next}`;
  return { open: true, tabs: [...s.tabs, { id, instance }], active: id, next: s.next + 1 };
}
/** Open the panel on `instance` (Settings' Open terminal): its newest session if it has one, else a
 *  new one. */
export function terminalShowInstance(s: TerminalPanelState, instance: string): TerminalPanelState {
  const tab = [...s.tabs].reverse().find((t) => t.instance === instance);
  return tab ? { ...s, open: true, active: tab.id } : terminalNewTab(s, instance);
}
export function terminalSelectTab(s: TerminalPanelState, id: string): TerminalPanelState {
  return s.tabs.some((t) => t.id === id) ? { ...s, active: id } : s;
}
/** Close a tab (its shell ends). The active one hands over to its right neighbour, else its left; the
 *  last one closes the panel. */
export function terminalCloseTab(s: TerminalPanelState, id: string): TerminalPanelState {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  if (!tabs.length) return { ...s, open: false, tabs, active: null };
  const active = s.active === id ? (tabs[i] ?? tabs[i - 1])!.id : s.active;
  return { ...s, tabs, active };
}
/** Hide or show the panel; the sessions keep running. Showing it with no session opens nothing. */
export function terminalSetOpen(s: TerminalPanelState, open: boolean): TerminalPanelState {
  return { ...s, open: open && s.tabs.length > 0 };
}
/** Each tab's label: the instance name, numbered from the second session on one machine
 *  ("cloud", "cloud 2"). */
export function terminalTabLabels(tabs: TerminalTab[]): Record<string, string> {
  const seen = new Map<string, number>();
  const out: Record<string, string> = {};
  for (const t of tabs) {
    const n = (seen.get(t.instance) ?? 0) + 1;
    seen.set(t.instance, n);
    out[t.id] = n === 1 ? t.instance : `${t.instance} ${n}`;
  }
  return out;
}

/** What the panel says when the socket closes — the server's own reason when it gave one (off,
 *  full, idle, shell exited); a refusal before the upgrade (not the owner) arrives with none. */
export function terminalClosedText(code: number, reason: string): string {
  if (reason) return reason;
  if (code === 1000) return "Session ended.";
  return "Could not connect — the terminal may be off, or this device is not allowed.";
}
