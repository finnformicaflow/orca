import { run } from "./run";
import { countGhCall } from "./metrics";
import { mergeSafe } from "../web/src/workstream";

export type CiStatus = "none" | "pending" | "passing" | "failing";
export type ReviewStatus = "none" | "review_required" | "changes_requested" | "approved";
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type ReviewThreadEvidence = {
  id: string;
  path?: string;
  line?: number;
  author?: string;
  body: string;
  url?: string;
  resolved: boolean;
  alreadyHanded?: boolean;
  /** Review-signal fields (reviewSignal only): the code it was left on has since changed; the
   *  opener is a GitHub App / bot account; when it was opened. */
  outdated?: boolean;
  bot?: boolean;
  createdAt?: string;
};

export type CiFailureEvidence = {
  name: string;
  status?: string;
  url?: string;
  excerpt?: string;
};

export type PrStatus = {
  state: string; // OPEN | MERGED | CLOSED
  ciStatus: CiStatus;
  reviewStatus: ReviewStatus;
  mergeable: Mergeable;
};

const gh = (cwd: string, ...args: string[]) => { countGhCall(); return run(["gh", ...args], cwd); };

const REVIEW_BODY_LIMIT = 1_200;
const REVIEW_TOTAL_LIMIT = 8_000;
const CI_EXCERPT_LIMIT = 2_000;
const CI_TOTAL_LIMIT = 8_000;
const botLogin = (login?: string) => !login || login.endsWith("[bot]") || /^(?:github-actions|dependabot)$/i.test(login);
const truncate = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 16)}\n…(truncated)…` : value;

/** One PR conversation item — an issue-level comment or a submitted review's top-level body — as
 *  opposed to an inline thread. These have no native "handled" bit on GitHub, so Orca remembers
 *  when it last handed them over (enrichment `commentsSeenAt`) and only surfaces newer ones. */
export type ConversationComment = {
  id: string; kind: "comment" | "review"; author?: string; createdAt: string; body: string; url?: string;
  /** reviewSignal only: a review's state (APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED) and
   *  whether the author is a bot account. */
  state?: string; bot?: boolean;
};

const COMMENTS_MAX = 30;

/** Conversation comments and review summaries on a PR newer than `since` (ISO), from everyone but
 *  the PR's author — Orca runs the agent AS the author, so its own replies are never re-surfaced.
 *  Deliberately no other filtering (bots included): what needs a response is the agent's call.
 *  Newest-last, bounded to the last COMMENTS_MAX and the same total size as thread evidence. */
export async function conversationComments(cwd: string, pr: number, since?: string): Promise<ConversationComment[]> {
  const raw = await gh(cwd, "pr", "view", String(pr), "--json", "author,comments,reviews");
  const j = JSON.parse(raw) as {
    author?: { login?: string };
    comments?: Array<{ id?: string; author?: { login?: string }; body?: string; createdAt?: string; url?: string }>;
    reviews?: Array<{ id?: string; author?: { login?: string }; body?: string; submittedAt?: string; url?: string; state?: string }>;
  };
  const me = j.author?.login;
  const items: ConversationComment[] = [];
  for (const c of j.comments ?? []) {
    if (!c.createdAt || c.author?.login === me || (since && c.createdAt <= since) || !c.body?.trim()) continue;
    items.push({ id: c.id ?? c.url ?? c.createdAt, kind: "comment", author: c.author?.login, createdAt: c.createdAt, body: truncate(c.body.trim(), REVIEW_BODY_LIMIT), url: c.url });
  }
  for (const r of j.reviews ?? []) {
    if (!r.submittedAt || r.author?.login === me || (since && r.submittedAt <= since) || !r.body?.trim()) continue;
    items.push({ id: r.id ?? r.url ?? r.submittedAt, kind: "review", author: r.author?.login, createdAt: r.submittedAt, body: truncate(r.body.trim(), REVIEW_BODY_LIMIT), url: r.url });
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recent = items.slice(-COMMENTS_MAX);
  const out: ConversationComment[] = [];
  let used = 0;
  for (const item of recent.reverse()) { // keep the newest when the size cap bites
    const size = JSON.stringify(item).length;
    if (used + size > REVIEW_TOTAL_LIMIT) break;
    used += size;
    out.unshift(item);
  }
  return out;
}

/** Unresolved inline review threads for one PR. This GraphQL call is intentionally on-demand. */
export async function reviewEvidence(cwd: string, pr: number): Promise<ReviewThreadEvidence[]> {
  const repoRaw = await gh(cwd, "repo", "view", "--json", "nameWithOwner");
  const nameWithOwner = JSON.parse(repoRaw).nameWithOwner as string;
  const [owner, name] = nameWithOwner.split("/");
  if (!owner || !name) throw new Error("could not resolve GitHub repository");
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id,isResolved,path,line,originalLine,comments(first:20){nodes{author{login},body,url}}}}}}}`;
  const raw = await gh(cwd, "api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pr}`);
  const nodes = JSON.parse(raw)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const evidence: ReviewThreadEvidence[] = [];
  let used = 0;
  for (const thread of nodes) {
    if (thread?.isResolved || typeof thread?.id !== "string") continue;
    const comments = (thread.comments?.nodes ?? []).filter((comment: any) => !botLogin(comment?.author?.login));
    if (!comments.length) continue;
    const body = truncate(comments.slice(-3).map((comment: any) => {
      const author = comment.author?.login;
      return comments.length > 1 && author ? `${author}: ${comment.body ?? ""}` : String(comment.body ?? "");
    }).join("\n\n").trim(), REVIEW_BODY_LIMIT);
    if (!body) continue;
    const item: ReviewThreadEvidence = {
      id: thread.id, path: thread.path || undefined, line: thread.line ?? thread.originalLine ?? undefined,
      author: comments.at(-1)?.author?.login, body, url: comments.at(-1)?.url || undefined, resolved: false,
    };
    const size = JSON.stringify(item).length;
    if (used + size > REVIEW_TOTAL_LIMIT) break;
    used += size;
    evidence.push(item);
  }
  return evidence;
}

