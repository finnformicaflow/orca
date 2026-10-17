// The environment every process Orca spawns gets. Orca's own secrets never reach anything that runs
// code Orca doesn't own — an agent, a check, a preview's dev server, a git hook in an agent-edited
// worktree, a browser, a provider session — so a prompt injection that reads the environment finds
// no Slack token or database URL. Provider keys (ANTHROPIC_*, OPENAI_*) are deliberately left alone:
// they are the CLI's, not ours.

/** Orca's secrets. Add one here and every spawn drops it. */
export const ORCA_SECRETS = ["SLACK_TOKEN", "ORCA_DATABASE_URL", "ORCA_TEST_DATABASE_URL", "TS_OAUTH_CLIENT_ID", "TS_OAUTH_CLIENT_SECRET"] as const;

/** Every variable with this prefix is a secret too: an integration's token lives in one. */
export const SECRET_PREFIX = "ORCA_SECRET_";

export type Env = Record<string, string | undefined>;

/** The bridge's LIVE environment (Bun.spawn otherwise snapshots PATH at startup, which defeats a
 *  test's PATH shim) minus Orca's secrets, with `extra` laid over it — a key set to `undefined` is
 *  removed. `keep` names secrets this one spawn may still see (a deliberate, named allow-back). */
export function scrubbedEnv(extra: Env = {}, opts: { keep?: readonly string[] } = {}): Record<string, string> {
  const env: Env = { ...process.env };
  for (const key of ORCA_SECRETS) if (!opts.keep?.includes(key)) delete env[key];
  // An integration's token (its row names the variable, shared/integrations.ts secretRefRefusal).
  for (const key of Object.keys(env)) if (key.startsWith(SECRET_PREFIX) && !opts.keep?.includes(key)) delete env[key];
  Object.assign(env, extra);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env as Record<string, string>;
}

// ---- GitHub accounts (RepoConfig.githubUser) ----
// `gh` keeps several signed-in accounts per host but ONE active; `GH_TOKEN` in a process's env
// overrides that choice for `gh` AND for git's `gh auth git-credential` helper. So a repo pinned to
// an account gets that account's token in every process Orca runs under its paths — nothing switches.
let accounts: Array<{ path: string; user: string }> = [];
const tokens = new Map<string, string>();
type Identity = { name?: string; email?: string };
let identities: Record<string, Identity> = {};
const profiles = new Map<string, Identity>();

/** Remember which repo paths (repo + worktree root) belong to which `gh` account. Called by
 *  config.ts whenever a config becomes current. */
export function setGithubAccounts(repos: ReadonlyArray<{ repoPath: string; worktreeRoot: string; githubUser?: string }>, ids: Record<string, Identity> = {}): void {
  accounts = repos.flatMap((r) => (r.githubUser ? [{ path: r.repoPath, user: r.githubUser }, { path: r.worktreeRoot, user: r.githubUser }] : []));
  identities = ids;
}

/** The commit identity for `user`: the config's, each missing field from the GitHub profile (once per
 *  process; public email, else GitHub's noreply address — so a commit is attributed and verified). */
export function githubIdentity(user: string, token: string): Identity {
  if (!profiles.has(user)) {
    const p = Bun.spawnSync(["gh", "api", "user"], { env: scrubbedEnv({ GH_TOKEN: token }), stdout: "pipe", stderr: "pipe" });
    let id: Identity = {};
    try {
      const u = JSON.parse(p.stdout.toString()) as { id?: number; login?: string; name?: string | null; email?: string | null };
      id = { name: u.name || u.login || user, email: u.email || (u.id ? `${u.id}+${u.login ?? user}@users.noreply.github.com` : undefined) };
    } catch { /* profile unreadable: the config's fields, else git's own */ }
    profiles.set(user, id);
  }
  const profile = profiles.get(user)!;
  return { name: identities[user]?.name ?? profile.name, email: identities[user]?.email ?? profile.email };
}

/** The `gh` account `cwd` belongs to, or undefined (the host's active account). */
export function githubUserFor(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return accounts.find((a) => cwd === a.path || cwd.startsWith(`${a.path}/`))?.user;
}

/** That account's token, from `gh auth token --user`, once per process (an oauth token does not
 *  expire; a re-login replaces it on the next bridge start). Empty when the host has no such login
 *  — the process then falls back to the active account, which fails visibly if it lacks access. */
export function githubToken(user: string): string | undefined {
  if (!tokens.has(user)) {
    const p = Bun.spawnSync(["gh", "auth", "token", "--user", user], { env: scrubbedEnv(), stdout: "pipe", stderr: "pipe" });
    const tok = p.exitCode === 0 ? p.stdout.toString().trim() : "";
    if (!tok) console.error(`orca: no gh login for "${user}" on this host (gh auth login) — using the active account`);
    tokens.set(user, tok);
  }
  return tokens.get(user) || undefined;
}

/** The env for a process running at `cwd`: `GH_TOKEN` and the account's commit identity, or nothing. */
export function githubEnv(cwd: string | undefined): Env {
  const user = githubUserFor(cwd);
  const tok = user && githubToken(user);
  if (!user || !tok) return {};
  const { name, email } = githubIdentity(user, tok);
  return {
    GH_TOKEN: tok,
    ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
    ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
  };
}

/** `bin/worker` holds the tools every run may use — `orca-shot`, the one way to take a screenshot
 *  (server/screenshot.ts). Not `bin/`: `orca` there is the orchestrator's, not a worker's. */
export const WORKER_BIN = new URL("../bin/worker", import.meta.url).pathname;

/** The environment a spawned agent (or its check) gets: scrubbed, with `bin/worker` first on PATH.
 *  Which Claude LOGIN a run uses is not Orca's call: `claude` on PATH is hydra's shim, which picks
 *  the account with the most headroom per launch (see CLAUDE.md "Handover ladder"). */
export function agentEnv(extra: Env = {}): Record<string, string> {
  return scrubbedEnv({ PATH: `${WORKER_BIN}:${process.env.PATH ?? ""}`, ...extra });
}
