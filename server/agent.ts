// Launches Claude, Codex, or Cursor headlessly and tracks status + provider-native
// session id, so the UI can show done/error and "Copy CLI" can resume the exact conversation.
// Keyed by an arbitrary string: worktree path for
// feature/fix runs, `slack:…` for repo-level. The subprocess handle is kept so we can kill it.
import { retryTitle } from "./title";
import { handoffPrompt, parseAgentOutcome, type AgentOutcome, type AgentProvider, type AgentStep, type AgentTurn } from "../shared/agent";
import * as lease from "./lease";
import * as ledger from "./ledger";
import * as db from "./db";
import * as transcript from "./transcript";
import * as bus from "./bus";
import { tmpdir } from "os";

/** Persist a turn, but never let the history write break the run that produced it. Repo-level runs
 *  (Slack, keyed `slack:…`) carry no branch and so belong to no workstream — they're skipped.
 *
 *  Fire-and-forget on purpose: the database is async (Postgres) but `launch()` returns its receipt
 *  synchronously, and a history write must never be something the run waits on. The write is still
 *  ordered per run, because `startTurn` is awaited inside the same chain the exit handler joins. */
function recordTurn(options: LaunchOptions, write: () => Promise<void>): Promise<void> {
  if (!options.repo || !options.branch) return Promise.resolve();
  const pending = write().catch((e) => console.error("orca: chat history write failed", e));
  historyWrites.add(pending);
  void pending.finally(() => historyWrites.delete(pending));
  return pending;
}

// In-flight history writes. Fire-and-forget is right for the RUN (it must never wait on the DB), but
// shutdown and tests need a point at which they are known to have landed — otherwise the pool closes
// underneath a write and the turn is lost for the very reason the DB exists.
const historyWrites = new Set<Promise<unknown>>();

/** Wait for every outstanding history write. Call before closing the pool (shutdown, teardown). */
export async function flushHistory(): Promise<void> {
  while (historyWrites.size) await Promise.all([...historyWrites]);
}

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
  repo?: string; // with `branch`, identifies the workstream this run's turn is recorded against
  branch?: string; // recorded on the lease so restart recovery can match by branch
  model?: string; // repo's `agentModel` — claude only; unset means the CLI's own default
  permissionMode?: "bypass" | "ask"; // repo's `agentPermissionMode`; `ask` (the default) is NOT bypass
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

// How long to let stdout/stderr drain after the process exits before finalizing the turn anyway.
// Generous for a normal exit (the pipe closes immediately), bounded for the pathological one.
const DRAIN_GRACE_MS = 2_000;

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
async function readCodexOutput(key: string, proc: Bun.Subprocess<"ignore", "pipe", "pipe">, holder: { raw: string }): Promise<string> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let raw = "";
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += value;
    holder.raw = raw;
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

/** A run's recorded steps — the agent's thought process — oldest first, `tail` limiting to the last
 *  N. Read from the transcript file rather than memory, so it works for a FINISHED run and survives a
 *  bridge restart (that's the whole point: the chat's history used to die with the process). */
export function runSteps(runId: string, tail?: number): Promise<AgentStep[]> {
  return transcript.read(runId, tail);
}

function toolActivity(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const file = typeof i.file_path === "string" ? i.file_path.split("/").pop() : undefined;
  const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
  switch (name) {
    case "Read": return file ? `Reading ${file}` : "Reading a file";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return file ? `Editing ${file}` : "Editing a file";
    case "Bash": return typeof i.command === "string" ? `Running: ${oneLine(i.command, 120)}` : "Running a command";
    case "Grep": return typeof i.pattern === "string" ? `Searching for ${oneLine(i.pattern, 60)}` : "Searching";
    case "Glob": return "Finding files";
    case "Task": return "Delegating to a subagent";
    case "WebFetch": case "WebSearch": return "Searching the web";
    default: return `Using ${name}`;
  }
}

