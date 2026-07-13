// Launches Claude or Codex headlessly (JSON/JSONL output) and tracks status + provider-native
// session id, so the UI can show done/error and "Copy CLI" can resume the exact conversation.
// Keyed by an arbitrary string: worktree path for
// feature/fix runs, `slack:…` for repo-level. The subprocess handle is kept so we can kill it.
import { retryTitle } from "./title";
import { handoffPrompt, type AgentProvider, type AgentTurn } from "../shared/agent";

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
export type RunState = {
  status: "idle" | "running" | "done" | "error";
  error?: string;
  provider?: AgentProvider;
  runId?: string;
  prompt?: string;
  sessionId?: string;
  result?: string;
  meta?: RunMeta;
  startedAt?: number;
  finishedAt?: number;
};
type Run = RunState & { proc?: Bun.Subprocess };

export type LaunchOptions = {
  provider?: AgentProvider;
  resume?: string;
  history?: AgentTurn[];
  handoffFrom?: AgentProvider;
};

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

function codexSessionId(line: string): string | undefined {
  try {
    const event = JSON.parse(line);
    return event.type === "thread.started" && typeof event.thread_id === "string" ? event.thread_id : undefined;
  } catch {
    return undefined;
  }
}

/** Read Codex JSONL without waiting for the process to finish. Codex chooses its own thread UUID
 *  (there is no Claude-style `--session-id` flag), but emits it first. Publishing it into `runs`
 *  immediately lets the next `/api/agents` poll persist and copy the exact resumable thread id. */
async function readCodexOutput(key: string, proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let raw = "";
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += value;
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const sessionId = codexSessionId(line);
      const current = runs.get(key);
      if (sessionId && current?.proc === proc && current.sessionId !== sessionId) {
        runs.set(key, { ...current, sessionId });
      }
    }
  }
  return raw;
}

/** Parse Codex's `exec --json` JSONL stream into the session id, final response, and card metadata. */
export function parseCodexOutput(raw: string): { sessionId?: string; result?: string; isError: boolean; meta: RunMeta } {
  let sessionId: string | undefined;
  let result: string | undefined;
  let isError = false;
  let turns = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      sessionId = codexSessionId(line) ?? sessionId;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") result = event.item.text;
      if (event.type === "turn.completed") turns++;
      if (event.type === "turn.failed" || event.type === "error") isError = true;
    } catch { /* tolerate non-JSON diagnostic lines */ }
  }
  return { sessionId, result, isError, meta: { model: "Codex", numTurns: turns || undefined } };
}

/** Provider-specific argv. Kept pure so tests pin the native resume contracts. */
export function agentCommand(provider: AgentProvider, cwd: string, prompt: string, resume?: string, sessionId?: string): string[] {
  if (provider === "codex") {
    return resume
      ? ["codex", "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", resume, prompt]
      : ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, prompt];
  }
  return ["claude", "-p", prompt, "--permission-mode", "bypassPermissions", ...(resume ? ["--resume", resume] : ["--session-id", sessionId ?? crypto.randomUUID()]), "--output-format", "json"];
}

export function launch(key: string, cwd: string, prompt: string, options: LaunchOptions = {}): void {
  const provider = options.provider ?? "claude";
  const sessionId = options.resume ?? (provider === "claude" ? crypto.randomUUID() : undefined);
  const effectivePrompt = !options.resume && (options.handoffFrom || options.history?.length)
    ? handoffPrompt(options.history ?? [], prompt, options.handoffFrom, provider)
    : prompt;
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const proc = Bun.spawn(
    agentCommand(provider, cwd, effectivePrompt, options.resume, sessionId),
    { cwd, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  runs.set(key, { status: "running", provider, runId, prompt, sessionId, proc, startedAt });
  void (async () => {
    const [out, err] = await Promise.all([
      provider === "codex" ? readCodexOutput(key, proc) : new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (runs.get(key)?.proc !== proc) return; // superseded (re-run) or stopped — don't clobber
    let result: string | undefined, isError = false, meta: RunMeta | undefined, resolvedSessionId = sessionId;
    if (provider === "codex") {
      const parsed = parseCodexOutput(out);
      result = parsed.result;
      isError = parsed.isError;
      meta = parsed.meta;
      resolvedSessionId = parsed.sessionId ?? resolvedSessionId;
    } else {
      try {
        const j = JSON.parse(out.trim());
        result = j.result;
        isError = Boolean(j.is_error);
        meta = parseRunMeta(j);
      } catch { /* non-JSON output (e.g. crash) */ }
    }
    const finishedAt = Date.now();
    if (meta) meta.durationMs ??= finishedAt - startedAt;
    const common = { provider, runId, prompt, sessionId: resolvedSessionId, result, meta, startedAt, finishedAt };
    runs.set(key, code === 0 && !isError
      ? { status: "done", ...common }
      : { status: "error", ...common, error: (err.trim() || result || `exit ${code}`).slice(0, 300) });
  })();
}

/** Feature/fix run inside a worktree — keyed by the worktree path. */
export const runAgent = (worktreePath: string, prompt: string, options?: LaunchOptions) => launch(worktreePath, worktreePath, prompt, options);

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
      if ((line.includes("claude -p") || line.includes("codex exec")) && line.includes(branch)) {
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
    const lines = out.split("\n").filter((l) => l.includes("claude -p") || l.includes("codex exec"));
    for (const b of branches) if (b && lines.some((l) => l.includes(b))) found.add(b);
  } catch { /* ps unavailable */ }
  return found;
}

export const status = (key: string): RunState => {
  const r = runs.get(key);
  return r ? {
    status: r.status, error: r.error, provider: r.provider, runId: r.runId, prompt: r.prompt,
    sessionId: r.sessionId, result: r.result, meta: r.meta, startedAt: r.startedAt, finishedAt: r.finishedAt,
  } : { status: "idle" };
};
