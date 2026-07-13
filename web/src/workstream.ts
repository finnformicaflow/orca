// Pure workstream logic — the state machine and derivations. No React, no I/O,
// so both the store and the e2e tests import it directly.

import type { CiStatus, Mergeable, ReviewStatus } from "../../server/gh";
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
export type PrMenuAction = "markReady" | "moveToDraft" | "autoMerge" | "resolveConflicts" | "fixCi" | "addPreview" | "copyLink";
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

/** Prompt used to launch the headless agent — sync-with-base + autonomous-commit instructions. */
export function launchPrompt(ws: Pick<Workstream, "title" | "branch" | "prompt">, base = "main"): string {
  return [
    promptFor(ws),
    "",
    `First, sync with the latest \`${base}\` so you're not working behind it: run \`git fetch origin ${base} && git merge origin/${base}\` and resolve any conflicts before you start.`,
    "Then work autonomously. Commit your changes with clear messages as you go.",
    NO_PR,
  ].join("\n");
}

/** Instruction for Claude to send a Slack message about a PR (Claude has Slack access). */
export function slackPrompt(
  ws: Pick<Workstream, "title" | "prNumber" | "prUrl">,
  kind: "notify" | "bump",
  channel?: string,
): string {
  const link = `[#${ws.prNumber} ${ws.title}](${ws.prUrl ?? ""})`;
  const content = kind === "bump" ? `Bump:\n${link}` : link;
  const where = channel ? ` to the ${channel} channel` : "";
  return `Post a new Slack message${where} with exactly this content and nothing else — no emojis, no extra text, and do not reply in a thread:\n\n${content}`;
}

/** Follow-up instruction for an agent already working a branch (resumes its session). */
export function followUpPrompt(instruction: string): string {
  return `${instruction}\n\nWork autonomously. Commit and push your changes.\n${NO_PR}`;
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
const PR_DIFF_LIMIT = 12_000;

/** Build the instruction handed to a headless Claude to WRITE a PR description from the branch's
 *  actual diff — this is what turns a promoted PR from "raw template / commit list" into a filled,
 *  reviewer-ready description. When the repo ships a PR template, every section is filled from the
 *  diff (HTML comments are guidance, not text to keep); otherwise a sensible section set is used.
 *  Breaking changes go at the TOP; secrets are never emitted. The reply is the finished markdown. */
export function prDescriptionPrompt(input: { template?: string | null; diff: string; commits: string[] }): string {
  const commits = input.commits.map((s) => s.trim()).filter(Boolean);
  const diff = input.diff.length > PR_DIFF_LIMIT
    ? `${input.diff.slice(0, PR_DIFF_LIMIT)}\n…(diff truncated)…`
    : input.diff;
  const template = input.template?.trim();
  const structure = template
    ? [
        "Write the body using this repo's PR template. Fill in EVERY section from the actual diff",
        "(treat the HTML comments as guidance, not literal text to keep):",
        "",
        template,
      ].join("\n")
    : [
        "Structure the body with these sections, each filled from the actual diff:",
        "- **What & Why** — the user-facing problem and the motivation behind the change.",
        "- **How It Works** — the approach; call out any API / data-model / migration changes.",
        "- **What Changed** — file-level, grouped by area (backend / frontend / shared / migrations).",
        "- **Testing & Verification** — the suites run and any manual steps.",
        "- **Risks & Follow-ups**.",
      ].join("\n");
  return [
    "Write a pull-request description for the change below. Output ONLY the description as",
    "GitHub-flavored markdown — no preamble, no sign-off, no code fence wrapping the whole thing.",
    "",
    structure,
    "",
    "Rules:",
    "- Put any breaking change, removed feature, or disabled workflow at the TOP, with the affected",
    "  users and the migration/rollback path. Never bury it.",
    "- Describe only code changes. Never include secrets — no credentials, tokens, env vars, or",
    "  internal hostnames.",
    "- Be concise and specific; base every claim on the diff, not guesses.",
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
  return [
    `Branch \`${ws.branch}\` has merge conflicts with \`${base}\`.`,
    `Merge \`origin/${base}\` into it, resolve every conflict preserving both sides' intent,`,
    `then commit and push. (Rebase + \`--force-with-lease\` is fine if cleaner.)`,
  ].join(" ");
}

/** Instruction for Claude to fix failing CI on a PR in its worktree, then push. */
export function resolveCiPrompt(ws: Pick<Workstream, "prNumber" | "branch">): string {
  return [
    `CI is failing on PR #${ws.prNumber} (branch \`${ws.branch}\`).`,
    `Investigate the failing checks, fix the root cause, run the relevant tests/build locally to confirm,`,
    `then commit and push.`,
  ].join(" ");
}

/** Instruction for Claude to address a PR's requested changes / review comments, then push. */
export function addressReviewPrompt(ws: Pick<Workstream, "prNumber" | "branch">): string {
  return [
    `PR #${ws.prNumber} (branch \`${ws.branch}\`) has requested changes or new review comments.`,
    `Read them (\`gh pr view ${ws.prNumber} --comments\`), address every point,`,
    `then commit and push.`,
  ].join(" ");
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

/** Session title, summarised from the feature prompt (server prefers a Haiku summary, falls back to
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
