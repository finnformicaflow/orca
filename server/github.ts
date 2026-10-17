// The one GitHub client: REST and GraphQL over `fetch`, no `gh` process per call. Each call runs
// as the account of the repo it is about (RepoConfig.githubUser, else the host's active `gh`
// login), with the token read ONCE per account from `gh auth token` (or GH_TOKEN) and cached.
// Polled GETs send If-None-Match and reuse the cached body on a 304, which GitHub does not count
// against the rate limit. A rate-limited account is blocked until its reset and fails FAST with
// a GitHubRateLimitError. Tokens are never logged or put in an error message.
import { createHash } from "crypto";
import { countGhCall } from "./metrics";
import { githubToken, githubUserFor, scrubbedEnv } from "./env";
import { runCmd } from "./run";

// ---- errors ----

/** Any failed GitHub call. `status` is the HTTP status (0: the request never got an answer). */
export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly path: string) { super(message); this.name = "GitHubError"; }
}
/** 401: the token is missing, revoked or expired. */
export class GitHubAuthError extends GitHubError { constructor(m: string, s: number, p: string) { super(m, s, p); this.name = "GitHubAuthError"; } }
/** 404: no such resource, or the account cannot see it. */
export class GitHubNotFoundError extends GitHubError { constructor(m: string, s: number, p: string) { super(m, s, p); this.name = "GitHubNotFoundError"; } }
/** The account is rate-limited until `resetAt` (ms epoch). */
export class GitHubRateLimitError extends GitHubError {
  constructor(m: string, s: number, p: string, readonly resetAt: number) { super(m, s, p); this.name = "GitHubRateLimitError"; }
}
/** A GraphQL answer with `errors`. The message reads like gh's: `GraphQL: <message> (<path>)`. */
export class GitHubGraphQLError extends GitHubError {
  constructor(m: string, p: string, readonly errors: Array<{ message?: string; type?: string; path?: unknown[] }>) { super(m, 200, p); this.name = "GitHubGraphQLError"; }
}

// ---- seams (tests) ----

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch | undefined;
/** Swap the transport (unit tests). Undefined restores the global `fetch`. */
export function setFetch(f: Fetch | undefined): void { fetchImpl = f; }
const doFetch: Fetch = (input, init) => (fetchImpl ?? fetch)(input, init);

