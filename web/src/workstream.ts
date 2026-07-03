// Pure workstream logic — the state machine and derivations. No React, no I/O,
// so both the store and the e2e tests import it directly.

import type { CiStatus, Mergeable, ReviewStatus } from "../../server/gh";

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
  return s.mergeable === "MERGEABLE" && ciOk(s.ciStatus) && s.reviewStatus === "approved";
}

/** Map a freshly-polled PR status onto its kanban lane: open (In Review) vs approved (Mergeable). */
export function deriveKanbanState(s: PrStatusLike): WorkstreamState {
  if (s.state === "MERGED") return "MERGED";
  return s.reviewStatus === "approved" ? "MERGEABLE" : "IN_REVIEW"; // conflict/CI/ready show as badges
}

/** In-review PR that's green and just needs a reviewer to look — surfaced as a badge. */
export function readyForReview(s: PrStatusLike): boolean {
  return s.reviewStatus !== "approved" && s.reviewStatus !== "changes_requested" && ciOk(s.ciStatus);
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

/** Prompt used to launch the headless agent — adds an autonomous-commit instruction. */
export function launchPrompt(ws: Pick<Workstream, "title" | "branch" | "prompt">): string {
  return `${promptFor(ws)}\n\nWork autonomously. Commit your changes with clear messages as you go.`;
}

/** Terminal command to jump into an interactive session continuing the headless run. */
export function attachCommand(ws: Pick<Workstream, "worktreePath">): string {
  return `cd "${ws.worktreePath}" && claude --continue`;
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

/** Derive a short human title from a prompt's first line (no AI). */
export function titleFromPrompt(prompt: string): string {
  const first = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const cleaned = first.replace(/[.!?…]+$/, "").trim();
  if (!cleaned) return "Untitled";
  const truncated = cleaned.length > 60 ? cleaned.slice(0, 60).replace(/\s+\S*$/, "") : cleaned;
  return truncated.charAt(0).toUpperCase() + truncated.slice(1);
}

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