/** Everything the board's review cluster and the PR page's Review panel are derived from
 *  (workstream.ts `reviewDigest`), in ONE GraphQL call: every review with its state (approvals have
 *  no body, so conversationComments can't carry them), every conversation comment, and every inline
 *  thread — resolved and bot ones included, with the opener as author — because deciding what is
 *  human, severe or actionable is the pure derivation's job, not the adapter's. The PR author's own
 *  comments are dropped as in conversationComments; their thread openers are kept but marked by
 *  `prAuthor`, so the derivation can exclude them. Bodies are bounded; the heuristics only read the top. */
export type ReviewSignal = { prAuthor?: string; threads: ReviewThreadEvidence[]; comments: ConversationComment[] };

const SIGNAL_BODY_LIMIT = 600;

export async function reviewSignal(cwd: string, pr: number): Promise<ReviewSignal> {
  const repoRaw = await gh(cwd, "repo", "view", "--json", "nameWithOwner");
  const [owner, name] = String(JSON.parse(repoRaw).nameWithOwner ?? "").split("/");
  if (!owner || !name) throw new Error("could not resolve GitHub repository");
  const who = "author{__typename,login}";
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){author{login},`
    + `reviews(last:100){nodes{id,${who},state,body,submittedAt,url}},`
    + `comments(last:100){nodes{id,${who},body,createdAt,url}},`
    + `reviewThreads(first:100){nodes{id,isResolved,isOutdated,path,line,originalLine,comments(first:1){nodes{${who},body,url,createdAt}}}}}}}`;
  const raw = await gh(cwd, "api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pr}`);
  const p = JSON.parse(raw)?.data?.repository?.pullRequest ?? {};
  const prAuthor: string | undefined = p.author?.login;
  const isBot = (a: any) => a?.__typename === "Bot" || botLogin(a?.login);
  const body = (b: unknown) => truncate(String(b ?? "").trim(), SIGNAL_BODY_LIMIT);
  const comments: ConversationComment[] = [];
  for (const r of p.reviews?.nodes ?? []) {
    if (!r?.submittedAt || (prAuthor && r.author?.login === prAuthor)) continue;
    comments.push({ id: r.id ?? r.url ?? r.submittedAt, kind: "review", author: r.author?.login, createdAt: r.submittedAt, body: body(r.body), url: r.url, state: r.state, bot: isBot(r.author) });
  }
  for (const c of p.comments?.nodes ?? []) {
    if (!c?.createdAt || (prAuthor && c.author?.login === prAuthor) || !String(c.body ?? "").trim()) continue;
    comments.push({ id: c.id ?? c.url ?? c.createdAt, kind: "comment", author: c.author?.login, createdAt: c.createdAt, body: body(c.body), url: c.url, bot: isBot(c.author) });
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const threads: ReviewThreadEvidence[] = [];
  for (const t of p.reviewThreads?.nodes ?? []) {
    const first = t?.comments?.nodes?.[0];
    if (typeof t?.id !== "string" || !first) continue;
    threads.push({
      id: t.id, path: t.path || undefined, line: t.line ?? t.originalLine ?? undefined, author: first.author?.login, body: body(first.body),
      url: first.url || undefined, resolved: Boolean(t.isResolved), outdated: Boolean(t.isOutdated), bot: isBot(first.author), createdAt: first.createdAt,
    });
  }
  return { prAuthor, threads, comments };
}