/** The API root. `ORCA_GITHUB_API_URL` points it elsewhere (the tests' fake GitHub). Read per call. */
const apiRoot = () => (process.env.ORCA_GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

// ---- tokens ----

let activeToken: string | undefined;
/** The token for calls made about `cwd`: its repo's pinned account, else GH_TOKEN / GITHUB_TOKEN,
 *  else the active `gh` login's (`gh auth token`, read once). */
export async function tokenFor(cwd?: string): Promise<string> {
  const user = githubUserFor(cwd);
  const pinned = user && githubToken(user);
  if (pinned) return pinned;
  return activeTokenOnce();
}
/** The token of one named login (`gh auth token --user`, cached in env.ts), else the active one. */
export async function tokenForUser(user?: string): Promise<string> {
  return (user && githubToken(user)) || activeTokenOnce();
}
async function activeTokenOnce(): Promise<string> {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  if (activeToken) return activeToken;
  const res = await runCmd(["gh", "auth", "token"], { env: scrubbedEnv(), allowFail: true });
  const tok = res.code === 0 ? res.stdout.trim() : "";
  if (!tok) throw new GitHubAuthError("no GitHub token: run `gh auth login` on this host", 401, "");
  activeToken = tok;
  return tok;
}
/** Forget the cached active token (tests; a re-login). */
export function resetTokens(): void { activeToken = undefined; }

/** A short, one-way label for a token — the cache and rate-limit key. Never the token itself. */
const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

// ---- repo resolution ----

const slugCache = new Map<string, string>();
/** `owner/name` of the GitHub repo at `cwd` — what `{owner}/{repo}` meant to `gh`: the remote
 *  `gh repo set-default` marked (`remote.<name>.gh-resolved = base`), else `origin`.
 *  `ORCA_GITHUB_REPO` is the fallback for a checkout with no GitHub remote (the tests). */
export async function repoSlug(cwd: string): Promise<string> {
  const hit = slugCache.get(cwd);
  if (hit) return hit;
  const marked = await runCmd(["git", "-C", cwd, "config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { allowFail: true });
  const base = marked.code === 0 ? /^remote\.(.+)\.gh-resolved base$/m.exec(marked.stdout)?.[1] : undefined;
  const res = await runCmd(["git", "-C", cwd, "remote", "get-url", base ?? "origin"], { allowFail: true });
  const slug = parseSlug(res.code === 0 ? res.stdout.trim() : "") ?? process.env.ORCA_GITHUB_REPO;
  if (!slug) throw new GitHubError(`could not resolve GitHub repository for ${cwd}: no GitHub origin remote`, 0, "");
  slugCache.set(cwd, slug);
  return slug;
}
/** `owner/name` from a GitHub remote URL (https, ssh or scp form), else undefined. */
export function parseSlug(url: string): string | undefined {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// ---- rate limits ----

const blockedUntil = new Map<string, number>();
/** How long a short secondary limit (Retry-After) is waited out in place before one retry. */
const RETRY_INLINE_MAX_MS = 10_000;

function rateLimitReset(res: Response, now: number): number | undefined {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (remaining === "0" && Number.isFinite(reset) && reset > 0) return reset * 1000;
  return undefined;
}

/** Ms until `token`'s account may call again (0: now). */
export function rateLimitedFor(token: string, now = Date.now()): number {
  const until = blockedUntil.get(tokenKey(token)) ?? 0;
  return Math.max(0, until - now);
}

// ---- ETag cache ----

type Cached = { etag: string; body: unknown; at: number };
const etags = new Map<string, Cached>();
const ETAG_MAX = 500;
function remember(key: string, etag: string, body: unknown): void {
  etags.delete(key);
  etags.set(key, { etag, body, at: Date.now() });
  if (etags.size > ETAG_MAX) etags.delete(etags.keys().next().value!);
}

/** Clear every cache (tests). */
export function resetCaches(): void { etags.clear(); blockedUntil.clear(); slugCache.clear(); }

// ---- the request ----

export type RequestOptions = {
  method?: string;
  /** JSON body for a non-GET. */
  body?: unknown;
  /** Accept header (default the v3 JSON media type); a non-JSON type returns the text. */
  accept?: string;
  /** Follow a redirect by hand, WITHOUT the token (a log download points at a storage host). */
  redirectWithoutAuth?: boolean;
  token: string;
};

function errorFor(res: Response, path: string, text: string, now: number): GitHubError {
  let message = text;
  try { const j = JSON.parse(text) as { message?: string }; if (j.message) message = j.message; } catch { /* not JSON */ }
  const line = `HTTP ${res.status}: ${message || res.statusText} (${path})`;
  const reset = (res.status === 403 || res.status === 429) ? rateLimitReset(res, now) : undefined;
  if (reset !== undefined || res.status === 429) return new GitHubRateLimitError(line, res.status, path, reset ?? now + 60_000);
  if (res.status === 401) return new GitHubAuthError(line, res.status, path);
  if (res.status === 404) return new GitHubNotFoundError(line, res.status, path);
  return new GitHubError(line, res.status, path);
}

/** One REST call. `path` is relative to the API root (`repos/o/n/pulls`). GETs carry
 *  If-None-Match and a 304 returns the cached body. Returns parsed JSON, the text for a non-JSON
 *  Accept, or undefined for an empty answer (204). */
export async function request<T = any>(path: string, opts: RequestOptions): Promise<T> {
  const method = opts.method ?? "GET";
  const key = tokenKey(opts.token);
  const now = Date.now();
  const wait = rateLimitedFor(opts.token, now);
  if (wait > 0) throw new GitHubRateLimitError(`GitHub rate limit: retry in ${Math.ceil(wait / 1000)}s (${path})`, 429, path, now + wait);
  const url = /^https?:/.test(path) ? path : `${apiRoot()}/${path.replace(/^\//, "")}`;
  const accept = opts.accept ?? "application/vnd.github+json";
  const cacheKey = method === "GET" ? `${key} ${accept} ${url}` : undefined;
  const cached = cacheKey ? etags.get(cacheKey) : undefined;
  const headers: Record<string, string> = {
    Accept: accept, Authorization: `Bearer ${opts.token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "orca",
  };
  if (cached) headers["If-None-Match"] = cached.etag;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const send = () => doFetch(url, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: opts.redirectWithoutAuth ? "manual" : "follow",
  });
  countGhCall();
  let res: Response;
  try { res = await send(); } catch (e) { throw new GitHubError(`GitHub request failed: ${e instanceof Error ? e.message : String(e)} (${path})`, 0, path); }
  // A short secondary limit: wait it out once, in place.
  if ((res.status === 403 || res.status === 429) && Number(res.headers.get("retry-after")) * 1000 <= RETRY_INLINE_MAX_MS && Number(res.headers.get("retry-after")) > 0) {
    await Bun.sleep(Number(res.headers.get("retry-after")) * 1000);
    countGhCall();
    res = await send();
  }
  const after = Date.now();
  if (res.status === 304 && cached) return cached.body as T;
  if (opts.redirectWithoutAuth && res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const next = await doFetch(res.headers.get("location")!, { headers: { "User-Agent": "orca" } });
    if (!next.ok) throw new GitHubError(`HTTP ${next.status}: redirect target failed (${path})`, next.status, path);
    return (await next.text()) as T;
  }
  const text = await res.text();
  if (!res.ok) {
    const err = errorFor(res, path, text, after);
    if (err instanceof GitHubRateLimitError) blockedUntil.set(key, err.resetAt);
    throw err;
  }
  // Out of quota after this call: block the account until its window resets.
  const reset = rateLimitReset(res, after);
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset) blockedUntil.set(key, reset);
  const json = /json/.test(accept) && /json/.test(res.headers.get("content-type") ?? "json");
  const body = !text ? undefined : json ? JSON.parse(text) : text;
  const etag = res.headers.get("etag");
  if (cacheKey && etag) remember(cacheKey, etag, body);
  return body as T;
}

/** One GraphQL call. Errors in the answer throw a GitHubGraphQLError worded like gh's. */
export async function graphql<T = any>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const res = await request<{ data?: T; errors?: Array<{ message?: string; type?: string; path?: unknown[] }> }>("graphql", { method: "POST", body: { query, variables }, token });
  if (res?.errors?.length) {
    const msg = res.errors.map((e) => `GraphQL: ${e.message ?? "error"}${e.path?.length ? ` (${e.path.join(".")})` : ""}`).join("\n");
    if (res.errors.some((e) => e.type === "RATE_LIMITED")) {
      const resetAt = Date.now() + 60_000;
      blockedUntil.set(tokenKey(token), resetAt);
      throw new GitHubRateLimitError(msg, 200, "graphql", resetAt);
    }
    throw new GitHubGraphQLError(msg, "graphql", res.errors);
  }
  return res?.data as T;
}

// ---- per-repo convenience: the account and slug come from the checkout ----

/** A client bound to the repo at `cwd`: its token and `owner/name`. `rest` expands `{repo}` to
 *  `repos/<owner>/<name>`; `gql` sends exactly the variables it is given. */
export async function forRepo(cwd: string): Promise<{
  slug: string; owner: string; name: string; token: string;
  rest: <T = any>(path: string, opts?: Omit<RequestOptions, "token">) => Promise<T>;
  gql: <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}> {
  const [token, slug] = await Promise.all([tokenFor(cwd), repoSlug(cwd)]);
  const [owner, name] = slug.split("/") as [string, string];
  return {
    slug, owner, name, token,
    rest: (path, opts = {}) => request(path.replace("{repo}", `repos/${slug}`), { ...opts, token }),
    gql: (query, variables = {}) => graphql(query, variables, token),
  };
}

// ---- conditional pages (pollers) ----

/** One page of a polled GET, with the ETag the CALLER keeps (a poller stores it in its cursor, so a
 *  restart still sends If-None-Match). `notModified` is a 304: nothing changed, and GitHub did not
 *  count the call against the rate limit. `next` is the `Link: rel="next"` URL, for pagination. */
export type Page<T> = { notModified: true } | { notModified: false; body: T; etag?: string; next?: string };

/** The `rel="next"` URL of a `Link` header, else undefined. */
export function nextLink(link: string | null): string | undefined {
  return link ? /<([^>]+)>\s*;\s*rel="next"/.exec(link)?.[1] : undefined;
}

/** A GET with an explicit ETag. Same rate-limit rules and typed errors as `request`. */
export async function conditionalGet<T = any>(path: string, opts: { token: string; etag?: string }): Promise<Page<T>> {
  const key = tokenKey(opts.token);
  const now = Date.now();
  const wait = rateLimitedFor(opts.token, now);
  if (wait > 0) throw new GitHubRateLimitError(`GitHub rate limit: retry in ${Math.ceil(wait / 1000)}s (${path})`, 429, path, now + wait);
  const url = /^https?:/.test(path) ? path : `${apiRoot()}/${path.replace(/^\//, "")}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${opts.token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "orca",
    ...(opts.etag ? { "If-None-Match": opts.etag } : {}),
  };
  countGhCall();
  let res: Response;
  try { res = await doFetch(url, { headers }); } catch (e) { throw new GitHubError(`GitHub request failed: ${e instanceof Error ? e.message : String(e)} (${path})`, 0, path); }
  const after = Date.now();
  if (res.status === 304) return { notModified: true };
  const text = await res.text();
  if (!res.ok) {
    const err = errorFor(res, path, text, after);
    if (err instanceof GitHubRateLimitError) blockedUntil.set(key, err.resetAt);
    throw err;
  }
  const reset = rateLimitReset(res, after);
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset) blockedUntil.set(key, reset);
  const etag = res.headers.get("etag") ?? undefined;
  const next = nextLink(res.headers.get("link"));
  return { notModified: false, body: (text ? JSON.parse(text) : undefined) as T, ...(etag ? { etag } : {}), ...(next ? { next } : {}) };
}
