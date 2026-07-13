export const AGENT_PROVIDERS = ["claude", "codex", "agy"] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];

export type AgentTurn = {
  id: string;
  provider: AgentProvider;
  prompt: string;
  response: string;
  startedAt?: number;
  finishedAt?: number;
};

export const agentLabel = (provider: AgentProvider): string => provider === "codex" ? "Codex" : provider === "agy" ? "Antigravity" : "Claude";

export function isAgentProvider(value: unknown): value is AgentProvider {
  return AGENT_PROVIDERS.includes(value as AgentProvider);
}

// A handoff is intentionally portable prose, not a provider's private session format. The worktree
// remains the source of truth; the bounded transcript supplies decisions and conversational intent.
const HANDOFF_LIMIT = 24_000;
export function handoffPrompt(turns: AgentTurn[], prompt: string, from: AgentProvider | undefined, to: AgentProvider): string {
  const header = [
    from === to
      ? `You are ${agentLabel(to)}, continuing this worktree from its portable conversation transcript.`
      : `You are ${agentLabel(to)}, taking over this worktree from ${from ? agentLabel(from) : "another agent"}.`,
    "Continue the work using the portable conversation transcript below.",
    "Treat the files, git status, commits, and test results in the worktree as the source of truth;",
    "verify the transcript against them before changing anything. Do not repeat already-completed work.",
  ].join(" ");
  const rendered = turns.map((t) => [
    `### ${agentLabel(t.provider)} turn`,
    "User / Orca instruction:",
    t.prompt,
    "",
    `${agentLabel(t.provider)} outcome:`,
    t.response,
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

export function attachCommand(input: { worktreePath: string; provider?: AgentProvider; sessionId?: string }): string {
  const cd = `cd "${input.worktreePath}" && `;
  // Orca launches Codex through `codex exec`, so its threads are marked non-interactive. The TUI's
  // resume command excludes those by default; include them explicitly or it opens a blank session.
  if (input.provider === "codex") {
    return `${cd}codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox ${input.sessionId ?? "--last"}`;
  }
  if (input.provider === "agy") return `${cd}agy${input.sessionId ? ` --conversation ${input.sessionId}` : " -c"} --dangerously-skip-permissions`;
  return `${cd}claude${input.sessionId ? ` --resume ${input.sessionId}` : " --continue"} --permission-mode auto`;
}
