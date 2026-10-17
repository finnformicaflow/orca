// The GitHub poller adapter (server/integrations/adapters/github.ts) against a fake GitHub: a
// baseline that emits nothing, 304s from the ETags kept in the cursor (also across a restart),
// pagination by `Link`, a rate limit that skips the repo until its reset, and each orca.pr.* topic
// with its key and payload. The last block runs the real router on Postgres: a link and a
// subscription route the event, a key shared with Orca's own notification is ONE event, and a
// poller is not paced like a person.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { conditionalGet, nextLink, resetCaches, setFetch } from "../server/github";
import {
  ciVerdict, parseCursor, pollOnce, watchesOf,
  type GhCheckRun, type GhPull, type GhReviewComment, type Watch,
} from "../server/integrations/adapters/github";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as store from "../server/integrations/store";
import type { InboundEnvelope } from "../shared/integrations";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

// ── the fake GitHub ─────────────────────────────────────────────────────────────────────────────

const SLUG = "acme/app";
const W: Watch = { slug: SLUG, repo: "app" };
const T0 = Date.parse("2026-10-17T10:00:00Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

type Fake = {
  pulls: GhPull[]; checks: Record<string, GhCheckRun[]>; comments: GhReviewComment[];
  pageSize: number; rateLimited?: number; calls: { path: string; etag?: string; status: number }[];
};
let gh: Fake;

const pull = (n: number, over: Partial<GhPull> = {}): GhPull => ({
  number: n, title: `Feature ${n}`, html_url: `https://github.com/${SLUG}/pull/${n}`, state: "open",
  created_at: iso(0), updated_at: iso(0), merged_at: null, user: { login: "finn" },
  head: { ref: `feat-${n}`, sha: `sha${n}a` }, base: { ref: "main" }, requested_reviewers: [], requested_teams: [], ...over,
});

const etagOf = (body: unknown) => `"${createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 12)}"`;

function answer(url: URL, ifNoneMatch?: string): Response {
  const path = url.pathname;
  const json = (body: unknown, headers: Record<string, string> = {}) => {
    const etag = etagOf(body);
    const status = ifNoneMatch === etag ? 304 : 200;
    gh.calls.push({ path: `${path}${url.search}`, etag: ifNoneMatch, status });
    if (status === 304) return new native.Response(null, { status: 304, headers: { etag } });
    return new native.Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", etag, ...headers } });
  };
  if (gh.rateLimited) {
    gh.calls.push({ path, status: 403 });
    return new native.Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(gh.rateLimited / 1000)) },
    });
  }
  const page = Number(url.searchParams.get("page") ?? 1);
  const paged = (all: unknown[]) => {
    const body = all.slice((page - 1) * gh.pageSize, page * gh.pageSize);
    const more = page * gh.pageSize < all.length;
    const next = new URL(url); next.searchParams.set("page", String(page + 1));
    return json(body, more ? { link: `<${next}>; rel="next", <${url}>; rel="last"` } : {});
  };
  if (path === `/repos/${SLUG}/pulls`) {
    const state = url.searchParams.get("state");
    const list = gh.pulls.filter((p) => state === "all" || p.state === state);
    return paged([...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
  }
  const checks = /^\/repos\/acme\/app\/commits\/([^/]+)\/check-runs$/.exec(path);
  if (checks) { const runs = gh.checks[checks[1]!] ?? []; return json({ total_count: runs.length, check_runs: runs }); }
  if (path === `/repos/${SLUG}/pulls/comments`) {
    const since = url.searchParams.get("since") ?? "";
    return paged(gh.comments.filter((c) => c.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at)));
  }
  gh.calls.push({ path, status: 404 });
  return new native.Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
}

// The cursor and ingest the core would give: a string in memory, and a list of envelopes.
let cursorValue: string | undefined;
let got: InboundEnvelope[];
const ctx = (ingest: (e: InboundEnvelope) => Promise<"new" | "duplicate" | "rejected"> = async (e) => { got.push(e); return "new"; }) => ({
  connection: { id: "gh", kind: "github", name: "GitHub", instance: "local", config: {}, enabled: true },
  secret: () => "tok-test",
  ingest,
  cursor: { get: async () => cursorValue, set: async (v: string) => { cursorValue = v; } },
  log: () => {},
});

const savedApi = process.env.ORCA_GITHUB_API_URL;
beforeEach(() => {
  process.env.ORCA_GITHUB_API_URL = "https://api.github.test";
  resetCaches();
  gh = { pulls: [], checks: {}, comments: [], pageSize: 100, calls: [] };
  cursorValue = undefined;
  got = [];
  setFetch((async (url: string, init?: RequestInit) => answer(new URL(url), (init?.headers as Record<string, string> | undefined)?.["If-None-Match"])) as never);
});
afterEach(() => {
  setFetch(undefined);
  resetCaches();
  if (savedApi === undefined) delete process.env.ORCA_GITHUB_API_URL; else process.env.ORCA_GITHUB_API_URL = savedApi;
});

