import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { agentCommand, parseCodexOutput } from "../server/agent";
import { attachCommand, handoffPrompt, type AgentTurn } from "../shared/agent";
import { apiFake } from "./apiFake";
import * as store from "@/store";

beforeAll(() => store.configReady);

const prior: AgentTurn[] = [{
  id: "turn-1", provider: "claude", prompt: "Implement the cache", response: "Added the cache and committed abc123.",
}];
const row: store.Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude", sessionId: "claude-session", transcript: prior,
};

afterEach(async () => {
  localStorage.clear();
  apiFake.reset();
  await store.refresh();
});

describe("provider adapters", () => {
  test("the provider snapshot is referentially stable for React cold starts", () => {
    expect(store.agentProviders()).toBe(store.agentProviders());
  });

  test("builds native fresh/resume commands for Claude and Codex", () => {
    expect(agentCommand("claude", "/wt/x", "go", "c-1")).toEqual([
      "claude", "-p", "go", "--permission-mode", "bypassPermissions", "--resume", "c-1", "--output-format", "json",
    ]);
    expect(agentCommand("codex", "/wt/x", "go")).toEqual([
      "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-C", "/wt/x", "go",
    ]);
    expect(agentCommand("codex", "/wt/x", "go", "x-1")).toEqual([
      "codex", "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", "x-1", "go",
    ]);
  });

  test("parses the Codex JSONL session id and final agent message", () => {
    const parsed = parseCodexOutput([
      JSON.stringify({ type: "thread.started", thread_id: "codex-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Finished the work" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } }),
    ].join("\n"));
    expect(parsed).toEqual({ sessionId: "codex-123", result: "Finished the work", isError: false, meta: { model: "Codex", numTurns: 1 } });
  });

  test("portable handoff includes prior instructions/outcomes and the new request", () => {
    const prompt = handoffPrompt(prior, "Now add eviction", "claude", "codex");
    expect(prompt).toContain("taking over this worktree from Claude");
    expect(prompt).toContain("Implement the cache");
    expect(prompt).toContain("committed abc123");
    expect(prompt).toContain("Now add eviction");
    expect(prompt).toContain("source of truth");
  });

  test("Copy CLI uses the active provider's native resume command", () => {
    expect(attachCommand({ worktreePath: "/wt/x", provider: "claude", sessionId: "c-1" })).toBe('cd "/wt/x" && claude --resume c-1');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "codex", sessionId: "x-1" })).toBe('cd "/wt/x" && codex resume --include-non-interactive x-1');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "codex" })).toBe('cd "/wt/x" && codex resume --include-non-interactive --last');
  });
});

describe("cross-provider continuation", () => {
  test("completed runs are persisted once as portable branch transcript", async () => {
    apiFake.agentsData = [{
      branch: "feat", worktreePath: "/wt/feat", agentStatus: "done", agentProvider: "claude",
      agentRunId: "run-1", agentPrompt: "build it", agentResult: "built it", sessionId: "c-1",
      agentStartedAt: 10, agentFinishedAt: 20,
    }];
    await store.refresh();
    await store.refresh();
    const saved = JSON.parse(localStorage.getItem("orca.enrichment") ?? "{}")["r::feat"];
    expect(saved.agentProvider).toBe("claude");
    expect(saved.sessionId).toBe("c-1");
    expect(saved.transcript).toEqual([{
      id: "run-1", provider: "claude", prompt: "build it", response: "built it", startedAt: 10, finishedAt: 20,
    }]);
  });

  test("same-provider Continue uses the native session id", async () => {
    await store.followUp(row, "one more change", [], { provider: "claude" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("claude");
    expect(launch.resume).toBe("claude-session");
    expect(launch.history).toBeUndefined();
  });

  test("switching provider hands the portable transcript to a fresh session", async () => {
    await store.followUp(row, "take over", [], { provider: "codex" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("codex");
    expect(launch.resume).toBeUndefined();
    expect(launch.handoffFrom).toBe("claude");
    expect(launch.history).toEqual(prior);
  });

  test("missing native session starts a fresh chat with portable context automatically", async () => {
    await store.followUp({ ...row, sessionId: undefined }, "keep going", [], { provider: "claude" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("claude");
    expect(launch.resume).toBeUndefined();
    expect(launch.history).toEqual(prior);
    expect(launch.handoffFrom).toBe("claude");
    expect(launch.key).toBe("/wt/feat");
  });
});
