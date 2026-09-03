export const AGENT_PROVIDERS = ["claude", "codex", "cursor"] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];

export type AgentOutcome = {
  outcome: string;
  verification: string[];
  decisions: string[];
  remaining: string[];
  commits: string[];
};

/** One step of an agent's run — what it said, thought, or did — stored as a content part, the way a
 *  model message carries it: a tool call keeps its id and FULL input, a result keeps the id of the
 *  call it answers. Persisted per run by server/transcript.ts (bounded there). Nothing here is
 *  pre-rendered: the label a call shows in the chat is derived at render time (web/src/steps.ts), so
 *  the stored row stays faithful and a new tool renders without a migration. */
export type AgentStep = {
  at: number;
  kind: "text" | "thinking" | "tool" | "result";
  /** Tool call id (`tool_use.id`, Codex item id, Cursor call id). A result carries the id of the
   *  call it answers; matching falls back to call order when a provider gives none. */
  id?: string;
  /** Tool name, when kind is "tool". */
  name?: string;
  /** Prose, for text/thinking. (Rows written before content parts also carried a pre-rendered tool
   *  label here — still honoured when rendering.) */
  text?: string;
  /** The tool's input, verbatim (string fields bounded — see transcript.ts). */
  input?: unknown;
  /** @deprecated rows written before `input` existed: one string of the input. Kept for display. */
  detail?: string;
  output?: string;
  isError?: boolean;
  /** Set by groupSteps once a call's result has landed — the chat auto-folds the call on it. */
  done?: boolean;
};

// Rows written before `kind: "result"` existed recorded a result as a tool step named "result".
const isResult = (s: AgentStep) => s.kind === "result" || (s.kind === "tool" && s.name === "result");

/** Fold each tool RESULT into the call it belongs to, so the chat renders one collapsible unit per
 *  tool use instead of a collapsed call followed by its output spilling down the page. Matched by
 *  call id when the provider supplies one (parallel calls may then return in any order); by call
 *  order otherwise, and for rows written before ids were kept. A result with no call left to match
 *  (a transcript that starts mid-run) keeps its own row rather than being dropped. Pure. */
export function groupSteps(steps: AgentStep[]): AgentStep[] {
  const grouped: AgentStep[] = [];
  const awaitingResult: AgentStep[] = [];
  for (const step of steps) {
    if (isResult(step)) {
      const at = step.id ? awaitingResult.findIndex((c) => c.id === step.id) : 0;
      const call = at >= 0 ? awaitingResult.splice(at, 1)[0] : undefined;
      if (call) {
        call.output = step.output;
        call.isError = step.isError;
        call.done = true;
      } else {
        grouped.push({ ...step, kind: "tool", name: "result", text: "Tool result", done: true }); // orphan — still collapsible, never bare
      }
      continue;
    }
    const copy = { ...step };
    grouped.push(copy);
    if (copy.kind === "tool") awaitingResult.push(copy);
  }
  return grouped;
}

/** A finished turn's steps without the final message: the model's last text IS the turn's response,
 *  which the chat renders on its own below the steps — leaving it in showed the answer twice. Pure. */
export function withoutFinalEcho(steps: AgentStep[], response: string): AgentStep[] {
  const last = steps.at(-1);
  return last?.kind === "text" && (last.text ?? "").trim() === response.trim() ? steps.slice(0, -1) : steps;
}

export type AgentTurn = {
  id: string;
  provider: AgentProvider;
  /** What the user actually typed (or the board action's label). `prompt` is the full text the CLI
   *  was given — the instruction plus the scenario's scaffolding and the outcome contract. */
  instruction?: string;
  prompt: string;
  response: string;
  structured?: AgentOutcome;
  sessionId?: string;
  failed?: boolean;
  /** You stopped this run from the chat. Distinct from `failed`: the work it did stands, and its
   *  session is still resumable — a follow-up picks up where it left off. */
  stopped?: boolean;
  startedAt?: number;
  finishedAt?: number;
  // The agent's recorded steps — its thought process — server-decorated onto /api/turns from the
  // run's transcript. Present for finished turns too, so the chat can show HOW a turn got there and
  // not just what it concluded.
  steps?: AgentStep[];
  /** Sequence number of the last step above — the cursor the chat's live tail resumes from. */
  stepSeq?: number;
};

const OUTCOME_HEADINGS = ["outcome", "verification", "decisions", "remaining", "commits"] as const;
const sectionValue = (raw: string): string[] => raw
  .split("\n")
  .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
  .filter((line) => line && line.toLowerCase() !== "none");

/** Tolerantly parse the compact Markdown contract without affecting run success. */
export function parseAgentOutcome(raw: string): AgentOutcome | undefined {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^\s*##\s+(Outcome|Verification|Decisions|Remaining|Commits)\s*#*\s*$/i)?.[1]?.toLowerCase();
    if (heading && OUTCOME_HEADINGS.includes(heading as typeof OUTCOME_HEADINGS[number])) {
      current = heading;
      sections.set(current, []);
    } else if (current) {
      sections.get(current)!.push(line);
    }
  }
  const outcome = sectionValue((sections.get("outcome") ?? []).join("\n")).join("\n");
  const parsed: AgentOutcome = {
    outcome,
    verification: sectionValue((sections.get("verification") ?? []).join("\n")),
    decisions: sectionValue((sections.get("decisions") ?? []).join("\n")),
    remaining: sectionValue((sections.get("remaining") ?? []).join("\n")),
    commits: sectionValue((sections.get("commits") ?? []).join("\n")),
  };
  return parsed.outcome || parsed.verification.length || parsed.decisions.length || parsed.remaining.length || parsed.commits.length
    ? parsed
    : undefined;
}

