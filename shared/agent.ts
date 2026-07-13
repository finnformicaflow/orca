export const AGENT_PROVIDERS = ["claude", "codex"] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];
export type AgentMode = "continue" | "new";

export type AgentTurn = {
  id: string;
  provider: AgentProvider;
  prompt: string;
  response: string;
  startedAt?: number;
  finishedAt?: number;
};

export const agentLabel = (provider: AgentProvider): string => provider === "codex" ? "Codex" : "Claude";

export function isAgentProvider(value: unknown): value is AgentProvider {
  return AGENT_PROVIDERS.includes(value as AgentProvider);
}

// A handoff is intentionally portable prose, not a provider's private session format. The worktree
// remains the source of truth; the bounded transcript supplies decisions and conversational intent.
const HANDOFF_LIMIT = 24_000;
export function handoffPrompt(turns: AgentTurn[], prompt: string, from: AgentProvider | undefined, to: AgentProvider): string {
  const header = [
    `You are ${agentLabel(to)}, taking over this worktree from ${from ? agentLabel(from) : "another agent"}.`,
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
  if (input.provider === "codex") return `${cd}codex${input.sessionId ? ` resume ${input.sessionId}` : ""}`;
  return `${cd}claude${input.sessionId ? ` --resume ${input.sessionId}` : " --continue"}`;
}