/** The step(s) one claude stream-json event contributes. Assistant events carry the model's text,
 *  its thinking, and the tools it invokes; `user` events carry the tool RESULTS that come back —
 *  those used to be dropped entirely, which is why the chat could show "Running: bun test" but never
 *  what the tests said. Everything else (init, result) adds no step. Pure, so a test pins the
 *  event→step mapping without a running CLI. */
export function claudeSteps(event: unknown): AgentStep[] {
  const e = event as { type?: string; message?: { content?: unknown } };
  if (!Array.isArray(e?.message?.content)) return [];
  const at = Date.now();
  const steps: AgentStep[] = [];
  for (const block of e.message.content as Array<Record<string, unknown>>) {
    if (e.type === "assistant" && block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      steps.push({ at, kind: "text", text: block.text.trim() });
    } else if (e.type === "assistant" && block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      steps.push({ at, kind: "thinking", text: block.thinking.trim() });
    } else if (e.type === "assistant" && block?.type === "tool_use" && typeof block.name === "string") {
      steps.push({ at, kind: "tool", name: block.name, text: toolActivity(block.name, block.input), detail: toolDetail(block.input) });
    } else if (e.type === "user" && block?.type === "tool_result") {
      const out = toolResultText(block.content);
      if (out) steps.push({ at, kind: "tool", name: "result", output: out, isError: block.is_error === true });
    }
  }
  return steps;
}

/** The tool's own input, verbatim-ish, for the expandable detail line (the full command, the whole
 *  pattern, the absolute path) — `text` only carries the short summary. */
function toolDetail(input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const k of ["command", "pattern", "file_path", "url", "prompt", "query"]) {
    if (typeof i[k] === "string" && (i[k] as string).trim()) return (i[k] as string).trim();
  }
  return undefined;
}

/** A tool_result's content is either a plain string or an array of typed blocks. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((b) => (b && typeof b === "object" && (b as Record<string, unknown>).type === "text" ? String((b as Record<string, unknown>).text ?? "") : ""))
    .filter(Boolean).join("\n").trim();
  return text || undefined;
}

/** Read claude's `--output-format stream-json` JSONL without waiting for exit, persisting each step
 *  to the run's transcript so `/api/turns` can show it live AND after the fact. Returns the full raw
 *  stream for parseClaudeStreamOutput to extract the final outcome at exit. */
async function readClaudeStream(runId: string, proc: Bun.Subprocess<"ignore", "pipe", "pipe">, holder: { raw: string }, owner?: { repo?: string; branch?: string }): Promise<string> {
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let raw = "";
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += value;
    holder.raw = raw;
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      const written = await transcript.append(runId, claudeSteps(event));
      // Push to any chat stream open on THIS instance — which is the only place a stream for this
      // run can be served, since a request for a repo owned elsewhere is proxied to its owner.
      if (written.length && owner?.repo && owner.branch) {
        bus.publish({ kind: "step", runId, repo: owner.repo, branch: owner.branch, steps: written });
      }
    }
  }
  transcript.forget(runId);
  return raw;
}

/** Extract claude's final outcome from the stream. The last `type:"result"` event is the same object
 *  the old `--output-format json` emitted (result text, is_error, usage/cost/modelUsage), so
 *  parseRunMeta is unchanged; a missing result event (crash) falls back to a bare parse. Pure. */