export const OUTCOME_CONTRACT = [
  "Finish your final response with these concise sections:",
  "## Outcome",
  "A concise description of what changed or what was discovered.",
  "## Verification",
  "- Commands/checks run and their results.",
  "## Decisions",
  "- Important implementation decisions or tradeoffs.",
  "## Remaining",
  "- Anything incomplete, blocked, or requiring attention. Use “None” when complete.",
  "## Commits",
  "- Commit hashes and subjects, if applicable. Use “None” when no commit was made.",
].join("\n");

/** Add the readable outcome contract once while preserving the caller's instruction verbatim. */
export function withOutcomeContract(instruction: string): string {
  if (/^\s*##\s+Outcome\s*$/im.test(instruction) && /^\s*##\s+Commits\s*$/im.test(instruction)) return instruction;
  return `${instruction}\n\nAvoid unrelated cleanup.\n\n${OUTCOME_CONTRACT}`;
}

export const agentLabel = (provider: AgentProvider): string => provider === "codex" ? "Codex" : provider === "cursor" ? "Cursor" : "Claude";

/** The CLI binary each provider shells out to — Cursor's is `cursor-agent`, not `cursor`. */
export const providerBinary = (provider: AgentProvider): string => provider === "cursor" ? "cursor-agent" : provider;

export function isAgentProvider(value: unknown): value is AgentProvider {
  return AGENT_PROVIDERS.includes(value as AgentProvider);
}

// A handoff is intentionally portable prose, not a provider's private session format. The worktree
// remains the source of truth; the bounded transcript supplies decisions and conversational intent.
// About 3k tokens in typical code/task prose: enough for recent decisions without making a new
// provider pay to ingest an ever-growing raw transcript. The worktree remains authoritative.
const HANDOFF_LIMIT = 12_000;
export function handoffPrompt(turns: AgentTurn[], prompt: string, from: AgentProvider | undefined, to: AgentProvider): string {
  const header = [
    from === to
      ? `You are ${agentLabel(to)}, continuing this worktree from its portable conversation transcript.`
      : `You are ${agentLabel(to)}, taking over this worktree from ${from ? agentLabel(from) : "another agent"}.`,
    "Continue the work using the portable conversation transcript below.",
    "Treat the files, git status, commits, and test results in the worktree as the source of truth;",
    "verify the transcript against them before changing anything. Do not repeat already-completed work.",
  ].join(" ");
  const renderOutcome = (turn: AgentTurn): string => turn.structured ? [
    turn.structured.remaining.length ? `Remaining:\n${turn.structured.remaining.map((v) => `- ${v}`).join("\n")}` : "",
    turn.structured.decisions.length ? `Decisions:\n${turn.structured.decisions.map((v) => `- ${v}`).join("\n")}` : "",
    turn.structured.outcome ? `Outcome:\n${turn.structured.outcome}` : "",
    turn.structured.verification.length ? `Verification:\n${turn.structured.verification.map((v) => `- ${v}`).join("\n")}` : "",
    turn.structured.commits.length ? `Commits:\n${turn.structured.commits.map((v) => `- ${v}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n") : turn.response;
  const rendered = turns.map((t) => [
    `### ${agentLabel(t.provider)} turn`,
    "User / Orca instruction:",
    t.prompt,
    "",
    `${agentLabel(t.provider)} outcome:`,
    renderOutcome(t),
  ].join("\n"));
  // Preserve the newest decisions when history is large. Add whole turns until the cap is reached.
  const kept: string[] = [];
  let used = header.length + prompt.length + 200;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const turn = rendered[i]!;
    if (used + turn.length > HANDOFF_LIMIT) break;
    kept.unshift(turn);
    used += turn.length;
  }
  return [
    header,
    "",
    "## Prior conversation",
    kept.length ? kept.join("\n\n") : "(No completed portable turns were available.)",
    "",
    "## Current instruction",
    prompt,
  ].join("\n");
}

// Three cases: a known session id → resume it exactly; no id but the provider HAS run here → continue
// its most recent conversation; `fresh` (the provider has never run in this worktree, e.g. right
// after switching the pinned agent) → start a new session, since `--continue`/`resume --last`/`-c`
// would error with "no conversation to continue".
export function attachCommand(input: { worktreePath: string; provider?: AgentProvider; sessionId?: string; fresh?: boolean; seedFile?: string }): string {
  const cd = `cd "${input.worktreePath}" && `;
  // A seed file (written when handing off to a provider that hasn't run here) starts a NEW interactive
  // session with the portable transcript as its opening prompt — so the maxed/previous model is never
  // resumed, and you can carry on prompting the new model in-context. Only set on the `fresh` path.
  const seed = input.seedFile ? `"$(cat "${input.seedFile}")" ` : "";
  // Orca launches Codex through `codex exec`, so its threads are marked non-interactive. The TUI's
  // resume command excludes those by default; include them explicitly or it opens a blank session.
  if (input.provider === "codex") {
    if (input.sessionId) return `${cd}codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox ${input.sessionId}`;
    if (seed) return `${cd}codex ${seed}--dangerously-bypass-approvals-and-sandbox`;
    return input.fresh ? `${cd}codex --dangerously-bypass-approvals-and-sandbox` : `${cd}codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox --last`;
  }
  if (input.provider === "cursor") {
    if (input.sessionId) return `${cd}cursor-agent --resume ${input.sessionId} --force`;
    if (seed) return `${cd}cursor-agent ${seed}--force`;
    return `${cd}cursor-agent ${input.fresh ? "" : "--continue "}--force`;
  }
  if (input.sessionId) return `${cd}claude --resume ${input.sessionId} --permission-mode auto`;
  if (seed) return `${cd}claude ${seed}--permission-mode auto`;
  return `${cd}claude ${input.fresh ? "" : "--continue "}--permission-mode auto`;
}