function usefulLogExcerpt(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return undefined;
  const hits = lines.map((line, i) => /(?:error|fail|exception|panic|fatal|assert|exit code)/i.test(line) ? i : -1).filter((i) => i >= 0);
  const selected = hits.length
    ? [...new Set(hits.flatMap((i) => Array.from({ length: 7 }, (_, n) => i - 3 + n)).filter((i) => i >= 0 && i < lines.length))].map((i) => lines[i])
    : lines.slice(-30);
  return truncate(selected.join("\n"), CI_EXCERPT_LIMIT);
}

/** Failing checks plus bounded GitHub Actions failed-step logs for one PR, fetched on demand. */
export async function ciEvidence(cwd: string, pr: number): Promise<CiFailureEvidence[]> {
  const raw = await gh(cwd, "pr", "view", String(pr), "--json", "statusCheckRollup");
  const checks = JSON.parse(raw)?.statusCheckRollup ?? [];
  const failures = checks.filter((check: any) => checkOutcome(check) === "failing");
  const result: CiFailureEvidence[] = [];
  const logs = new Map<string, string | undefined>();
  let used = 0;
  for (const check of failures) {
    const name = check.name ?? check.context ?? "unnamed check";
    const url = check.detailsUrl ?? check.targetUrl ?? undefined;
    const runId = typeof url === "string" ? url.match(/\/actions\/runs\/(\d+)/)?.[1] : undefined;
    let excerpt: string | undefined;
    if (runId) {
      if (!logs.has(runId)) {
        try { logs.set(runId, usefulLogExcerpt(await gh(cwd, "run", "view", runId, "--log-failed"))); }
        catch { logs.set(runId, undefined); }
      }
      excerpt = logs.get(runId);
    }
    const item: CiFailureEvidence = { name, status: check.conclusion ?? check.state ?? undefined, url, excerpt };
    const size = JSON.stringify(item).length;
    if (used + size > CI_TOTAL_LIMIT) {
      const withoutLog = { name, status: item.status, url };
      if (used + JSON.stringify(withoutLog).length > CI_TOTAL_LIMIT) break;
      result.push(withoutLog);
      used += JSON.stringify(withoutLog).length;
    } else {
      result.push(item); used += size;
    }
  }
  return result;
}

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
  number: number; title: string; branch: string; base?: string; url: string; isDraft: boolean; autoMergeEnabled: boolean;
  previewUrl?: string; hasPreviewLabel?: boolean; externalFeedback: number; failingChecks?: string[]; feedback?: string[];
  /** The PR's own diffstat — gh computes it in the same list call, so the Agents row's +/- is free. */
  additions: number; deletions: number;
  /** The PR's head commit — what a CI notification is keyed on, and what cleanup calls "pushed". */
  head?: string;
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
// index fields (state/draft/mergeable/reviewDecision) that come back in the single list call —
// additions/deletions among them, so the Agents row's diffstat costs nothing extra.
const PR_META_FIELDS = "number,title,headRefName,headRefOid,baseRefName,url,state,isDraft,mergeable,reviewDecision,autoMergeRequest,additions,deletions";
type RawPr = {
  number: number; title: string; headRefName: string; headRefOid?: string; baseRefName?: string; url: string;
  state: string; isDraft: boolean; mergeable: string; reviewDecision: string;
  autoMergeRequest?: { enabledAt?: string } | null;
  additions?: number; deletions?: number;
  statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string }>;
  author?: { login?: string };
  comments?: Array<{ author?: { login?: string }; body?: string }>;
  reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>;
  labels?: Array<{ name?: string }>;
};
const checkName = (c: { name?: string; context?: string }) => c.name ?? c.context ?? "";
/** Keep only the checks that GATE merge (GitHub's required set). Empty `required` → keep all, so a
 *  repo with no branch protection behaves as before and advisory bots there still show. */
