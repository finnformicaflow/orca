// Launches a headless `claude -p` (JSON output) and tracks its status + session id, so the
// UI can show done/error and "Copy CLI" can resume the exact conversation (mid-run too, since
// we choose the session id up front). Keyed by an arbitrary string: worktree path for
// feature/fix runs, `slack:…` for repo-level. The subprocess handle is kept so we can kill it.
import { retryTitle } from "./title";

// Per-run metadata pulled from the `claude -p` JSON: which model ran, how full its context got, its
// cost, turns, and wall-clock. Surfaced on the card so a session shows what ran. (contextPct is the
// FINAL turn's prompt over the model's window — NOT the top-level `usage`, which sums every turn and
// so overshoots 100%.)
export type RunMeta = {
  model?: string; // friendly, e.g. "Opus 4.8"
  contextPct?: number; // % of the model's context window the last turn's prompt filled
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
};
export type RunState = { status: "idle" | "running" | "done" | "error"; error?: string; sessionId?: string; result?: string; meta?: RunMeta; startedAt?: number; finishedAt?: number };
type Run = RunState & { proc?: Bun.Subprocess };

/** claude-haiku-4-5-20251001 → "Haiku 4.5" (drop `claude-`, the `[1m]` tier suffix, and the
 *  trailing date, then prettify). */
export function prettyModel(id: string): string {
  const core = id.replace(/^claude-/, "").replace(/\[[^\]]*\]$/, "").replace(/-\d{6,8}$/, "");
  const [family, ...ver] = core.split("-");
  const cap = (s: string | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  return ver.length ? `${cap(family)} ${ver.join(".")}` : cap(core) || id;
}

/** Pull model + context/cost/turn metadata out of a `claude -p --output-format json` object. Pure. */
export function parseRunMeta(j: any): RunMeta {
  const mu = (j?.modelUsage && typeof j.modelUsage === "object") ? j.modelUsage as Record<string, any> : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  // A single `claude -p` run reports usage for EVERY model it touched: Claude Code fires an
  // auxiliary Haiku alongside the main model, and Haiku is usually listed FIRST. Pick the PRIMARY
  // model — the one that generated the most output — not modelUsage's first key. Otherwise an Opus
  // run gets mislabelled "Haiku" AND its last-turn prompt is divided by Haiku's 200k window instead
  // of Opus's, pushing contextPct past 100%.
  const modelId = Object.keys(mu).sort((a, b) => (num(mu[b]?.outputTokens) ?? 0) - (num(mu[a]?.outputTokens) ?? 0))[0];
  // Context occupancy = the LAST turn's prompt (read side: fresh input + cache read + cache
  // creation), NOT the top-level `usage` (which sums every turn and would overshoot the window).
  const iters = Array.isArray(j?.usage?.iterations) ? j.usage.iterations : [];
  const lastTurn = iters.length ? iters[iters.length - 1] : j?.usage;
  const ctxTokens = lastTurn
    ? (num(lastTurn.input_tokens) ?? 0) + (num(lastTurn.cache_read_input_tokens) ?? 0) + (num(lastTurn.cache_creation_input_tokens) ?? 0)
    : 0;
  const window = modelId ? num(mu[modelId]?.contextWindow) : undefined;
  return {
    model: modelId ? prettyModel(modelId) : undefined,
    contextPct: window && window > 0 && ctxTokens > 0 ? Math.round((ctxTokens / window) * 100) : undefined,
    costUsd: num(j?.total_cost_usd),
    numTurns: num(j?.num_turns),
    durationMs: num(j?.duration_ms),
  };
}

const runs = new Map<string, Run>();

