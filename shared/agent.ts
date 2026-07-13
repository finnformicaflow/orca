export const AGENT_PROVIDERS = ["claude", "codex", "agy"] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];

export type AgentOutcome = {
  outcome: string;
  verification: string[];
  decisions: string[];
  remaining: string[];
  commits: string[];
};

export type AgentTurn = {
  id: string;
  provider: AgentProvider;
  prompt: string;
  response: string;
  structured?: AgentOutcome;
  sessionId?: string;
  failed?: boolean;
  startedAt?: number;
  finishedAt?: number;
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

export const agentLabel = (provider: AgentProvider): string => provider === "codex" ? "Codex" : provider === "agy" ? "Antigravity" : "Claude";

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
export function attachCommand(input: { worktreePath: string; provider?: AgentProvider; sessionId?: string; fresh?: boolean }): string {
  const cd = `cd "${input.worktreePath}" && `;
  // Orca launches Codex through `codex exec`, so its threads are marked non-interactive. The TUI's
  // resume command excludes those by default; include them explicitly or it opens a blank session.
  if (input.provider === "codex") {
    if (input.sessionId) return `${cd}codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox ${input.sessionId}`;
    return input.fresh ? `${cd}codex` : `${cd}codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox --last`;
  }
  if (input.provider === "agy") {
    if (input.sessionId) return `${cd}agy --conversation ${input.sessionId} --dangerously-skip-permissions`;
    return `${cd}agy ${input.fresh ? "" : "-c "}--dangerously-skip-permissions`;
  }
  if (input.sessionId) return `${cd}claude --resume ${input.sessionId} --permission-mode auto`;
  return `${cd}claude ${input.fresh ? "" : "--continue "}--permission-mode auto`;
}
