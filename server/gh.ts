import { run } from "./run";

export type CiStatus = "none" | "pending" | "passing" | "failing";
export type ReviewStatus = "none" | "review_required" | "changes_requested" | "approved";
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type PrStatus = {
  state: string; // OPEN | MERGED | CLOSED
  ciStatus: CiStatus;
  reviewStatus: ReviewStatus;
  mergeable: Mergeable;
};

const gh = (cwd: string, ...args: string[]) => run(["gh", ...args], cwd);

/** Open a PR from the worktree's branch. Returns PR number + url. */
export async function createPr(
  worktreePath: string,
  opts: { title: string; body: string; base: string; head: string },
): Promise<{ number: number; url: string }> {
  const url = (
    await gh(worktreePath, "pr", "create",
      "--base", opts.base, "--head", opts.head,
      "--title", opts.title, "--body", opts.body)
  ).trim().split("\n").filter(Boolean).at(-1) ?? "";
  const number = Number(url.split("/").at(-1));
  return { number, url };
}

export type PrSummary = PrStatus & { number: number; title: string; branch: string; url: string };

/** List the current user's open PRs with status — the source of truth for the kanban. */
export async function listPrs(cwd: string): Promise<PrSummary[]> {
  const raw = await gh(cwd, "pr", "list", "--state", "open", "--author", "@me",
    "--json", "number,title,headRefName,url,state,mergeable,reviewDecision,statusCheckRollup");
  const arr = JSON.parse(raw) as Array<{
    number: number; title: string; headRefName: string; url: string;
    state: string; mergeable: string; reviewDecision: string;
    statusCheckRollup: Array<{ conclusion?: string; state?: string }>;
  }>;
  return arr.map((j) => ({
    number: j.number,
    title: j.title,
    branch: j.headRefName,
    url: j.url,
    state: j.state,
    ciStatus: rollupCi(j.statusCheckRollup ?? []),
    reviewStatus: mapReview(j.reviewDecision ?? ""),
    mergeable: (j.mergeable as Mergeable) ?? "UNKNOWN",
  }));
}

export type PrDetail = PrStatus & {
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  head: string;
  base: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { path: string; additions: number; deletions: number }[];
  reviews: { author: string; state: string }[];
  comments: { author: string; body: string }[];
  checks: { name: string; status: CiStatus }[];
};

function checkOutcome(c: { conclusion?: string; state?: string }): CiStatus {
  const o = c.conclusion || c.state || "PENDING";
  if (FAIL.has(o)) return "failing";
  if (PASS.has(o)) return "passing";
  return "pending";
}

/** Full detail for one PR — overview, files, reviews, comments. */
export async function prDetail(cwd: string, pr: number): Promise<PrDetail> {
  const raw = await gh(cwd, "pr", "view", String(pr), "--json",
    "number,title,body,author,state,url,headRefName,baseRefName,additions,deletions,changedFiles,files,reviews,comments,mergeable,reviewDecision,statusCheckRollup");
  // deno-lint-ignore no-explicit-any -- gh's json is broad; we normalise below
  const j = JSON.parse(raw) as any;
  return {
    number: j.number,
    title: j.title ?? "",
    body: j.body ?? "",
    author: j.author?.login ?? "",
    state: j.state,
    url: j.url ?? "",
    head: j.headRefName ?? "",
    base: j.baseRefName ?? "",
    additions: j.additions ?? 0,
    deletions: j.deletions ?? 0,
    changedFiles: j.changedFiles ?? 0,
    files: (j.files ?? []).map((f: any) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    reviews: (j.reviews ?? []).map((r: any) => ({ author: r.author?.login ?? "", state: r.state })),
    comments: (j.comments ?? []).map((c: any) => ({ author: c.author?.login ?? "", body: c.body ?? "" })),
    checks: (j.statusCheckRollup ?? []).map((c: any) => ({ name: c.name ?? c.context ?? "check", status: checkOutcome(c) })),
    ciStatus: rollupCi(j.statusCheckRollup ?? []),
    reviewStatus: mapReview(j.reviewDecision ?? ""),
    mergeable: (j.mergeable as Mergeable) ?? "UNKNOWN",
  };
}

/** Raw unified diff for a PR. */
export const prDiff = (cwd: string, pr: number) => gh(cwd, "pr", "diff", String(pr));

export async function mergePr(cwd: string, pr: number): Promise<void> {
  await gh(cwd, "pr", "merge", String(pr), "--squash");
}

export async function prStatus(cwd: string, pr: number): Promise<PrStatus> {
  const raw = await gh(cwd, "pr", "view", String(pr),
    "--json", "state,mergeable,reviewDecision,statusCheckRollup");
  const json = JSON.parse(raw) as {
    state: string;
    mergeable: string;
    reviewDecision: string;
    statusCheckRollup: Array<{ status?: string; conclusion?: string; state?: string }>;
  };
  return {
    state: json.state,
    ciStatus: rollupCi(json.statusCheckRollup ?? []),
    reviewStatus: mapReview(json.reviewDecision ?? ""),
    mergeable: (json.mergeable as Mergeable) ?? "UNKNOWN",
  };
}

const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);

function rollupCi(checks: Array<{ conclusion?: string; state?: string }>): CiStatus {
  if (checks.length === 0) return "none";
  const outcomes = checks.map((c) => c.conclusion || c.state || "PENDING");
  if (outcomes.some((o) => FAIL.has(o))) return "failing";
  if (outcomes.some((o) => !PASS.has(o))) return "pending";
  return "passing";
}

function mapReview(decision: string): ReviewStatus {
  switch (decision) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes_requested";
    case "REVIEW_REQUIRED": return "review_required";
    default: return "none";
  }
}
