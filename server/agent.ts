// Launches Claude, Codex, or Cursor headlessly and tracks status + provider-native
// session id, so the UI can show done/error and "Copy CLI" can resume the exact conversation.
// Keyed by an arbitrary string: worktree path for
// feature/fix runs, `slack:…` for repo-level. The subprocess handle is kept so we can kill it.
import { retryTitle } from "./title";
import { handoffPrompt, parseAgentOutcome, type AgentOutcome, type AgentProvider, type AgentTurn } from "../shared/agent";
import * as lease from "./lease";
import * as ledger from "./ledger";
import { tmpdir } from "os";

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
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};
export type RunState = {
  status: "idle" | "running" | "done" | "error";
  error?: string;
  provider?: AgentProvider;
  runId?: string;
  prompt?: string;
  sessionId?: string;
  result?: string;
  structured?: AgentOutcome;
  meta?: RunMeta;
  startedAt?: number;
  finishedAt?: number;
};
type Run = RunState & { proc?: Bun.Subprocess };
export type LaunchReceipt = { status: "running"; provider: AgentProvider; runId: string; sessionId?: string };

export type LaunchOptions = {
  provider?: AgentProvider;
  resume?: string;
  history?: AgentTurn[];
  handoffFrom?: AgentProvider;
  timeoutMs?: number;
  branch?: string; // recorded on the lease so restart recovery can match by branch
  action?: string; // ledger label: launch | followup | conflict | ci | review | rerun | agent
  evidenceChars?: number; // size of CI/review evidence sent with this run (ledger)
};

/** How this run reuses prior context — derived from what the launch options carry, so the ledger's
 *  resume/reset/handoff breakdown matches the store's actual continuation decision. Pure. */
export function runMode(options: LaunchOptions): ledger.RunMode {
  if (options.resume) return "resume";
  if (options.handoffFrom) return options.handoffFrom === (options.provider ?? "claude") ? "reset" : "handoff";
  if (options.history?.length) return "handoff";
  return "fresh";
}

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
    inputTokens: num(j?.usage?.input_tokens),
    outputTokens: num(j?.usage?.output_tokens),
    cacheReadTokens: num(j?.usage?.cache_read_input_tokens),
    cacheCreationTokens: num(j?.usage?.cache_creation_input_tokens),
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
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      sessionId = codexSessionId(line) ?? sessionId;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") result = event.item.text;
      if (event.type === "turn.completed") {
        turns++;
        inputTokens += Number(event.usage?.input_tokens) || 0;
        outputTokens += Number(event.usage?.output_tokens) || 0;
        cachedInputTokens += Number(event.usage?.cached_input_tokens) || 0;
      }
      if (event.type === "turn.failed" || event.type === "error") isError = true;
    } catch { /* tolerate non-JSON diagnostic lines */ }
  }
  return { sessionId, result, isError, meta: {
    model: "Codex", numTurns: turns || undefined,
    inputTokens: inputTokens || undefined, outputTokens: outputTokens || undefined,
    cacheReadTokens: cachedInputTokens || undefined,
  } };
}

/** Cursor's `--print --output-format json` emits a single result object carrying the response, the
 *  chosen chat id (`session_id`, resumable with `cursor-agent --resume <id>`), and token usage.
 *  Cursor doesn't report which model ran, so the card just labels it "Cursor". Pure. */
export function parseCursorOutput(raw: string): { sessionId?: string; result?: string; isError: boolean; meta: RunMeta } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  try {
    const j = JSON.parse(raw.trim());
    return {
      sessionId: typeof j.session_id === "string" ? j.session_id : undefined,
      result: typeof j.result === "string" ? j.result : undefined,
      isError: Boolean(j.is_error),
      meta: {
        model: "Cursor", numTurns: 1, durationMs: num(j.duration_ms),
        inputTokens: num(j.usage?.inputTokens), outputTokens: num(j.usage?.outputTokens),
        cacheReadTokens: num(j.usage?.cacheReadTokens), cacheCreationTokens: num(j.usage?.cacheWriteTokens),
      },
    };
  } catch {
    return { isError: false, meta: { model: "Cursor" } }; // non-JSON (crash) — let the exit code decide
  }
}

