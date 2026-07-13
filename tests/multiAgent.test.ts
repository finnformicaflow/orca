import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { agentCommand, agySessionIdFromCache, isHeadlessAgentProcess, oneShotCommand, parseAgyOutput, parseCodexOutput, prDescriptionCommand } from "../server/agent";
import { attachCommand, handoffPrompt, parseAgentOutcome, withOutcomeContract, type AgentTurn } from "../shared/agent";
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
    expect(store.agentProviders()).toContain("agy");
  });

  test("builds native fresh/resume commands for Claude, Codex, and Antigravity", () => {
    expect(agentCommand("claude", "/wt/x", "go", "c-1")).toEqual([
      "claude", "-p", "go", "--permission-mode", "bypassPermissions", "--resume", "c-1", "--output-format", "json",
    ]);
    expect(agentCommand("codex", "/wt/x", "go")).toEqual([
      "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-C", "/wt/x", "go",
    ]);
    expect(agentCommand("codex", "/wt/x", "go", "x-1")).toEqual([
      "codex", "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", "x-1", "go",
    ]);
    expect(agentCommand("agy", "/wt/x", "go")).toEqual([
      "agy", "-p", "go", "--dangerously-skip-permissions",
    ]);
    expect(agentCommand("agy", "/wt/x", "go", "a-1")).toEqual([
      "agy", "--conversation", "a-1", "-p", "go", "--dangerously-skip-permissions",
    ]);
  });

  test("recognizes new and resumed Antigravity runs for recovered status and stopping", () => {
    expect(isHeadlessAgentProcess("123 /usr/local/bin/agy -p implement feat-1 --dangerously-skip-permissions")).toBe(true);
    expect(isHeadlessAgentProcess("123 agy --conversation a-1 -p continue feat-1 --dangerously-skip-permissions")).toBe(true);
    expect(isHeadlessAgentProcess("123 agy --conversation a-1")).toBe(false);
  });

  test("uses the selected provider for isolated title and PR-description one-shots", () => {
    expect(oneShotCommand("claude", "/wt/x", "title", "title")).toContain("haiku");
    expect(oneShotCommand("codex", "/wt/x", "title", "title")[0]).toBe("codex");
    expect(oneShotCommand("codex", "/wt/x", "body", "description")).toContain("--ephemeral");
    expect(oneShotCommand("agy", "/wt/x", "body", "description")[0]).toBe("agy");
    expect(oneShotCommand("codex", "/wt/x", "body", "description")).not.toContain("claude");
    expect(oneShotCommand("agy", "/wt/x", "body", "description")).not.toContain("claude");
  });

  test("PR descriptions resume each provider's native session in read-only mode", () => {
    expect(prDescriptionCommand("claude", "/wt/x", "body", "c-1")).toEqual([
      "claude", "-p", "body", "--resume", "c-1", "--tools", "", "--disable-slash-commands", "--output-format", "json",
    ]);
    expect(prDescriptionCommand("codex", "/wt/x", "body", "x-1")).toEqual([
      "codex", "exec", "resume", "--json", "-c", 'sandbox_mode="read-only"', "x-1", "body",
    ]);
    expect(prDescriptionCommand("agy", "/wt/x", "body", "a-1")).toEqual([
      "agy", "--conversation", "a-1", "-p", "body", "--mode", "plan", "--dangerously-skip-permissions",
    ]);
  });

  test("parses the Codex JSONL session id and final agent message", () => {
    const parsed = parseCodexOutput([
      JSON.stringify({ type: "thread.started", thread_id: "codex-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Finished the work" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } }),
    ].join("\n"));
    expect(parsed).toEqual({
      sessionId: "codex-123", result: "Finished the work", isError: false,
      meta: { model: "Codex", numTurns: 1, inputTokens: 12, outputTokens: 3, cacheReadTokens: undefined },
    });
  });

  test("parses Antigravity print-mode output", () => {
    expect(parseAgyOutput("Finished the work\n")).toEqual({
      result: "Finished the work", meta: { model: "Antigravity", numTurns: 1 },
    });
    expect(agySessionIdFromCache('{"/wt/x":"agy-123"}', "/wt/x")).toBe("agy-123");
    expect(agySessionIdFromCache("not json", "/wt/x")).toBeUndefined();
  });

  test("portable handoff includes prior instructions/outcomes and the new request", () => {
    const prompt = handoffPrompt(prior, "Now add eviction", "claude", "codex");
    expect(prompt).toContain("taking over this worktree from Claude");
    expect(prompt).toContain("Implement the cache");
    expect(prompt).toContain("committed abc123");
    expect(prompt).toContain("Now add eviction");
    expect(prompt).toContain("source of truth");
  });

  test("parses complete, partial, empty, and malformed structured outcomes tolerantly", () => {
    expect(parseAgentOutcome("## outcome\nImplemented it.\n\n## Verification\n* bun test — passed\n\n## Decisions\n1. Kept the API stable\n\n## Remaining\nNone\n\n## Commits\n- abc123 Add it")).toEqual({
      outcome: "Implemented it.", verification: ["bun test — passed"], decisions: ["Kept the API stable"], remaining: [], commits: ["abc123 Add it"],
    });
    expect(parseAgentOutcome("## Remaining\n- Fix the failing check")).toEqual({
      outcome: "", verification: [], decisions: [], remaining: ["Fix the failing check"], commits: [],
    });
    expect(parseAgentOutcome("## Outcome\n\n## Remaining\nNone")).toBeUndefined();
    expect(parseAgentOutcome("Implemented it without the requested headings")).toBeUndefined();
  });

  test("adds the final-response contract once without rewriting the instruction", () => {
    const instruction = "Change only src/a.ts exactly as requested.";
    const wrapped = withOutcomeContract(instruction);
    expect(wrapped.startsWith(instruction)).toBe(true);
    expect(wrapped.match(/## Outcome/g)?.length).toBe(1);
    expect(withOutcomeContract(wrapped)).toBe(wrapped);
  });

  test("structured handoffs prefer compact state and omit the same turn's raw prose", () => {
    const prompt = handoffPrompt([{
      ...prior[0]!, response: "RAW RESPONSE SHOULD NOT BE COPIED",
      structured: { outcome: "Cache implemented", verification: ["bun test passed"], decisions: ["Used LRU"], remaining: ["Add eviction"], commits: ["abc123 Cache"] },
    }], "Continue", "claude", "codex");
    expect(prompt).toContain("Remaining:\n- Add eviction");
    expect(prompt.indexOf("Remaining:")).toBeLessThan(prompt.indexOf("Outcome:"));
    expect(prompt).not.toContain("RAW RESPONSE SHOULD NOT BE COPIED");
  });

  test("Copy CLI uses the active provider's native resume command", () => {
    expect(attachCommand({ worktreePath: "/wt/x", provider: "claude", sessionId: "c-1" })).toBe('cd "/wt/x" && claude --resume c-1 --permission-mode auto');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "codex", sessionId: "x-1" })).toBe('cd "/wt/x" && codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox x-1');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "codex" })).toBe('cd "/wt/x" && codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox --last');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "agy", sessionId: "a-1" })).toBe('cd "/wt/x" && agy --conversation a-1 --dangerously-skip-permissions');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "agy" })).toBe('cd "/wt/x" && agy -c --dangerously-skip-permissions');
  });
});