const tick = (minutes: number) => pollOnce(ctx(), [W], T0 + minutes * 60_000);

// ── pure pieces ─────────────────────────────────────────────────────────────────────────────────

test("ciVerdict: no runs is none (not green), any failure fails, anything unfinished is pending", () => {
  expect(ciVerdict([])).toBe("none");
  expect(ciVerdict([{ name: "a", status: "completed", conclusion: "success" }, { name: "b", status: "in_progress", conclusion: null }])).toBe("pending");
  expect(ciVerdict([{ name: "a", status: "completed", conclusion: "failure" }, { name: "b", status: "queued", conclusion: null }])).toBe("failed");
  expect(ciVerdict([{ name: "a", status: "completed", conclusion: "success" }, { name: "b", status: "completed", conclusion: "skipped" }])).toBe("passed");
});

test("config: owner/name strings or objects; the repo name defaults to the slug's name", () => {
  expect(watchesOf({ repos: ["acme/app", "bad", { slug: "me/site", repo: "web", githubUser: "me" }], githubUser: "work" })).toEqual([
    { slug: "acme/app", repo: "app", githubUser: "work" }, { slug: "me/site", repo: "web", githubUser: "me" },
  ]);
  expect(parseCursor("not json")).toEqual({ v: 1, repos: {} });
});