export function parseClaudeStreamOutput(raw: string): { sessionId?: string; result?: string; isError: boolean; meta?: RunMeta } {
  let resultEvent: Record<string, unknown> | undefined;
  let sessionId: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (typeof e.session_id === "string") sessionId = e.session_id;
      if (e.type === "result") resultEvent = e;
    } catch { /* tolerate non-JSON diagnostic lines */ }
  }
  if (!resultEvent) {
    try {
      const j = JSON.parse(raw.trim());
      return { sessionId, result: j.result, isError: Boolean(j.is_error), meta: parseRunMeta(j) };
    } catch { return { sessionId, isError: false }; }
  }
  return { sessionId, result: resultEvent.result as string | undefined, isError: Boolean(resultEvent.is_error), meta: parseRunMeta(resultEvent) };
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
export function agentCommand(provider: AgentProvider, cwd: string, prompt: string, resume?: string, sessionId?: string, model?: string, permissionMode: "bypass" | "ask" = "ask"): string[] {
  if (provider === "codex") {
    return resume
      ? ["codex", "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", resume, "--", prompt]
      : ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, "--", prompt];
  }
  if (provider === "cursor") {
    return ["cursor-agent", "-p", ...(resume ? ["--resume", resume] : []), "--output-format", "json", "--force", "--trust", "--", prompt];
  }
  // stream-json (not json) so the run's steps arrive AS THEY HAPPEN — read incrementally in
  // readClaudeStream to feed the chat modal's live activity trail. --verbose is mandatory with
  // stream-json under -p. The final `result` event is the same object the old `json` form emitted,
  // so parseClaudeStreamOutput extracts the identical outcome/meta at exit.
  // `model` comes from the repo's `agentModel`; unset → the claude CLI's own default. The permission
  // mode is the repo's: `bypassPermissions` was unconditional, which is fine for your own repo and
  // much less so for a client's, so a repo now opts into it.
  return ["claude", "-p", "--permission-mode", permissionMode === "bypass" ? "bypassPermissions" : "default", ...(model ? ["--model", model] : []), ...(resume ? ["--resume", resume] : ["--session-id", sessionId ?? crypto.randomUUID()]), "--output-format", "stream-json", "--verbose", "--", prompt];
}

export async function launch(key: string, cwd: string, prompt: string, options: LaunchOptions = {}): Promise<LaunchReceipt> {
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
    agentCommand(provider, cwd, effectivePrompt, options.resume, sessionId, options.model, options.permissionMode),
    { cwd, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const timeout = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined;
  runs.set(key, { status: "running", provider, runId, prompt, sessionId, proc, startedAt });
  lease.acquire({ key, worktreePath: cwd, branch: options.branch, provider, runId, pid: proc.pid, startedAt, timeoutMs: options.timeoutMs });
  // Record the turn NOW, not at exit: a run whose bridge dies then survives as an interrupted turn
  // instead of vanishing. Keyed by runId, so a fast follow-up can't clobber the previous turn.
  // Awaited, not fire-and-forget: "the turn exists before the run can produce output" is the whole
  // reason it is written at launch, and an async database must not quietly weaken it.
  const started = recordTurn(options, () => db.startTurn({
    repo: options.repo!, branch: options.branch!, runId, provider, prompt, sessionId, startedAt,
  }));
  await started;
  void (async () => {
    // Read stdout/stderr, but NEVER let the pipe decide when the turn is finalized. Killing the CLI
    // does not necessarily close its stdout — a grandchild (a shell's `sleep`, a spawned build) can
    // hold the write end open indefinitely, and waiting on EOF would leave the turn stuck `running`
    // forever with its work unrecorded. So: wait for the process to exit, then give the readers a
    // short grace to drain, then proceed with whatever landed (the holders expose partial output).
    const outHolder = { raw: "" };
    const errHolder = { raw: "" };
    const reads = Promise.all([
      provider === "codex" ? readCodexOutput(key, proc, outHolder)
        : provider === "claude" ? readClaudeStream(runId, proc, outHolder, { repo: options.repo, branch: options.branch })
        : new Response(proc.stdout).text().then((t) => (outHolder.raw = t)),
      new Response(proc.stderr).text().then((t) => (errHolder.raw = t)),
    ]);
    const code = await proc.exited;
    await Promise.race([reads, new Promise((r) => setTimeout(r, DRAIN_GRACE_MS))]);
    const out = outHolder.raw;
    const err = errHolder.raw;
    if (timeout) clearTimeout(timeout);
    // A superseded (re-run) or stopped run must not clobber the live `runs` entry — but its output is
    // still real work that happened, so it's parsed and its turn is still completed in the DB. This
    // is exactly the history the old in-memory map lost when a fast follow-up overwrote its key.
    const superseded = runs.get(key)?.proc !== proc;
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
      const parsed = parseClaudeStreamOutput(out);
      result = parsed.result;
      isError = parsed.isError;
      meta = parsed.meta;
      resolvedSessionId = parsed.sessionId ?? resolvedSessionId;
    }
    transcript.forget(runId); // run finished — the transcript file stays; it IS the history now
    const finishedAt = Date.now();
    if (meta) meta.durationMs ??= finishedAt - startedAt;
    const structured = result ? parseAgentOutcome(result) : undefined;
    const common = { provider, runId, prompt, sessionId: resolvedSessionId, result, structured, meta, startedAt, finishedAt };
    const ok = code === 0 && !isError;
    const wasStopped = stoppedRuns.delete(runId);
    const error = ok ? undefined : (err.trim() || result || `exit ${code}`).slice(0, 300);
    await started; // finish can never overtake start, however fast the run was
    recordTurn(options, () => db.finishTurn(runId, {
      // A run you stopped is not a failure: whatever it completed stands, and the session id below
      // keeps it resumable, so a follow-up redirects it rather than starting over.
      status: wasStopped ? "stopped" : ok ? "done" : "error",
      // A failed run still has something worth keeping — the error is the turn's outcome.
      response: wasStopped ? (result ?? "Stopped. The work so far stands; reply to redirect.") : (result ?? error),
      structured, sessionId: resolvedSessionId, finishedAt,
    }));
    if (superseded) return;
    lease.release(key, runId); // this run is done — free the worktree (no-op if a re-run already took the lease)
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
      : { status: "error", ...common, error });
    // An instruction typed while this run was in flight goes now. Fire-and-forget and after the run
    // is marked finished, so the queued launch sees a free worktree.
    if (options.repo && options.branch) void dispatchQueued(options.repo, options.branch, options);
  })();
  return { status: "running", provider, runId, sessionId };
}