const gatingChecks = <T extends { name?: string; context?: string }>(checks: T[], required: Set<string>): T[] =>
  required.size ? checks.filter((c) => required.has(checkName(c))) : checks;
const mapSummary = (j: RawPr, required: Set<string> = new Set(), previewLabelName?: string): PrSummary => {
  const author = j.author?.login ?? "";
  const isOther = (login?: string) => Boolean(login) && login !== author && !login!.endsWith("[bot]");
  const feedback = [
    ...(j.comments ?? []).filter((x) => isOther(x.author?.login)).map((x) => x.body?.trim() ?? ""),
    ...(j.reviews ?? []).filter((x) => isOther(x.author?.login) && (x.state === "COMMENTED" || x.state === "CHANGES_REQUESTED")).map((x) => x.body?.trim() ?? ""),
  ].filter(Boolean).slice(-10);
  // Only required checks decide CI pass/fail (badge, Merge gate, Fix CI); advisory bots are ignored.
  const gating = gatingChecks(j.statusCheckRollup ?? [], required);
  const failingChecks = gating
    .filter((check) => checkOutcome(check) === "failing")
    .map((check) => checkName(check) || "unnamed check");
  return {
    number: j.number,
    title: j.title,
    branch: j.headRefName,
    head: j.headRefOid || undefined,
    base: j.baseRefName, // the PR's target — diffstats must be measured against it, not the repo default
    url: j.url,
    state: j.state,
    isDraft: Boolean(j.isDraft),
    autoMergeEnabled: Boolean(j.autoMergeRequest),
    ciStatus: rollupCi(gating),
    reviewStatus: mapReview(j.reviewDecision ?? ""),
    mergeable: (j.mergeable as Mergeable) ?? "UNKNOWN",
    previewUrl: j.comments ? extractPreviewUrl(j.comments) : undefined,
    hasPreviewLabel: previewLabelName ? (j.labels ?? []).some((l) => l.name === previewLabelName) : undefined,
    externalFeedback: countExternalFeedback(j.author?.login ?? "", j.comments, j.reviews),
    failingChecks: failingChecks.length ? failingChecks : undefined,
    feedback: feedback.length ? feedback : undefined,
    additions: j.additions ?? 0,
    deletions: j.deletions ?? 0,
  };
};

/** List the current user's open PRs with status — the source of truth for the kanban. Fetches CI,
 *  comments + reviews too (there are few of your own PRs) so the board shows checks, links the deploy
 *  preview, and "Follow PR" can react to new reviewer feedback. */
export async function listPrs(cwd: string, previewLabelName = "preview"): Promise<PrSummary[]> {
  const raw = await gh(cwd, "pr", "list", "--state", "open", "--author", "@me", "--json", `${PR_META_FIELDS},statusCheckRollup,comments,author,reviews,labels`);
  const prs = JSON.parse(raw) as RawPr[];
  // Resolve each distinct base branch's required-check set once, so CI status reflects only checks
  // that actually gate merge (advisory bots like an AI reviewer don't turn the badge red).
  const bases = [...new Set(prs.map((p) => p.baseRefName).filter((b): b is string => Boolean(b)))];
  const required = new Map(await Promise.all(bases.map(async (b) => [b, await requiredChecks(cwd, b)] as const)));
  return prs.map((j) => mapSummary(j, (j.baseRefName && required.get(j.baseRefName)) || new Set(), previewLabelName));
}