test("nextLink reads rel=next only", () => {
  expect(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=5>; rel="last"')).toBe("https://x/a?page=2");
  expect(nextLink('<https://x/a?page=1>; rel="prev"')).toBeUndefined();
  expect(nextLink(null)).toBeUndefined();
});

// ── the poll ────────────────────────────────────────────────────────────────────────────────────

describe("poll against a fake GitHub", () => {
  test("baseline: records every open PR and its CI, emits nothing; an unchanged repo then costs only 304s", async () => {
    gh.pulls = [pull(1), pull(2, { requested_reviewers: [{ login: "saajan" }] }), pull(3, { state: "closed", merged_at: iso(-5) })];
    gh.checks = { sha1a: [{ name: "test", status: "completed", conclusion: "failure" }] };
    await tick(0);
    expect(got).toEqual([]);
    const c = parseCursor(cursorValue).repos[SLUG]!;
    expect(Object.keys(c.prs).sort()).toEqual(["1", "2"]);
    expect(c.prs["1"]!.ci).toBe("failed");
    expect(c.prs["2"]!.reviewers).toEqual(["saajan"]);

    await tick(1); // the first read of the state=all list and of the comments
    gh.calls = [];
    const r = await tick(2);
    expect(got).toEqual([]);
    expect(gh.calls.map((x) => x.status)).toEqual([304, 304, 304, 304]); // list, two check-runs, comments
    expect(gh.calls.every((x) => x.etag)).toBe(true);
    expect(r.results[SLUG]!.notModified).toBe(4);
  });

  test("every topic: opened, review_requested, ci_failed, ci_passed, review_comment, merged — with keys, scope and payload", async () => {
    await tick(0); // baseline: empty repo

    gh.pulls = [pull(7, { created_at: iso(1), updated_at: iso(1), draft: true, requested_reviewers: [{ login: "saajan" }], requested_teams: [{ slug: "core" }] })];
    gh.checks = { sha7a: [{ name: "lint", status: "completed", conclusion: "success" }, { name: "test", status: "completed", conclusion: "failure" }] };
    await tick(2);
    expect(got.map((e) => [e.topic, e.key])).toEqual([
      ["orca.pr.opened", "pr-opened:app#7"],
      ["orca.pr.review_requested", "pr-review-requested:app#7:saajan@sha7a"],
      ["orca.pr.review_requested", "pr-review-requested:app#7:team:core@sha7a"],
      ["orca.pr.ci_failed", "pr-ci:app#7@sha7a"], // the key /api/prs's notification uses
    ]);
    expect(got[0]).toMatchObject({
      source: { adapter: "github", integrationId: "gh", channel: SLUG },
      scope: { repo: "app", branch: "feat-7" },
      thread: { adapter: "github", externalId: "acme/app#7" },
      title: "#7 Feature 7", text: "finn opened draft PR #7 feat-7 → main.",
      link: { url: "https://github.com/acme/app/pull/7", pr: 7 },
      raw: { number: 7, author: "finn", draft: true, head: "sha7a" },
    });
    expect(got[0]!.actor).toBeUndefined(); // a machine sender
    expect(got[3]).toMatchObject({ text: "CI failed on PR #7: test.", raw: { number: 7, head: "sha7a", failing: ["test"] } });

    // A push: new head, CI green, a review comment.
    got = [];
    gh.pulls = [pull(7, { created_at: iso(1), updated_at: iso(3), head: { ref: "feat-7", sha: "sha7b" }, requested_reviewers: [{ login: "saajan" }], requested_teams: [{ slug: "core" }] })];
    gh.checks = { sha7b: [{ name: "lint", status: "completed", conclusion: "success" }, { name: "test", status: "completed", conclusion: "success" }] };
    gh.comments = [
      { id: 900, body: "old one", html_url: "x", created_at: iso(-60), updated_at: iso(3), user: { login: "saajan" }, pull_request_url: `https://api.github.com/repos/${SLUG}/pulls/7` },
      { id: 901, body: "Rename this.", html_url: `https://github.com/${SLUG}/pull/7#discussion_r901`, path: "src/a.ts", line: 12, created_at: iso(3), updated_at: iso(3), user: { login: "saajan" }, pull_request_url: `https://api.github.com/repos/${SLUG}/pulls/7` },
    ];
    await tick(4);
    expect(got.map((e) => [e.topic, e.key])).toEqual([ // the same reviewers are not asked again
      ["orca.pr.ci_passed", "pr-ci-passed:app#7@sha7b"],
      ["orca.pr.review_comment", "pr-review-comment:app:901"], // 900 is an edit of an older comment
    ]);
    expect(got.find((e) => e.topic === "orca.pr.review_comment")).toMatchObject({
      text: "saajan commented on src/a.ts:12: Rename this.", link: { url: `https://github.com/${SLUG}/pull/7#discussion_r901`, pr: 7 },
      scope: { repo: "app", branch: "feat-7" }, raw: { number: 7, commentId: 901, author: "saajan", path: "src/a.ts", line: 12 },
    });

    // Merged, read by a NEW adapter process from the stored cursor (a restart).
    got = [];
    gh.pulls = [pull(7, { state: "closed", updated_at: iso(5), merged_at: iso(5), head: { ref: "feat-7", sha: "sha7b" } })];
    gh.calls = [];
    await tick(6);
    expect(got.map((e) => [e.topic, e.key, e.text])).toEqual([["orca.pr.merged", "merged:app#7", "PR #7 was merged."]]); // the merge queue's key
    expect(gh.calls[0]!.etag).toBeTruthy(); // the restart sent the stored ETag
    expect(parseCursor(cursorValue).repos[SLUG]!.prs).toEqual({});
    expect(Object.keys(parseCursor(cursorValue).repos[SLUG]!.etags).some((p) => p.includes("check-runs"))).toBe(false); // pruned with its head
  });

  test("a review request on an unchanged head fires once; pending CI is quiet until it settles", async () => {
    gh.pulls = [pull(4)];
    await tick(0);
    gh.pulls = [pull(4, { updated_at: iso(2), requested_reviewers: [{ login: "ana" }] })];
    gh.checks = { sha4a: [{ name: "test", status: "in_progress", conclusion: null }] };
    await tick(2);
    await tick(3);
    expect(got.map((e) => e.key)).toEqual(["pr-review-requested:app#4:ana@sha4a"]);
    gh.checks = { sha4a: [{ name: "test", status: "completed", conclusion: "success" }] };
    await tick(4);
    expect(got.map((e) => e.key)).toEqual(["pr-review-requested:app#4:ana@sha4a", "pr-ci-passed:app#4@sha4a"]);
  });

  test("pagination: the baseline reads every open PR; later ticks follow rel=next only until the cursor", async () => {
    gh.pageSize = 2;
    gh.pulls = [1, 2, 3, 4, 5].map((n) => pull(n, { updated_at: iso(-n) }));
    await tick(0);
    expect(Object.keys(parseCursor(cursorValue).repos[SLUG]!.prs).sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(gh.calls.filter((c) => c.path.includes("state=open")).length).toBe(3); // pages 1, 2, 3

    // Three PRs updated after the cursor (two new), on pages 1-2; page 3 is older: not read.
    gh.pulls = [
      ...[1, 2, 3, 4, 5].map((n) => pull(n, { updated_at: iso(-n) })),
      pull(6, { created_at: iso(1), updated_at: iso(3) }), pull(8, { created_at: iso(1), updated_at: iso(2) }),
      pull(2, { updated_at: iso(1), state: "closed", merged_at: iso(1) }),
    ].filter((p, i, all) => all.findLastIndex((q) => q.number === p.number) === i);
    gh.calls = [];
    await tick(4);
    const listCalls = gh.calls.filter((c) => c.path.includes("/pulls?"));
    expect(listCalls.map((c) => new URL(`https://x${c.path}`).searchParams.get("page") ?? "1")).toEqual(["1", "2"]);
    expect(got.map((e) => e.key)).toEqual(["pr-opened:app#6", "pr-opened:app#8", "merged:app#2"]);
  });

  test("rate limit: the repo is skipped, its cursor kept, and the next call fails fast until the reset", async () => {
    gh.pulls = [pull(1)];
    await tick(0);
    const before = cursorValue;
    gh.rateLimited = Date.now() + 120_000;
    const r = await tick(1);
    expect(r.errors[SLUG]).toContain("rate limit");
    expect(r.rateLimitedUntil).toBeGreaterThan(Date.now());
    expect(cursorValue).toBe(before);
    gh.rateLimited = undefined;
    gh.calls = [];
    const again = await tick(2);
    expect(gh.calls).toEqual([]); // blocked locally: no request until the reset
    expect(again.errors[SLUG]).toContain("rate limit");
  });

  test("conditionalGet: a 304 is notModified; the ETag and the next page come back", async () => {
    gh.pageSize = 1;
    gh.pulls = [pull(1), pull(2)];
    const first = await conditionalGet<GhPull[]>(`repos/${SLUG}/pulls?state=open`, { token: "t" });
    if (first.notModified) throw new Error("expected a body");
    expect(first.body.length).toBe(1);
    expect(first.next).toContain("page=2");
    expect(await conditionalGet(`repos/${SLUG}/pulls?state=open`, { token: "t", etag: first.etag })).toEqual({ notModified: true });
  });
});

// ── through the core ────────────────────────────────────────────────────────────────────────────

describe("through the router (Postgres)", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined>;
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    pg = await freshSchema("githubadapter");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    await store.addIntegration({ id: "gh", kind: "github", name: "GitHub", instance: "local", config: { repos: [SLUG] }, enabled: true });
  });
  afterEach(async () => {
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const real = () => ({ ...ctx((e) => router.ingest("gh", e)), cursor: { get: () => store.cursor("gh"), set: (v: string) => store.setCursor("gh", v) } });

  test("an ask link routes orca.pr.* by subscription; the key /api/prs uses is one event; a poller is not paced", async () => {
    await store.addLink({ id: "acme", integrationId: "gh", externalId: SLUG, level: "ask", repos: [], requireMention: false });
    await store.addSubscription({ topicPattern: "orca.pr.ci_failed", filter: { repo: "app" }, targetKind: "web" });
    await pollOnce(real(), [W], T0); // baseline
    expect(parseCursor(await store.cursor("gh")).repos[SLUG]).toBeDefined();

    // Orca's own /api/prs poll saw the red CI first.
    await router.publish({ key: "pr-ci:app#3@sha3a", topic: "orca.pr.ci_failed", at: T0, source: { adapter: "orca" }, scope: { repo: "app" }, text: "CI is failing." });
    gh.pulls = Array.from({ length: 25 }, (_, i) => pull(i + 1, { created_at: iso(1), updated_at: iso(1) }));
    gh.checks = { sha3a: [{ name: "t", status: "completed", conclusion: "failure" }], sha4a: [{ name: "t", status: "completed", conclusion: "failure" }] };
    const r = await pollOnce(real(), [W], T0 + 120_000);
    expect(r.results[SLUG]!.ingested).toEqual({ new: 26, duplicate: 1, rejected: 0 }); // 25 opened + #4's CI; #3's CI was already there
    expect((await store.event("pr-opened:app#25"))?.grant).toMatchObject({ level: "ask", linkId: "acme" });
    const web = await store.deliveries();
    expect(web.length).toBe(2); // the two ci_failed events, by the subscription
  });

  test("a notify link or no link rejects: the GitHub link must be ask or above", async () => {
    await pollOnce(real(), [W], T0);
    gh.pulls = [pull(1, { created_at: iso(1), updated_at: iso(1) })];
    expect((await pollOnce(real(), [W], T0 + 60_000)).results[SLUG]!.ingested.rejected).toBe(1);
    await store.addLink({ id: "acme", integrationId: "gh", externalId: "*", level: "notify", repos: [], requireMention: false });
    gh.pulls = [pull(2, { created_at: iso(2), updated_at: iso(2) })];
    expect((await pollOnce(real(), [W], T0 + 180_000)).results[SLUG]!.ingested.rejected).toBe(1);
  });
});
