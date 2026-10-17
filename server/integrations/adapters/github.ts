// The GitHub poller adapter (docs/research/integrations.md phase 5, docs/integrations/ADAPTERS.md).
// Each tick reads, per watched repo: the PR list (newest updated first, paginated until the cursor),
// the check runs of each open PR's head, and the review comments since the cursor. Every GET sends
// the ETag it got last time, kept in `integration_cursor` with a small snapshot of each open PR, so a
// quiet repo costs only 304s (which GitHub does not count against the rate limit) and a restart
// neither loses its place nor floods. The diff of two snapshots becomes `orca.pr.*` envelopes for
// `ctx.ingest`; subscriptions route them on (Slack, Discord, email). There is no actor: the
// integration is the sender, so its link (the repo `owner/name`, or `*`) must be `ask` or above.
//
// Keys are shared with Orca's own emitters where one exists (`pr-ci:<repo>#<n>@<sha>` from the
// `/api/prs` notification, `merged:<repo>#<n>` from the merge queue), so an event that both see is
// ONE event. The first poll of a repo is a baseline: it records state and emits nothing.
import type { Adapter, AdapterContext, Connection } from "../adapter";
import type { Capabilities, InboundEnvelope, SendResult, Topic } from "../../../shared/integrations";
import { conditionalGet, GitHubRateLimitError, repoSlug, tokenForUser, type Page } from "../../github";
import { loadConfig } from "../../config";

export const GITHUB_CAPS: Capabilities = {
  inbound: "poll", outbound: false, threads: false, edits: false, reactions: false, attachments: false, maxTextLength: 65_000,
};

export const DEFAULT_INTERVAL_S = 60;
/** At most this many pages of PRs or comments per repo per tick (100 a page). */
export const MAX_PAGES = 10;

/** One watched repo: GitHub's `owner/name`, Orca's repo name (the `repo` of a scope and a key), and
 *  the login whose token reads it when the integration has no secret. */
export type Watch = { slug: string; repo: string; githubUser?: string };

/** The connection's non-secret settings. `repos` absent = every configured repo with a GitHub origin. */
export type GithubConfig = {
  repos?: (string | Watch)[];
  intervalSeconds?: number;
  githubUser?: string;
};

// ── the cursor ───────────────────────────────────────────────────────────────────────────────────

export type CiVerdict = "none" | "pending" | "failed" | "passed";
export type PrSnap = { head: string; branch: string; title: string; url: string; reviewers: string[]; ci?: CiVerdict };
export type RepoCursor = {
  /** The PR list's newest `updated_at` seen; older pages are not read again. */
  prsSince?: string;
  /** The review comments' newest `updated_at` seen (GitHub's `since`, which is inclusive)... */
  commentsSince?: string;
  /** ...and the ids already handled at exactly that time, so the next read skips them. */
  commentIds?: number[];
  /** ETag per request path. */
  etags: Record<string, string>;
  /** Open PRs only, by number. */
  prs: Record<string, PrSnap>;
};
export type GithubCursor = { v: 1; repos: Record<string, RepoCursor> };

export function parseCursor(v: string | undefined): GithubCursor {
  try {
    const c = v ? JSON.parse(v) : undefined;
    if (c?.v === 1 && c.repos && typeof c.repos === "object") return c as GithubCursor;
  } catch { /* a bad cursor is a fresh start */ }
  return { v: 1, repos: {} };
}

// ── GitHub's shapes (the fields read) ────────────────────────────────────────────────────────────

export type GhPull = {
  number: number; title: string; html_url: string; state: "open" | "closed"; draft?: boolean;
  created_at: string; updated_at: string; merged_at?: string | null;
  user?: { login: string }; head: { ref: string; sha: string }; base?: { ref: string };
  requested_reviewers?: { login: string }[]; requested_teams?: { slug: string }[];
};
export type GhCheckRun = { name: string; status: string; conclusion: string | null };
export type GhReviewComment = {
  id: number; body: string; html_url: string; path?: string; line?: number | null;
  created_at: string; updated_at: string; user?: { login: string }; pull_request_url: string;
};