/** Provider-specific argv. Kept pure so tests pin the native resume contracts. */
// The prompt is passed as a positional AFTER a `--` end-of-options marker in every form. Follow-up
// and launch prompts are user-authored and often start with `-` (a Markdown bullet). Without `--`,
// all three CLIs' arg parsers read that leading dash as an unknown option and the run dies before the
// agent ever sees the prompt — e.g. claude `error: unknown option '- gather children…'`. Reproduced
// and each `--` form verified against the real CLIs (see multiAgent.test's leading-dash case).
export function agentCommand(provider: AgentProvider, cwd: string, prompt: string, resume?: string, sessionId?: string): string[] {
  if (provider === "codex") {
    return resume
      ? ["codex", "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", resume, "--", prompt]
      : ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, "--", prompt];
  }
  if (provider === "cursor") {
    return ["cursor-agent", "-p", ...(resume ? ["--resume", resume] : []), "--output-format", "json", "--force", "--trust", "--", prompt];
  }
  return ["claude", "-p", "--permission-mode", "bypassPermissions", ...(resume ? ["--resume", resume] : ["--session-id", sessionId ?? crypto.randomUUID()]), "--output-format", "json", "--", prompt];
}

export function launch(key: string, cwd: string, prompt: string, options: LaunchOptions = {}): LaunchReceipt {
  // Reject an overlap whether we remember the run in-process OR a durable lease from before a restart
  // says one is still live in this worktree.
  if (runs.get(key)?.status === "running" || lease.leased(key)) throw new Error("an agent is already running for this worktree");
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
  const timeout = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined;
  runs.set(key, { status: "running", provider, runId, prompt, sessionId, proc, startedAt });
  lease.acquire({ key, worktreePath: cwd, branch: options.branch, provider, runId, pid: proc.pid, startedAt, timeoutMs: options.timeoutMs });
  void (async () => {
    const [out, err] = await Promise.all([
      provider === "codex" ? readCodexOutput(key, proc) : new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timeout) clearTimeout(timeout);
    if (runs.get(key)?.proc !== proc) return; // superseded (re-run) or stopped — don't clobber
    let result: string | undefined, isError = false, meta: RunMeta | undefined, resolvedSessionId = sessionId;
    if (provider === "codex") {
      const parsed = parseCodexOutput(out);
      result = parsed.result;
      isError = parsed.isError;
      meta = parsed.meta;
      resolvedSessionId = parsed.sessionId ?? resolvedSessionId;
    } else if (provider === "cursor") {
      const parsed = parseCursorOutput(out);
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
    const structured = result ? parseAgentOutcome(result) : undefined;
    const common = { provider, runId, prompt, sessionId: resolvedSessionId, result, structured, meta, startedAt, finishedAt };
    lease.release(key, runId); // this run is done — free the worktree (no-op if a re-run already took the lease)
    const ok = code === 0 && !isError;
    ledger.record({
      kind: "run", provider, action: options.action, mode: runMode(options),
      status: ok ? "done" : "error", durationMs: meta?.durationMs ?? finishedAt - startedAt,
      inputTokens: meta?.inputTokens, outputTokens: meta?.outputTokens,
      cacheReadTokens: meta?.cacheReadTokens, cacheCreationTokens: meta?.cacheCreationTokens,
      evidenceChars: options.evidenceChars,
      errorKind: ok ? undefined : code !== 0 ? "nonzero-exit" : "agent-error",
    });
    runs.set(key, ok
      ? { status: "done", ...common }
      : { status: "error", ...common, error: (err.trim() || result || `exit ${code}`).slice(0, 300) });
  })();
  return { status: "running", provider, runId, sessionId };
}

/** Feature/fix run inside a worktree — keyed by the worktree path. */
export const runAgent = (worktreePath: string, prompt: string, options?: LaunchOptions) => launch(worktreePath, worktreePath, prompt, options);

export const isRunning = (key: string): boolean => runs.get(key)?.status === "running" || lease.leased(key);

/** A provider-isolated one-shot: never falls through to a different provider. */
export function oneShotCommand(provider: AgentProvider, cwd: string, prompt: string, purpose: "title" | "description"): string[] {
  if (provider === "claude") {
    return ["claude", "-p", prompt, "--model", purpose === "title" ? "haiku" : "sonnet", "--tools", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"];
  }
  if (provider === "codex") return ["codex", "exec", "--json", "--ephemeral", "--ignore-rules", "--sandbox", "read-only", "-C", cwd, prompt];
  return ["cursor-agent", "-p", prompt, "--output-format", "json", "--mode", "ask", "--trust"];
}

/** Read-only argv for asking the implementation agent's native session to author its PR body. */
export function prDescriptionCommand(provider: AgentProvider, cwd: string, prompt: string, resume: string): string[] {
  if (provider === "claude") {
    return ["claude", "-p", prompt, "--resume", resume, "--tools", "", "--disable-slash-commands", "--output-format", "json"];
  }
  if (provider === "codex") {
    return ["codex", "exec", "resume", "--json", "-c", 'sandbox_mode="read-only"', resume, prompt];
  }
  return ["cursor-agent", "-p", prompt, "--resume", resume, "--output-format", "json", "--mode", "ask", "--trust"];
}

async function commandOutput(provider: AgentProvider, args: string[], cwd: string, purpose: "title" | "description"): Promise<string> {
  const proc = Bun.spawn(args, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => proc.kill(), 2 * 60_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timeout);
  if (code !== 0) throw new Error(err.trim() || `${provider} ${purpose} failed`);
  if (provider === "claude") return String(JSON.parse(out.trim()).result ?? "");
  if (provider === "codex") {
    const parsed = parseCodexOutput(out);
    if (parsed.isError) throw new Error(`${provider} ${purpose} failed`);
    return parsed.result ?? "";
  }
  const parsed = parseCursorOutput(out);
  if (parsed.isError) throw new Error(`${provider} ${purpose} failed`);
  return parsed.result ?? "";
}

async function oneShot(provider: AgentProvider, prompt: string, purpose: "title" | "description"): Promise<string> {
  // The prompt is self-contained. Running outside the repo avoids loading project instructions and
  // prevents the helper conversation from replacing the worktree's resumable session.
  const cwd = tmpdir();
  const args = oneShotCommand(provider, cwd, prompt, purpose);
  return commandOutput(provider, args, cwd, purpose);
}

/** Quick selected-provider summary of a prompt into a 2–5 word title. Asks for JSON, validates it, and
 *  refetches once if the reply doesn't parse to a valid title; null after that (caller falls back
 *  to titleFromPrompt). */
export function summarize(provider: AgentProvider, prompt: string): Promise<string | null> {
  const ask = () => oneShot(provider, `Respond with ONLY minified JSON: {"title":"<a 2-5 word Title Case name for this task>"}. No other text.\n\n${prompt}`, "title");
  return retryTitle(ask, 2); // validate + refetch once on a bad reply
}

/** Ask the implementation agent's native session for the PR body. Without a resumable session,
 *  use an isolated same-provider call with the self-contained prompt. */
export async function describePr(provider: AgentProvider, prompt: string, options?: { cwd?: string; resume?: string }): Promise<string | null> {
  try {
    const body = (options?.resume
      ? await commandOutput(provider, prDescriptionCommand(provider, options.cwd ?? tmpdir(), prompt, options.resume), options.cwd ?? tmpdir(), "description")
      : await oneShot(provider, prompt, "description")).trim();
    return body || null;
  } catch {
    return null;
  }
}

/** Kill and forget a run (e.g. on discard). */
export function stop(key: string): void {
  const r = runs.get(key);
  try { r?.proc?.kill(); } catch { /* already gone */ }
  runs.delete(key);
  lease.release(key); // discard/stop frees the worktree even if the run was recovered from a lease
}

/** Recognize the headless CLI forms Orca launches, including resumed Cursor conversations. */
export function isHeadlessAgentProcess(line: string): boolean {
  return line.includes("claude -p")
    || line.includes("codex exec")
    || (/(?:^|\s)(?:\S*\/)?cursor-agent(?:\s|$)/.test(line) && /(?:^|\s)(?:-p|--print)(?:\s|$)/.test(line));
}

/** Kill a running agent by branch (via ps) — works even after a restart lost the handle. */
export async function killByBranch(branch: string): Promise<void> {
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,command="], { env: process.env, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split("\n")) {
      if (isHeadlessAgentProcess(line) && line.includes(branch)) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (pid) try { process.kill(pid); } catch { /* already gone */ }
      }
    }
  } catch { /* ps unavailable */ }
}

/** Branches that currently have a live headless agent process (recovers status lost on restart). */
export async function detectRunning(branches: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  try {
    const proc = Bun.spawn(["ps", "-Ao", "command"], { env: process.env, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = out.split("\n").filter(isHeadlessAgentProcess);
    for (const b of branches) if (b && lines.some((l) => l.includes(b))) found.add(b);
  } catch { /* ps unavailable */ }
  // Union in leased branches: a Claude follow-up's argv carries only its session id, so the ps
  // branch-substring scan above can miss it — the lease records the branch explicitly.
  for (const b of lease.liveBranches(branches)) found.add(b);
  return found;
}

export const status = (key: string): RunState => {
  const r = runs.get(key);
  return r ? {
    status: r.status, error: r.error, provider: r.provider, runId: r.runId, prompt: r.prompt,
    sessionId: r.sessionId, result: r.result, structured: r.structured, meta: r.meta, startedAt: r.startedAt, finishedAt: r.finishedAt,
  } : { status: "idle" };
};
