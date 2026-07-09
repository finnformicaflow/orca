// Launches a headless `claude -p` (JSON output) and tracks its status + session id, so the
// UI can show done/error and "Copy CLI" can resume the exact conversation (mid-run too, since
// we choose the session id up front). Keyed by an arbitrary string: worktree path for
// feature/fix runs, `slack:…` for repo-level. The subprocess handle is kept so we can kill it.
import { retryTitle } from "./title";

// Per-run metadata pulled from the `claude -p` JSON: which model ran, how much context it used
// (of the window), cost, turns, and wall-clock. Surfaced on the card so a session shows its cost/scale.
export type RunMeta = {
  model?: string;         // friendly, e.g. "Opus 4.8"
  contextTokens?: number; // input + cache tokens (≈ how much of the window the run occupied)
  contextWindow?: number; // e.g. 200000
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
};
export type RunState = { status: "idle" | "running" | "done" | "error"; error?: string; sessionId?: string; result?: string; meta?: RunMeta; startedAt?: number; finishedAt?: number };
type Run = RunState & { proc?: Bun.Subprocess };

/** claude-haiku-4-5-20251001 → "Haiku 4.5" (drop the `claude-` prefix + trailing date, prettify). */
export function prettyModel(id: string): string {
  const core = id.replace(/^claude-/, "").replace(/-\d{6,8}$/, "");
  const [family, ...ver] = core.split("-");
  const cap = (s: string | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  return ver.length ? `${cap(family)} ${ver.join(".")}` : cap(core) || id;
}

/** Pull model + context/cost/turn metadata out of a `claude -p --output-format json` object. Pure. */
export function parseRunMeta(j: any): RunMeta {
  const mu = (j?.modelUsage && typeof j.modelUsage === "object") ? j.modelUsage as Record<string, any> : {};
  const modelId = Object.keys(mu)[0];
  const u = j?.usage ?? {};
  const ctx = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    model: modelId ? prettyModel(modelId) : undefined,
    contextTokens: ctx || undefined,
    contextWindow: modelId ? num(mu[modelId]?.contextWindow) : undefined,
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