// ── pure decisions ───────────────────────────────────────────────────────────────────────────────

const PASSING = new Set(["success", "neutral", "skipped"]);

/** One verdict over a head's check runs: no runs yet is `none` (NOT green: a fresh push has none),
 *  any failed run is `failed`, any unfinished run is `pending`, else `passed`. */
export function ciVerdict(runs: GhCheckRun[]): CiVerdict {
  if (!runs.length) return "none";
  if (runs.some((r) => r.status === "completed" && r.conclusion && !PASSING.has(r.conclusion))) return "failed";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return "passed";
}

const reviewersOf = (p: GhPull): string[] =>
  [...(p.requested_reviewers ?? []).map((u) => u.login), ...(p.requested_teams ?? []).map((t) => `team:${t.slug}`)].sort();

const snapOf = (p: GhPull, prev?: PrSnap): PrSnap => ({
  head: p.head.sha, branch: p.head.ref, title: p.title, url: p.html_url, reviewers: reviewersOf(p),
  ...(prev && prev.head === p.head.sha && prev.ci ? { ci: prev.ci } : {}),
});

type Make = (topic: Topic, key: string, s: Pick<PrSnap, "branch" | "title" | "url">, n: number, text: string, raw?: unknown) => InboundEnvelope;

/** The envelope maker for one repo. `thread` names the PR (`owner/name#12`), Orca's thread id for
 *  GitHub (§3.6); `scope.branch` is the PR's head branch, so a workstream's subscription matches. */
export const envelopeMaker = (w: Watch, integrationId: string | undefined, at: number): Make =>
  (topic, key, s, n, text, raw) => ({
    key, topic, at,
    source: { adapter: "github", ...(integrationId ? { integrationId } : {}), channel: w.slug },
    scope: { repo: w.repo, branch: s.branch },
    thread: { adapter: "github", externalId: `${w.slug}#${n}` },
    title: `#${n} ${s.title}`, text,
    link: { url: s.url, pr: n },
    ...(raw !== undefined ? { raw } : {}),
  });

/** What the PR list says happened since `prev` (open PRs only). `baseline` = first look: record,
 *  emit nothing. Returns the envelopes and the next snapshot. A PR not in the pages read keeps its
 *  snapshot: it did not change. */
export function diffPulls(pulls: GhPull[], prev: Record<string, PrSnap>, make: Make, w: Watch, baseline: boolean): { events: InboundEnvelope[]; prs: Record<string, PrSnap> } {
  const prs = { ...prev };
  const events: InboundEnvelope[] = [];
  for (const p of pulls) {
    const n = String(p.number);
    const was = prev[n];
    if (p.state === "open") {
      const now = snapOf(p, was);
      prs[n] = now;
      if (baseline) continue;
      if (!was) {
        events.push(make("orca.pr.opened", `pr-opened:${w.repo}#${n}`, now, p.number,
          `${p.user?.login ?? "Someone"} opened${p.draft ? " draft" : ""} PR #${n} ${p.head.ref} → ${p.base?.ref ?? "base"}.`,
          { number: p.number, author: p.user?.login, draft: !!p.draft, head: p.head.sha }));
      }
      const before = new Set(was?.reviewers ?? []);
      for (const r of now.reviewers) {
        if (before.has(r)) continue;
        events.push(make("orca.pr.review_requested", `pr-review-requested:${w.repo}#${n}:${r}@${p.head.sha}`, now, p.number,
          `Review requested from ${r} on PR #${n}.`, { number: p.number, reviewer: r, head: p.head.sha }));
      }
    } else {
      delete prs[n];
      if (baseline || !p.merged_at) continue;
      const s = was ?? snapOf(p);
      events.push(make("orca.pr.merged", `merged:${w.repo}#${n}`, s, p.number, `PR #${n} was merged.`,
        { number: p.number, mergedAt: p.merged_at, head: p.head.sha }));
    }
  }
  return { events, prs };
}