const REQUIRED_TTL_MS = 5 * 60_000;
const requiredCache = new Map<string, { at: number; checks: Set<string> }>();

/** The check names that GATE merge for a branch — GitHub's own required status checks (classic branch
 *  protection AND rulesets, already merged by the `rules/branches` endpoint), read once per base and
 *  cached. Everything else (advisory bots) is ignored when deciding CI pass/fail. An empty set (no
 *  protection, or any error/permission issue) means callers don't filter — preserving all-checks
 *  behaviour so a repo without protection still surfaces failures. */
export async function requiredChecks(cwd: string, branch: string): Promise<Set<string>> {
  const key = `${cwd}::${branch}`;
  const hit = requiredCache.get(key);
  if (hit && Date.now() - hit.at < REQUIRED_TTL_MS) return hit.checks;
  const checks = new Set<string>();
  try {
    const raw = await gh(cwd, "api", `repos/{owner}/{repo}/rules/branches/${branch}`);
    const rules = JSON.parse(raw) as Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }>;
    for (const r of rules) if (r.type === "required_status_checks") for (const c of r.parameters?.required_status_checks ?? []) if (c.context) checks.add(c.context);
  } catch { /* no protection / no access → empty set → callers keep the all-checks behaviour */ }
  requiredCache.set(key, { at: Date.now(), checks });
  return checks;
}

export type ReviewPr = PrSummary & { author: string; authorName: string; updatedAt: string };

const REVIEW_FIELDS = "number,title,headRefName,baseRefName,url,state,isDraft,reviewDecision,author,updatedAt";

