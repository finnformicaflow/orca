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
  opts: { title: string; body: string; base: string; head: string; draft?: boolean },
): Promise<{ number: number; url: string }> {
  const url = (
    await gh(worktreePath, "pr", "create",
      "--base", opts.base, "--head", opts.head,
      "--title", opts.title, "--body", opts.body,
      ...(opts.draft ? ["--draft"] : []))
  ).trim().split("\n").filter(Boolean).at(-1) ?? "";
  const number = Number(url.split("/").at(-1));
  return { number, url };
}

export type PrSummary = PrStatus & {
  number: number; title: string; branch: string; url: string; isDraft: boolean; autoMergeEnabled: boolean;
  previewUrl?: string; externalFeedback: number; failingChecks?: string[]; feedback?: string[];
};

/** Pull a deploy-preview URL out of a PR's comments (posted by the pr-preview action). */
function extractPreviewUrl(comments: Array<{ body?: string }>): string | undefined {
  const urls = comments.flatMap((c) => [...(c.body ?? "").matchAll(/https?:\/\/[^\s)\]<]+/g)].map((m) => m[0]));
  return urls.find((u) => /\.preview\./.test(u) && !/api\.preview/.test(u) && !/\.(png|jpe?g|gif|svg)(\?|$)/i.test(u));
}

/** Count HUMAN feedback on a PR: issue comments + reviews left by someone other than the author,
 *  excluding bots (login ends in `[bot]` — CI/preview/coverage). Drives "Follow PR": a rise in this
 *  count means a coworker left new feedback to address. Excluding the author (and thus Orca's own
 *  agent, which acts as you) is what stops the follow loop re-triggering on its own replies. */
export function countExternalFeedback(
  authorLogin: string,
  comments: Array<{ author?: { login?: string } }> = [],
  reviews: Array<{ author?: { login?: string }; state?: string }> = [],
): number {
  const isOther = (login?: string) => Boolean(login) && login !== authorLogin && !login!.endsWith("[bot]");
  const c = comments.filter((x) => isOther(x.author?.login)).length;
  const r = reviews.filter((x) => isOther(x.author?.login) && (x.state === "COMMENTED" || x.state === "CHANGES_REQUESTED")).length;
  return c + r;
}

// High-level PR fields, cheap to list. Deliberately EXCLUDES the two per-PR fields gh fetches one
// call at a time — `comments` and `statusCheckRollup` (CI). Together they turn a ~3s list of 200
// PRs into ~14s, so both are detail-only (see listReviewPrs / prDetail). What's left are plain
// index fields (state/draft/mergeable/reviewDecision) that come back in the single list call.
const PR_META_FIELDS = "number,title,headRefName,url,state,isDraft,mergeable,reviewDecision,autoMergeRequest";
type RawPr = {
  number: number; title: string; headRefName: string; url: string;
  state: string; isDraft: boolean; mergeable: string; reviewDecision: string;
  autoMergeRequest?: { enabledAt?: string } | null;
  statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string }>;
  author?: { login?: string };
  comments?: Array<{ author?: { login?: string }; body?: string }>;
  reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>;
};
const mapSummary = (j: RawPr): PrSummary => {
  const author = j.author?.login ?? "";
  const isOther = (login?: string) => Boolean(login) && login !== author && !login!.endsWith("[bot]");
  const feedback = [
    ...(j.comments ?? []).filter((x) => isOther(x.author?.login)).map((x) => x.body?.trim() ?? ""),
    ...(j.reviews ?? []).filter((x) => isOther(x.author?.login) && (x.state === "COMMENTED" || x.state === "CHANGES_REQUESTED")).map((x) => x.body?.trim() ?? ""),
  ].filter(Boolean).slice(-10);
  const failingChecks = (j.statusCheckRollup ?? [])
    .filter((check) => checkOutcome(check) === "failing")
    .map((check) => check.name ?? check.context ?? "unnamed check");
  return {
    number: j.number,
    title: j.title,
    branch: j.headRefName,
    url: j.url,
    state: j.state,
    isDraft: Boolean(j.isDraft),
    autoMergeEnabled: Boolean(j.autoMergeRequest),
    ciStatus: rollupCi(j.statusCheckRollup ?? []),
    reviewStatus: mapReview(j.reviewDecision ?? ""),
    mergeable: (j.mergeable as Mergeable) ?? "UNKNOWN",
    previewUrl: j.comments ? extractPreviewUrl(j.comments) : undefined,
    externalFeedback: countExternalFeedback(j.author?.login ?? "", j.comments, j.reviews),
    failingChecks: failingChecks.length ? failingChecks : undefined,
    feedback: feedback.length ? feedback : undefined,
  };
};