/** The CI event for one head whose verdict moved, else undefined. Only a settled verdict (failed or
 *  passed) is news; pending and none are recorded quietly. */
export function ciEvent(n: number, snap: PrSnap, verdict: CiVerdict, runs: GhCheckRun[], make: Make, w: Watch): InboundEnvelope | undefined {
  if (verdict === snap.ci || (verdict !== "failed" && verdict !== "passed")) return undefined;
  if (verdict === "failed") {
    const failing = runs.filter((r) => r.status === "completed" && r.conclusion && !PASSING.has(r.conclusion)).map((r) => r.name);
    return make("orca.pr.ci_failed", `pr-ci:${w.repo}#${n}@${snap.head}`, snap, n, `CI failed on PR #${n}: ${failing.join(", ")}.`,
      { number: n, head: snap.head, failing });
  }
  return make("orca.pr.ci_passed", `pr-ci-passed:${w.repo}#${n}@${snap.head}`, snap, n, `CI passed on PR #${n} (${runs.length} checks).`,
    { number: n, head: snap.head, checks: runs.length });
}

/** One review comment as an event. New comments only: an edit (same id) is a duplicate key. */
export function commentEvent(c: GhReviewComment, snap: Pick<PrSnap, "branch" | "title" | "url"> | undefined, make: Make, w: Watch): InboundEnvelope | undefined {
  const n = Number(/\/pulls\/(\d+)$/.exec(c.pull_request_url)?.[1]);
  if (!n) return undefined;
  const s = snap ?? { branch: "", title: `PR #${n}`, url: c.html_url };
  const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : "";
  const e = make("orca.pr.review_comment", `pr-review-comment:${w.repo}:${c.id}`, { ...s, url: c.html_url }, n,
    `${c.user?.login ?? "Someone"} commented${where}: ${c.body}`,
    { number: n, commentId: c.id, author: c.user?.login, path: c.path, line: c.line ?? undefined });
  return snap ? e : { ...e, scope: { repo: w.repo } };
}

/** The repos to watch, from the connection's config. */
export function watchesOf(cfg: GithubConfig): Watch[] {
  return (cfg.repos ?? []).flatMap((r): Watch[] => {
    if (typeof r === "string") return /^[\w.-]+\/[\w.-]+$/.test(r) ? [{ slug: r, repo: r.split("/")[1]!, ...(cfg.githubUser ? { githubUser: cfg.githubUser } : {}) }] : [];
    return r && typeof r.slug === "string" ? [{ slug: r.slug, repo: r.repo || r.slug.split("/")[1]!, ...(r.githubUser ?? cfg.githubUser ? { githubUser: r.githubUser ?? cfg.githubUser } : {}) }] : [];
  });
}

/** Every configured repo with a GitHub origin (config.repos absent). */
async function configuredWatches(): Promise<Watch[]> {
  const cfg = await loadConfig();
  const out: Watch[] = [];
  for (const r of cfg.repos) {
    const slug = await repoSlug(r.repoPath).catch(() => undefined);
    if (slug) out.push({ slug, repo: r.name, ...(r.githubUser ? { githubUser: r.githubUser } : {}) });
  }
  return out;
}

// ── I/O: one poll ────────────────────────────────────────────────────────────────────────────────

/** Read pages from `path` with its stored ETag, following `next` while `more(page)` says so. A 304
 *  on the first page is `undefined`: nothing changed. Only the first page's ETag is kept. */
async function pages<T>(path: string, token: string, rc: RepoCursor, more: (page: T[]) => boolean): Promise<T[] | undefined> {
  const first: Page<T[]> = await conditionalGet<T[]>(path, { token, etag: rc.etags[path] });
  if (first.notModified) return undefined;
  if (first.etag) rc.etags[path] = first.etag; else delete rc.etags[path];
  const out = [...(first.body ?? [])];
  let next = first.next, n = 1, last = first.body ?? [];
  while (next && n < MAX_PAGES && more(last)) {
    const p = await conditionalGet<T[]>(next, { token });
    if (p.notModified) break;
    last = p.body ?? [];
    out.push(...last);
    next = p.next;
    n++;
  }
  return out;
}