async function fetchReviewPrs(cwd: string): Promise<ReviewPr[]> {
  // `-author:@me` (gh expands @me to the authenticated user) excludes your own PRs server-side.
  // High limit so the queue shows *all* open coworker PRs (gh's default is only 30).
  // Fields GitHub computes PER PR (mergeable, autoMergeRequest) are left out: over ~250 PRs they add
  // seconds, and the queue doesn't show them — the PR page fetches its own (prDetail). reviewDecision
  // stays: approved / changes requested is what a review queue is for.
  const raw = await gh(cwd, "pr", "list", "--state", "open", "--search", "-author:@me", "--limit", "500",
    "--json", REVIEW_FIELDS);
  const arr = JSON.parse(raw) as Array<RawPr & { author?: { login?: string; name?: string }; updatedAt?: string }>;
  return arr
    .map((j) => ({ ...mapSummary(j), author: j.author?.login ?? "", authorName: j.author?.name || j.author?.login || "", updatedAt: j.updatedAt ?? "" }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// The review queue re-fetches on every page mount + a 15s client poll, per repo — but each `gh pr
// list` is a ~3s network round-trip, and coworker PRs change slowly. So cache per repo and serve
// stale-while-revalidate: return the cached list instantly, refreshing in the background when it's
// older than the TTL. First load pays the round-trip — which the bridge does itself at startup
// (index.ts), so no caller ever waits the ~5-12s cold fetch; every call after is instant.
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
  /** A submitted review: its state, plus (when it has one) its top-level body, when and where. */
  reviews: { author: string; state: string; body?: string; submittedAt?: string; url?: string; bot?: boolean }[];
  comments: { author: string; body: string; createdAt?: string; url?: string; bot?: boolean }[];
  checks: PrCheck[];
  previewUrl?: string;
  autoMergeEnabled: boolean;
};

/** One check on the PR page: its outcome, the logs link, and when it ran (for its duration).
 *  `skipped` marks a SKIPPED / NEUTRAL conclusion — passing for the rollup, but not worth a row. */
export type PrCheck = { name: string; status: CiStatus; url?: string; startedAt?: string; completedAt?: string; skipped?: boolean };

function prCheck(c: any): PrCheck {
  const o = c.conclusion || c.state || "";
  const check: PrCheck = { name: c.name ?? c.context ?? "check", status: checkOutcome(c) };
  const url = c.detailsUrl || c.targetUrl;
  if (url) check.url = url;
  if (c.startedAt) check.startedAt = c.startedAt;
  if (c.completedAt) check.completedAt = c.completedAt;
  if (o === "SKIPPED" || o === "NEUTRAL") check.skipped = true;
  return check;
}

function checkOutcome(c: { conclusion?: string; state?: string }): CiStatus {
  const o = c.conclusion || c.state || "PENDING";
  if (FAIL.has(o)) return "failing";
  if (PASS.has(o)) return "passing";
  return "pending";
}

/** Drop the keys gh didn't give us, so a sparse fixture or an old PR reads back unchanged. */
const defined = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

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
    reviews: (j.reviews ?? []).map((r: any) => defined({
      author: r.author?.login ?? "", state: r.state, body: r.body?.trim() || undefined, submittedAt: r.submittedAt, url: r.url, bot: botLogin(r.author?.login) || r.author?.is_bot || undefined,
    })),
    comments: (j.comments ?? []).map((c: any) => defined({
      author: c.author?.login ?? "", body: c.body ?? "", createdAt: c.createdAt, url: c.url, bot: botLogin(c.author?.login) || c.author?.is_bot || undefined,
    })),
    checks: (j.statusCheckRollup ?? []).map(prCheck),
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

type RawMergedPr = { number: number; title: string; headRefName: string; url: string; mergedAt: string; headRefOid?: string };
const MERGED_TTL_MS = 15_000;
const mergedCache = new Map<string, { at: number; rows: RawMergedPr[]; inflight?: Promise<RawMergedPr[]> }>();

/** One shared merged-PR query powers both cleanup and the Done lane. */
async function mergedRows(cwd: string): Promise<RawMergedPr[]> {
  const hit = mergedCache.get(cwd);
  if (hit && Date.now() - hit.at < MERGED_TTL_MS) return hit.rows;
  if (hit?.inflight) return hit.inflight;
  const inflight = gh(cwd, "pr", "list", "--state", "merged", "--author", "@me", "--limit", "50",
    "--json", "number,title,headRefName,url,mergedAt,headRefOid")
    .then((raw) => {
      const rows = JSON.parse(raw) as RawMergedPr[];
      mergedCache.set(cwd, { at: Date.now(), rows });
      return rows;
    })
    .catch((error) => { mergedCache.delete(cwd); throw error; });
  mergedCache.set(cwd, { at: hit?.at ?? 0, rows: hit?.rows ?? [], inflight });
  return inflight;
}

/** The current user's PRs merged since `since` (ms epoch) — the Done lane.
 *
 *  The boundary comes from the CLIENT, because "today" is a property of the person looking at the
 *  board, not of the machine running the bridge. Those were the same thing while Orca ran on your
 *  laptop; once it runs on a box in another timezone, a server-local midnight silently empties or
 *  over-fills the lane. Falls back to the server's own day when a caller doesn't say. */
export async function listMerged(cwd: string, since?: number): Promise<MergedPr[]> {
  const arr = await mergedRows(cwd);
  const boundary = since ?? (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  return arr
    .filter((j) => j.mergedAt && Date.parse(j.mergedAt) >= boundary)
    .map((j) => ({ number: j.number, title: j.title, branch: j.headRefName, url: j.url, mergedAt: j.mergedAt }));
}

/** Branch names of the user's merged PRs (not date-filtered) — used to reap their leftover worktrees. */
// The user's recently CLOSED PRs — so a PR you closed/deleted gets its worktree reaped, not just
// merged ones. Cached like merged so the hot agents-poll pays one cheap list at most every TTL. No
// body/CI, so it stays fast even on a big repo. (gh's "closed" includes merged PRs: `mergedAt` tells.)
type RawClosedPr = { headRefName: string; headRefOid?: string; closedAt?: string; mergedAt?: string | null };
const closedCache = new Map<string, { at: number; rows: RawClosedPr[]; inflight?: Promise<RawClosedPr[]> }>();
async function closedRows(cwd: string): Promise<RawClosedPr[]> {
  const hit = closedCache.get(cwd);
  if (hit && Date.now() - hit.at < MERGED_TTL_MS) return hit.rows;
  if (hit?.inflight) return hit.inflight;
  const inflight = gh(cwd, "pr", "list", "--state", "closed", "--author", "@me", "--limit", "50", "--json", "headRefName,headRefOid,closedAt,mergedAt")
    .then((raw) => {
      const rows = (JSON.parse(raw) as RawClosedPr[]).filter((j) => j.headRefName);
      closedCache.set(cwd, { at: Date.now(), rows });
      return rows;
    })
    .catch((error) => { closedCache.delete(cwd); throw error; });
  closedCache.set(cwd, { at: hit?.at ?? 0, rows: hit?.rows ?? [], inflight });
  return inflight;
}

export async function closedBranches(cwd: string): Promise<Set<string>> {
  return new Set((await closedRows(cwd)).map((j) => j.headRefName));
}

/** A branch whose PR is done with: how (merged wins over closed), when (ms, for the cleanup grace
 *  period) and the PR's last head commit (what "pushed" means once GitHub deletes the branch). The
 *  newest PR per branch wins — gh lists newest first. */
export type DonePr = { reason: "merged" | "closed"; at?: number; head?: string };
export async function donePrs(cwd: string): Promise<Map<string, DonePr>> {
  const [merged, closed] = await Promise.all([mergedRows(cwd), closedRows(cwd).catch(() => [] as RawClosedPr[])]);
  const out = new Map<string, DonePr>();
  const at = (iso?: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : undefined);
  for (const j of merged) if (j.headRefName && j.mergedAt && !out.has(j.headRefName)) out.set(j.headRefName, { reason: "merged", at: at(j.mergedAt), head: j.headRefOid || undefined });
  for (const j of closed) {
    if (out.has(j.headRefName)) continue;
    out.set(j.headRefName, j.mergedAt
      ? { reason: "merged", at: at(j.mergedAt), head: j.headRefOid || undefined }
      : { reason: "closed", at: at(j.closedAt), head: j.headRefOid || undefined });
  }
  return out;
}

export async function mergedBranches(cwd: string): Promise<Set<string>> {
  return new Set((await mergedRows(cwd)).map((j) => j.headRefName));
}

/** Close a PR without merging (best-effort). */
export const closePr = (cwd: string, pr: number) => gh(cwd, "pr", "close", String(pr));

/** Add a label to a PR (e.g. to trigger the deploy-preview action). */
export const addLabel = (cwd: string, pr: number, label: string) =>
  gh(cwd, "pr", "edit", String(pr), "--add-label", label);

/** Rename a PR — the GitHub title is the card's title for a PR row, so this is how a rename sticks. */
export const editTitle = (cwd: string, pr: number, title: string) =>
  gh(cwd, "pr", "edit", String(pr), "--title", title);

/** Mark a draft PR ready for review. */
export const markReady = (cwd: string, pr: number) => gh(cwd, "pr", "ready", String(pr));

/** Convert an open PR back to a draft. */
export const convertToDraft = (cwd: string, pr: number) => gh(cwd, "pr", "ready", String(pr), "--undo");

// A PR in a GitHub *stack* can't be merged through the mutation `gh pr merge` uses — GitHub answers
// "This pull request is part of a stack and must be merged using the asynchronous merge REST API".
// That API (PUT …/merge-async) merges the whole stack up to and including the PR, in the background.
const STACKED = /part of a stack/i;

/** Merge (or, with `auto`, queue) a stacked PR through the asynchronous merge API, then wait a
 *  little for the background merge to land so a failure surfaces here rather than on the next poll.
 *  `merge_action: default` lets GitHub pick the merge queue when the base requires one. */
async function mergeAsync(cwd: string, pr: number, auto: boolean): Promise<void> {
  const raw = await gh(cwd, "api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${pr}/merge-async`, "-f", "merge_method=squash", "-f", `merge_action=${auto ? "default" : "direct_merge"}`);
  let res = JSON.parse(raw) as { status: string; details?: { uuid?: string; message?: string } };
  // ponytail: ~20s of polling, then trust the board's own PR poll to show the result.
  for (let i = 0; i < 10 && res.status === "pending" && res.details?.uuid; i++) {
    await Bun.sleep(2_000);
    res = JSON.parse(await gh(cwd, "api", `repos/{owner}/{repo}/pulls/${pr}/merge-async/${res.details.uuid}`));
  }
  if (res.status === "failed") throw new Error(`stacked merge of PR #${pr} failed: ${res.details?.message ?? "see the PR on GitHub"}`);
}

/** Squash-merge a PR. A PR that is part of a stack falls back to the asynchronous merge API. */
export async function mergePr(cwd: string, pr: number): Promise<void> {
  await gh(cwd, "pr", "merge", String(pr), "--squash").catch((e: Error) => STACKED.test(e.message) ? mergeAsync(cwd, pr, false) : Promise.reject(e));
}

// A repo without "Allow auto-merge" in its settings refuses `--auto` outright: "GraphQL: Auto merge is
// not allowed for this repository (enablePullRequestAutoMerge)".
const AUTO_NOT_ALLOWED = /auto merge is not allowed/i;

/** Enable auto-merge: GitHub squash-merges the PR once its required checks + reviews pass. A stacked
 *  PR has no auto-merge toggle; it goes through the asynchronous merge API instead. On a repo that
 *  doesn't allow auto-merge, a PR that is safe to merge now is merged directly (`mergePr`, which keeps
 *  the stacked fallback); otherwise the refusal surfaces with what to do about it. */
export const enableAutoMerge = (cwd: string, pr: number) =>
  gh(cwd, "pr", "merge", String(pr), "--auto", "--squash").catch(async (e: Error) => {
    if (STACKED.test(e.message)) return mergeAsync(cwd, pr, true);
    if (!AUTO_NOT_ALLOWED.test(e.message)) throw e;
    if (mergeSafe(await prStatus(cwd, pr))) return mergePr(cwd, pr);
    throw new Error(`${e.message}\nEnable auto-merge in the repo settings, or merge when green.`);
  });

/** Disable auto-merge: GitHub cancels the queued auto-merge on the PR. */
export const disableAutoMerge = (cwd: string, pr: number) =>
  gh(cwd, "pr", "merge", String(pr), "--disable-auto");

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

/** Everything the merge queue (server/mergeQueue.ts) weighs about one PR, in one `gh pr view`. */
export type PrMergeGate = PrStatus & {
  number: number; title: string; branch: string; url: string; isDraft: boolean; headSha: string;
  /** Changed paths as GitHub lists them — capped by gh, so `changedFiles` is the true count. */
  files: string[]; changedFiles: number; failingChecks: string[];
};
export async function prMergeGate(cwd: string, pr: number): Promise<PrMergeGate> {
  const raw = await gh(cwd, "pr", "view", String(pr), "--json",
    "number,title,headRefName,url,isDraft,headRefOid,state,mergeable,reviewDecision,statusCheckRollup,files,changedFiles");
  const j = JSON.parse(raw) as {
    number: number; title: string; headRefName: string; url: string; isDraft: boolean; headRefOid: string;
    state: string; mergeable: string; reviewDecision: string; changedFiles?: number; files?: Array<{ path: string }>;
    statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string }>;
  };
  const checks = j.statusCheckRollup ?? [];
  const files = (j.files ?? []).map((f) => f.path);
  return {
    number: j.number, title: j.title, branch: j.headRefName, url: j.url, isDraft: Boolean(j.isDraft), headSha: j.headRefOid,
    state: j.state, ciStatus: rollupCi(checks), reviewStatus: mapReview(j.reviewDecision ?? ""), mergeable: (j.mergeable as Mergeable) ?? "UNKNOWN",
    files, changedFiles: j.changedFiles ?? files.length,
    failingChecks: checks.filter((c) => FAIL.has(c.conclusion || c.state || "")).map((c) => c.name || c.context || "check"),
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