export function launch(key: string, cwd: string, prompt: string, resume?: string): void {
  // Resume an existing session (follow-up) so the agent keeps prior context, else start fresh.
  const sessionId = resume ?? crypto.randomUUID();
  const idArgs = resume ? ["--resume", resume] : ["--session-id", sessionId];
  const startedAt = Date.now();
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--permission-mode", "bypassPermissions", ...idArgs, "--output-format", "json"],
    { cwd, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  runs.set(key, { status: "running", sessionId, proc, startedAt });
  void (async () => {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (runs.get(key)?.proc !== proc) return; // superseded (re-run) or stopped — don't clobber
    let result: string | undefined, isError = false, meta: RunMeta | undefined;
    try {
      const j = JSON.parse(out.trim());
      result = j.result;
      isError = Boolean(j.is_error);
      meta = parseRunMeta(j);
    } catch { /* non-JSON output (e.g. crash) */ }
    const finishedAt = Date.now();
    runs.set(key, code === 0 && !isError
      ? { status: "done", sessionId, result, meta, startedAt, finishedAt }
      : { status: "error", sessionId, error: (err.trim() || result || `exit ${code}`).slice(0, 300), meta, startedAt, finishedAt });
  })();
}

/** Feature/fix run inside a worktree — keyed by the worktree path. */
export const runAgent = (worktreePath: string, prompt: string) => launch(worktreePath, worktreePath, prompt);

/** Quick Haiku summary of a prompt into a 2–5 word title. Asks for JSON, validates it (zod), and
 *  refetches once if the reply doesn't parse to a valid title; null after that (caller falls back
 *  to titleFromPrompt). */
export function summarize(prompt: string): Promise<string | null> {
  const ask = async (): Promise<string> => {
    const proc = Bun.spawn(
      ["claude", "-p", `Respond with ONLY minified JSON: {"title":"<a 2-5 word Title Case name for this task>"}. No other text.\n\n${prompt}`, "--model", "haiku", "--output-format", "json"],
      { env: process.env, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return String(JSON.parse(out.trim()).result ?? "");
  };
  return retryTitle(ask, 2); // validate + refetch once on a bad reply
}

/** Write a PR description from a prepared prompt (see `prDescriptionPrompt`) via a one-shot headless
 *  `claude -p` on Sonnet — capable enough to read a diff and follow the template, without the cost
 *  of a full agent loop. Returns the generated markdown, or null on any error / empty reply so the
 *  caller can fall back to the deterministic `resolvePrBody`. */
export async function describePr(prompt: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["claude", "-p", prompt, "--model", "sonnet", "--output-format", "json"],
      { env: process.env, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const j = JSON.parse(out.trim());
    if (j.is_error) return null;
    const body = String(j.result ?? "").trim();
    return body || null;
  } catch {
    return null; // claude missing / bad JSON — caller falls back
  }
}

/** Kill and forget a run (e.g. on discard). */
export function stop(key: string): void {
  const r = runs.get(key);
  try { r?.proc?.kill(); } catch { /* already gone */ }
  runs.delete(key);
}

/** Kill a running agent by branch (via ps) — works even after a restart lost the handle. */
export async function killByBranch(branch: string): Promise<void> {
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,command="], { env: process.env, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split("\n")) {
      if (line.includes("claude -p") && line.includes(branch)) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (pid) try { process.kill(pid); } catch { /* already gone */ }
      }
    }
  } catch { /* ps unavailable */ }
}

/** Branches that currently have a live `claude -p` process (recovers status lost on restart). */
export async function detectRunning(branches: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  try {
    const proc = Bun.spawn(["ps", "-Ao", "command"], { env: process.env, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = out.split("\n").filter((l) => l.includes("claude -p"));
    for (const b of branches) if (b && lines.some((l) => l.includes(b))) found.add(b);
  } catch { /* ps unavailable */ }
  return found;
}

export const status = (key: string): RunState => {
  const r = runs.get(key);
  return r ? { status: r.status, error: r.error, sessionId: r.sessionId, result: r.result, meta: r.meta, startedAt: r.startedAt, finishedAt: r.finishedAt } : { status: "idle" };
};