export type PollResult = { events: number; ingested: Record<"new" | "duplicate" | "rejected", number>; notModified: number };

/** One tick over one repo. Mutates `cur.repos[w.slug]`; the caller saves the cursor. */
export async function pollRepo(w: Watch, token: string, cur: GithubCursor, ingest: AdapterContext["ingest"], integrationId?: string, now = Date.now()): Promise<PollResult> {
  const result: PollResult = { events: 0, ingested: { new: 0, duplicate: 0, rejected: 0 }, notModified: 0 };
  const baseline = !cur.repos[w.slug];
  const rc: RepoCursor = cur.repos[w.slug] ?? { etags: {}, prs: {} };
  const make = envelopeMaker(w, integrationId, now);
  const send = async (e: InboundEnvelope) => { result.events++; result.ingested[await ingest(e)]++; };

  // 1. The PR list. The baseline reads every OPEN PR (closed ones are history) and starts the cursor
  //    at now; after it, every PR newest updated first, until the cursor.
  const since = rc.prsSince;
  const listPath = baseline
    ? `repos/${w.slug}/pulls?state=open&per_page=100`
    : `repos/${w.slug}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  const pulls = await pages<GhPull>(listPath, token, rc, (page) => baseline || (!!since && page.length > 0 && page.at(-1)!.updated_at > since));
  if (!pulls) result.notModified++;
  else {
    const fresh = baseline || !since ? pulls : pulls.filter((p) => p.updated_at > since);
    const d = diffPulls(fresh, rc.prs, make, w, baseline);
    rc.prs = d.prs;
    for (const e of d.events) await send(e);
    const newest = baseline ? new Date(now).toISOString() : pulls.reduce((m, p) => (p.updated_at > m ? p.updated_at : m), since ?? "");
    if (newest) rc.prsSince = newest;
  }
  if (baseline) delete rc.etags[listPath]; // the state=open list is read once

  // 2. CI per open PR head. A push changes the head, so the path (and its ETag) is new.
  const heads = new Set<string>();
  for (const [n, snap] of Object.entries(rc.prs)) {
    const path = `repos/${w.slug}/commits/${snap.head}/check-runs?per_page=100`;
    heads.add(path);
    const page = await conditionalGet<{ check_runs: GhCheckRun[] }>(path, { token, etag: rc.etags[path] });
    if (page.notModified) { result.notModified++; continue; }
    if (page.etag) rc.etags[path] = page.etag;
    const runs = page.body?.check_runs ?? [];
    const verdict = ciVerdict(runs);
    const e = baseline ? undefined : ciEvent(Number(n), snap, verdict, runs, make, w);
    rc.prs[n] = { ...snap, ci: verdict };
    if (e) await send(e);
  }
  for (const p of Object.keys(rc.etags)) if (p.includes("/check-runs") && !heads.has(p)) delete rc.etags[p];

  // 3. Review comments since the cursor. The baseline starts the cursor at now: no history.
  if (baseline) rc.commentsSince = new Date(now).toISOString();
  else {
    const cs = rc.commentsSince ?? new Date(now).toISOString();
    const path = `repos/${w.slug}/pulls/comments?sort=updated&direction=asc&since=${encodeURIComponent(cs)}&per_page=100`;
    const comments = await pages<GhReviewComment>(path, token, rc, () => true);
    if (!comments) result.notModified++;
    else {
      for (const p of Object.keys(rc.etags)) if (p.includes("/pulls/comments") && p !== path) delete rc.etags[p];
      const done = new Set(rc.commentIds ?? []);
      for (const c of comments) {
        if (c.created_at < cs || done.has(c.id)) continue; // an edit of an older comment, or one already handled
        const n = /\/pulls\/(\d+)$/.exec(c.pull_request_url)?.[1];
        const e = commentEvent(c, n ? rc.prs[n] : undefined, make, w);
        if (e) await send(e);
      }
      const newest = comments.reduce((m, c) => (c.updated_at > m ? c.updated_at : m), cs);
      rc.commentIds = [...(newest === cs ? done : []), ...comments.filter((c) => c.updated_at === newest).map((c) => c.id)];
      rc.commentsSince = newest;
    }
  }

  cur.repos[w.slug] = rc;
  return result;
}

/** One tick over every watched repo: read the cursor, poll, save the cursor after EACH repo (an
 *  ingest is idempotent on its key, so a crash before the save only re-ingests duplicates). A
 *  rate-limited repo is skipped until its reset; any other error ends that repo's tick. */
export async function pollOnce(ctx: Pick<AdapterContext, "ingest" | "cursor" | "secret" | "connection" | "log">, watches: Watch[], now = Date.now()): Promise<{ results: Record<string, PollResult>; errors: Record<string, string>; rateLimitedUntil?: number }> {
  const cur = parseCursor(await ctx.cursor.get());
  const results: Record<string, PollResult> = {};
  const errors: Record<string, string> = {};
  let rateLimitedUntil: number | undefined;
  for (const w of watches) {
    try {
      const token = ctx.secret() ?? await tokenForUser(w.githubUser);
      results[w.slug] = await pollRepo(w, token, cur, ctx.ingest, ctx.connection.id, now);
      await ctx.cursor.set(JSON.stringify(cur));
    } catch (e) {
      if (e instanceof GitHubRateLimitError) rateLimitedUntil = Math.max(rateLimitedUntil ?? 0, e.resetAt);
      errors[w.slug] = e instanceof Error ? e.message : String(e);
      ctx.log(`${w.slug}: ${errors[w.slug]}`);
    }
  }
  return { results, errors, ...(rateLimitedUntil ? { rateLimitedUntil } : {}) };
}

// ── the adapter ──────────────────────────────────────────────────────────────────────────────────

export function githubAdapter(connection: Connection): Adapter {
  const cfg = connection.config as GithubConfig;
  const intervalMs = Math.max(15, Number(cfg.intervalSeconds) || DEFAULT_INTERVAL_S) * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: { ok: boolean; detail?: string; lastEventAt?: number } = { ok: true, detail: "starting" };
  let stopped = false;

  const tick = async (ctx: AdapterContext) => {
    if (stopped || ctx.signal.aborted) return;
    let wait = intervalMs;
    try {
      const watches = cfg.repos ? watchesOf(cfg) : await configuredWatches();
      const r = await pollOnce(ctx, watches);
      const errs = Object.entries(r.errors);
      const events = Object.values(r.results).reduce((s, x) => s + x.events, 0);
      last = {
        ok: errs.length === 0,
        ...(errs.length ? { detail: errs.map(([s, m]) => `${s}: ${m}`).join("; ").slice(0, 500) } : { detail: `${watches.length} repos` }),
        ...(events ? { lastEventAt: Date.now() } : last.lastEventAt ? { lastEventAt: last.lastEventAt } : {}),
      };
      if (r.rateLimitedUntil) wait = Math.max(wait, r.rateLimitedUntil - Date.now());
    } catch (e) {
      last = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    await ctx.status(last).catch(() => {});
    if (!stopped && !ctx.signal.aborted) timer = setTimeout(() => void tick(ctx), wait);
  };

  return {
    kind: "github",
    caps: GITHUB_CAPS,
    async start(ctx) {
      ctx.signal.addEventListener("abort", () => { stopped = true; if (timer) clearTimeout(timer); });
      timer = setTimeout(() => void tick(ctx), 0);
    },
    async stop() { stopped = true; if (timer) clearTimeout(timer); },
    async send(): Promise<SendResult> {
      return { ok: false, retryable: false, error: "the GitHub adapter only polls; it sends nothing" };
    },
    async health() { return last; },
  };
}