describe("cross-provider continuation", () => {
  test("completed runs are persisted once as portable branch transcript", async () => {
    apiFake.agentsData = [{
      branch: "feat", worktreePath: "/wt/feat", agentStatus: "done", agentProvider: "claude",
      agentRunId: "run-1", agentPrompt: "build it", agentResult: "built it", sessionId: "c-1",
      agentOutcome: { outcome: "Built it", verification: ["bun test passed"], decisions: [], remaining: [], commits: ["abc Built"] },
      agentStartedAt: 10, agentFinishedAt: 20,
    }];
    await store.refresh();
    await store.refresh();
    const saved = JSON.parse(localStorage.getItem("orca.enrichment") ?? "{}")["r::feat"];
    expect(saved.agentProvider).toBe("claude");
    expect(saved.sessionId).toBe("c-1");
    expect(saved.transcript).toEqual([{
      id: "run-1", provider: "claude", prompt: "build it", response: "built it",
      structured: { outcome: "Built it", verification: ["bun test passed"], decisions: [], remaining: [], commits: ["abc Built"] },
      sessionId: "c-1", startedAt: 10, finishedAt: 20,
    }]);
  });

  test("old transcript turns without structured outcomes still load", async () => {
    localStorage.setItem("orca.enrichment", JSON.stringify({ "r::feat": { transcript: prior } }));
    apiFake.agentsData = [{ branch: "feat", worktreePath: "/wt/feat", agentStatus: "idle" }];
    await store.refresh();
    expect(store.useWorkstreams).toBeDefined();
    expect(JSON.parse(localStorage.getItem("orca.enrichment") ?? "{}")["r::feat"].transcript).toEqual(prior);
  });

  test("promotion passes the active native session, task, and latest outcome to the PR writer", async () => {
    const outcome = { outcome: "Built it", verification: ["bun test passed"], decisions: [], remaining: [], commits: [] };
    await store.promote({ ...row, prompt: "Build the cache", hasRemote: true, agentOutcome: outcome });
    expect(apiFake.promotions.at(-1)).toMatchObject({ provider: "claude", sessionId: "claude-session", task: "Build the cache", outcome });
  });

  test("same-provider Continue uses the native session id", async () => {
    await store.followUp(row, "one more change", [], { provider: "claude" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("claude");
    expect(launch.resume).toBe("claude-session");
    expect(launch.history).toBeUndefined();
  });

  test("Run again resumes the current native session instead of replaying a fresh task", async () => {
    await store.rerunAgent(row);
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("claude");
    expect(launch.resume).toBe("claude-session");
    expect(launch.prompt).toContain("Do not repeat completed work");
  });

  test("Run again includes bounded prior failure and unfinished verification evidence", async () => {
    await store.rerunAgent({
      ...row, prompt: "Implement the original cache behavior verbatim.", agentError: "command exited 1", agentOutcome: {
        outcome: "Implemented most of it", verification: ["bun test failed in cache.test.ts", "lint passed"],
        decisions: [], remaining: ["Repair cache eviction"], commits: [],
      },
    });
    const prompt = apiFake.agentLaunches.at(-1)!.prompt;
    expect(prompt).toContain("Previous error:\ncommand exited 1");
    expect(prompt).toContain("Original instruction:\nImplement the original cache behavior verbatim.");
    expect(prompt).toContain("Completed work:\nImplemented most of it");
    expect(prompt).toContain("Repair cache eviction");
    expect(prompt).toContain("bun test failed");
    expect(prompt.length).toBeLessThan(8_000);
  });

  test("a high-context Claude session resets through the compact portable handoff", async () => {
    await store.followUp({ ...row, agentMeta: { contextPct: 85 } }, "finish it", [], { provider: "claude" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.resume).toBeUndefined();
    expect(launch.handoffFrom).toBe("claude");
    expect(launch.history).toEqual(prior);
  });

  test("switching provider hands the portable transcript to a fresh session", async () => {
    await store.followUp(row, "take over", [], { provider: "codex" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("codex");
    expect(launch.resume).toBeUndefined();
    expect(launch.handoffFrom).toBe("claude");
    expect(launch.history).toEqual(prior);
  });

  test("switching to Antigravity hands it the same portable transcript", async () => {
    await store.followUp(row, "take over", [], { provider: "agy" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("agy");
    expect(launch.resume).toBeUndefined();
    expect(launch.handoffFrom).toBe("claude");
    expect(launch.history).toEqual(prior);
  });

  test("pinning the card's agent routes every action through it, handing off from the last-run provider", async () => {
    store.setCardProvider(row, "codex"); // persisted per branch, read by providerFor
    expect(JSON.parse(localStorage.getItem("orca.enrichment") ?? "{}")["r::feat"].preferredProvider).toBe("codex");
    // Fix CI (not just Follow up) now honours the pin — it used to hard-default to the last-run provider.
    await store.fixCi({ ...row, preferredProvider: "codex" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("codex");
    expect(launch.resume).toBeUndefined();  // switching agents → portable handoff, never a stale native resume
    expect(launch.handoffFrom).toBe("claude");
    expect(launch.history).toEqual(prior);
  });

  test("a pin matching the provider that last ran still resumes its native session", async () => {
    await store.followUp({ ...row, preferredProvider: "claude" }, "keep going");
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("claude");
    expect(launch.resume).toBe("claude-session");
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

  test("Codex resets by observed native turn count without inventing context occupancy", async () => {
    const transcript: AgentTurn[] = Array.from({ length: 12 }, (_, i) => ({
      id: `c-${i}`, provider: "codex", prompt: `turn ${i}`, response: "done", sessionId: "codex-session",
    }));
    await store.followUp({ ...row, agentProvider: "codex", sessionId: "codex-session", transcript }, "continue", [], { provider: "codex" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.resume).toBeUndefined();
    expect(launch.handoffFrom).toBe("codex");
    expect(launch.history).toEqual(transcript);
    expect(launch.prompt).not.toContain("% context");
  });

  test("Antigravity resets after repeated observed failures but otherwise resumes natively", async () => {
    const failed: AgentTurn[] = Array.from({ length: 3 }, (_, i) => ({
      id: `a-${i}`, provider: "agy", prompt: `turn ${i}`, response: "failed", sessionId: "agy-session", failed: true,
    }));
    await store.followUp({ ...row, agentProvider: "agy", sessionId: "agy-session", transcript: failed }, "repair", [], { provider: "agy" });
    expect(apiFake.agentLaunches.at(-1)!.resume).toBeUndefined();

    await store.followUp({ ...row, agentProvider: "agy", sessionId: "agy-session", transcript: failed.slice(0, 2) }, "continue", [], { provider: "agy" });
    expect(apiFake.agentLaunches.at(-1)!.resume).toBe("agy-session");
  });
});