/** Feature/fix run inside a worktree — keyed by the worktree path. */
export const runAgent = (worktreePath: string, prompt: string, options?: LaunchOptions): Promise<LaunchReceipt> => launch(worktreePath, worktreePath, prompt, options);

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
    // Pin sonnet like the one-shot fallback: resuming otherwise inherits the implementation model
    // (opus), and writing a PR body from an already-loaded session doesn't need it — it's ~half the
    // wall clock of a Promote.
    return ["claude", "-p", prompt, "--resume", resume, "--model", "sonnet", "--tools", "", "--disable-slash-commands", "--output-format", "json"];
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

// Runs you stopped deliberately. The exit handler reads this so an interrupted run is recorded as
// `stopped` rather than `error` — the work it already did stands, and its session stays resumable.
const stoppedRuns = new Set<string>();

// Set by index.ts, which owns the config a queued launch needs (model, permission mode, timeout).
// A module-level hook rather than an import, so agent.ts keeps knowing nothing about config or HTTP.
let queuedLauncher: ((message: db.QueuedMessage) => Promise<void>) | undefined;
export function onQueuedMessage(fn: (message: db.QueuedMessage) => Promise<void>): void {
  queuedLauncher = fn;
}

/** Send the next instruction queued for a branch, if any. Claimed in one statement, so a restart
 *  racing itself — or a second instance — cannot dispatch the same message twice. */
async function dispatchQueued(repo: string, branch: string, options: LaunchOptions): Promise<void> {
  if (!queuedLauncher) return;
  try {
    const next = await db.claimQueuedMessage(repo, branch);
    if (!next) return;
    await queuedLauncher(next);
  } catch (e) {
    // Never let a queued send break the run that just finished; the message stays claimed rather
    // than retrying forever against a worktree that may be gone.
    console.error("orca: queued message dispatch failed", e);
  }
}

/** Kill and forget a run (e.g. on discard, or Stop from the chat). Returns the runId it stopped, if
 *  any, so a caller can report what it interrupted. */
export function stop(key: string): string | undefined {
  const r = runs.get(key);
  if (r?.runId && r.status === "running") stoppedRuns.add(r.runId);
  try { r?.proc?.kill(); } catch { /* already gone */ }
  runs.delete(key);
  lease.release(key); // discard/stop frees the worktree even if the run was recovered from a lease
  return r?.runId;
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