/** List the current user's open PRs with status — the source of truth for the kanban. Fetches CI,
 *  comments + reviews too (there are few of your own PRs) so the board shows checks, links the deploy
 *  preview, and "Follow PR" can react to new reviewer feedback. */
export async function listPrs(cwd: string): Promise<PrSummary[]> {
  const raw = await gh(cwd, "pr", "list", "--state", "open", "--author", "@me", "--json", `${PR_META_FIELDS},statusCheckRollup,comments,author,reviews`);
  return (JSON.parse(raw) as RawPr[]).map(mapSummary);
}

export type ReviewPr = PrSummary & { author: string; authorName: string; updatedAt: string };

async function fetchReviewPrs(cwd: string): Promise<ReviewPr[]> {
  // `-author:@me` (gh expands @me to the authenticated user) excludes your own PRs server-side.
  // High limit so the queue shows *all* open coworker PRs (gh's default is only 30).
  const raw = await gh(cwd, "pr", "list", "--state", "open", "--search", "-author:@me", "--limit", "500",
    "--json", `${PR_META_FIELDS},author,updatedAt`);
  const arr = JSON.parse(raw) as Array<RawPr & { author?: { login?: string; name?: string }; updatedAt?: string }>;
  return arr
    .map((j) => ({ ...mapSummary(j), author: j.author?.login ?? "", authorName: j.author?.name || j.author?.login || "", updatedAt: j.updatedAt ?? "" }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// The review queue re-fetches on every page mount + a 15s client poll, per repo — but each `gh pr
// list` is a ~3s network round-trip, and coworker PRs change slowly. So cache per repo and serve
// stale-while-revalidate: return the cached list instantly, refreshing in the background when it's
// older than the TTL. First load pays the round-trip; every navigation/poll after is instant.
const REVIEW_TTL_MS = 30_000;
const reviewCache = new Map<string, { at: number; prs: ReviewPr[]; inflight?: Promise<ReviewPr[]> }>();

/** Open PRs authored by OTHERS — the coworker review queue (a timeline, newest-updated first). A
 *  lightweight META list only: no comments (so it stays fast for a large queue). Deeper info incl.
 *  the deploy-preview URL comes from prDetail when you click into a specific PR. Cached per repo. */
export function listReviewPrs(cwd: string): Promise<ReviewPr[]> {
  const hit = reviewCache.get(cwd);
  const refresh = () => {
    const inflight = fetchReviewPrs(cwd)
      .then((prs) => { reviewCache.set(cwd, { at: Date.now(), prs }); return prs; })
      .catch((e) => {
        const c = reviewCache.get(cwd);
        if (c?.at) c.inflight = undefined; // had real data before — keep serving it, allow a later retry
        else reviewCache.delete(cwd); // cold failure: drop the placeholder so the error surfaces, not an empty queue
        throw e;
      });
    reviewCache.set(cwd, { at: hit?.at ?? 0, prs: hit?.prs ?? [], inflight });
    return inflight;
  };
  if (!hit) return refresh(); // cold: must wait for the first fetch
  if (Date.now() - hit.at > REVIEW_TTL_MS && !hit.inflight) void refresh().catch(() => {}); // stale: refresh in background
  return Promise.resolve(hit.prs); // serve cached immediately
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
  previewUrl?: string;
  autoMergeEnabled: boolean;
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
    "number,title,body,author,state,url,headRefName,baseRefName,additions,deletions,changedFiles,files,reviews,comments,mergeable,reviewDecision,statusCheckRollup,autoMergeRequest");
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
    previewUrl: extractPreviewUrl(j.comments ?? []),
    autoMergeEnabled: Boolean(j.autoMergeRequest), // gh: null when off, an object (mergeMethod/enabledAt/…) when on
  };
}

/** Raw unified diff for a PR. */
export const prDiff = (cwd: string, pr: number) => gh(cwd, "pr", "diff", String(pr));

export type MergedPr = { number: number; title: string; branch: string; url: string; mergedAt: string };

type RawMergedPr = { number: number; title: string; headRefName: string; url: string; mergedAt: string };
const MERGED_TTL_MS = 15_000;
const mergedCache = new Map<string, { at: number; rows: RawMergedPr[]; inflight?: Promise<RawMergedPr[]> }>();

/** One shared merged-PR query powers both cleanup and the Done lane. */
async function mergedRows(cwd: string): Promise<RawMergedPr[]> {
  const hit = mergedCache.get(cwd);
  if (hit && Date.now() - hit.at < MERGED_TTL_MS) return hit.rows;
  if (hit?.inflight) return hit.inflight;
  const inflight = gh(cwd, "pr", "list", "--state", "merged", "--author", "@me", "--limit", "50",
    "--json", "number,title,headRefName,url,mergedAt")
    .then((raw) => {
      const rows = JSON.parse(raw) as RawMergedPr[];
      mergedCache.set(cwd, { at: Date.now(), rows });
      return rows;
    })
    .catch((error) => { mergedCache.delete(cwd); throw error; });
  mergedCache.set(cwd, { at: hit?.at ?? 0, rows: hit?.rows ?? [], inflight });
  return inflight;
}

/** The current user's PRs merged today (server-local calendar day) — the Done lane. */
export async function listMerged(cwd: string): Promise<MergedPr[]> {
  const arr = await mergedRows(cwd);
  const startOfToday = new Date(); // server runs on the user's machine → their locale/timezone
  startOfToday.setHours(0, 0, 0, 0);
  return arr
    .filter((j) => j.mergedAt && Date.parse(j.mergedAt) >= startOfToday.getTime())
    .map((j) => ({ number: j.number, title: j.title, branch: j.headRefName, url: j.url, mergedAt: j.mergedAt }));
}

/** Branch names of the user's merged PRs (not date-filtered) — used to reap their leftover worktrees. */
export async function mergedBranches(cwd: string): Promise<Set<string>> {
  return new Set((await mergedRows(cwd)).map((j) => j.headRefName));
}

/** Close a PR without merging (best-effort). */
export const closePr = (cwd: string, pr: number) => gh(cwd, "pr", "close", String(pr));

/** Add a label to a PR (e.g. to trigger the deploy-preview action). */
export const addLabel = (cwd: string, pr: number, label: string) =>
  gh(cwd, "pr", "edit", String(pr), "--add-label", label);

/** Mark a draft PR ready for review. */
export const markReady = (cwd: string, pr: number) => gh(cwd, "pr", "ready", String(pr));

/** Convert an open PR back to a draft. */
export const convertToDraft = (cwd: string, pr: number) => gh(cwd, "pr", "ready", String(pr), "--undo");

export async function mergePr(cwd: string, pr: number): Promise<void> {
  await gh(cwd, "pr", "merge", String(pr), "--squash");
}

/** Enable auto-merge: GitHub squash-merges the PR once its required checks + reviews pass. */
export const enableAutoMerge = (cwd: string, pr: number) =>
  gh(cwd, "pr", "merge", String(pr), "--auto", "--squash");

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
