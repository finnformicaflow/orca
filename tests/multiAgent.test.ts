import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { agentCommand, claudeSteps, codexSteps, cursorSteps, isHeadlessAgentProcess, oneShotCommand, parseClaudeStreamOutput, parseCodexOutput, parseCursorOutput, prDescriptionCommand } from "../server/agent";
import { attachCommand, handoffPrompt, parseAgentOutcome, providerBinary, withOutcomeContract, type AgentTurn } from "../shared/agent";
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
    expect(store.agentProviders()).toContain("cursor");
  });

  test("maps each provider to the CLI binary the availability check probes — Cursor's is cursor-agent, not cursor", () => {
    // The bug: /api/config filtered providers by Bun.which(provider), so Cursor (binary `cursor-agent`)
    // was never detected and never offered as an agent. Availability must probe the real binary name.
    expect(providerBinary("cursor")).toBe("cursor-agent");
    expect(providerBinary("claude")).toBe("claude");
    expect(providerBinary("codex")).toBe("codex");
  });

  test("builds native fresh/resume commands for Claude, Codex, and Cursor", () => {
    // The prompt is the trailing positional after `--` in every form (see the leading-dash case below).
    // `bypassPermissions` is no longer unconditional — a repo opts into it (see agentPermissionMode),
    // so the default form asks rather than bypassing.
    expect(agentCommand("claude", "/wt/x", "go", "c-1", undefined, undefined, "bypass")).toEqual([
      "claude", "-p", "--permission-mode", "bypassPermissions", "--resume", "c-1", "--output-format", "stream-json", "--verbose", "--", "go",
    ]);
    expect(agentCommand("claude", "/wt/x", "go", "c-1")).toEqual([
      "claude", "-p", "--permission-mode", "default", "--resume", "c-1", "--output-format", "stream-json", "--verbose", "--", "go",
    ]);
    expect(agentCommand("codex", "/wt/x", "go")).toEqual([
      "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-C", "/wt/x", "--", "go",
    ]);
    expect(agentCommand("codex", "/wt/x", "go", "x-1")).toEqual([
      "codex", "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", "x-1", "--", "go",
    ]);
    // stream-json, like claude: the steps have to arrive as they happen for the chat to show them.
    expect(agentCommand("cursor", "/wt/x", "go")).toEqual([
      "cursor-agent", "-p", "--output-format", "stream-json", "--force", "--trust", "--", "go",
    ]);
    expect(agentCommand("cursor", "/wt/x", "go", "a-1")).toEqual([
      "cursor-agent", "-p", "--resume", "a-1", "--output-format", "stream-json", "--force", "--trust", "--", "go",
    ]);
  });

  test("a repo's agentModel pins the Claude runs only, leaving the one-shots and other providers alone", () => {
    // Without it, headless runs silently inherit ~/.claude/settings.json's `model` — the same default
    // your interactive sessions use, which is not necessarily what you want Orca's agents on.
    const pinned = agentCommand("claude", "/wt/x", "go", undefined, "s-1", "claude-opus-5[1m]", "bypass");
    expect(pinned.slice(0, 6)).toEqual(["claude", "-p", "--permission-mode", "bypassPermissions", "--model", "claude-opus-5[1m]"]);
    expect(pinned.at(-1)).toBe("go"); // still the trailing positional after `--`
    expect(agentCommand("claude", "/wt/x", "go", "c-1", undefined, "opus")).toContain("--resume"); // resumes still pin
    // Unset → no flag at all, so the CLI default applies (never a hardcoded model).
    expect(agentCommand("claude", "/wt/x", "go", undefined, "s-1")).not.toContain("--model");
    // Claude-only: the other providers take their model from their own CLI config.
    expect(agentCommand("codex", "/wt/x", "go", undefined, undefined, "opus")).not.toContain("--model");
    expect(agentCommand("cursor", "/wt/x", "go", undefined, undefined, "opus")).not.toContain("--model");
    // The short blocking one-shots keep their own deliberate pins.
    expect(oneShotCommand("claude", "/wt/x", "t", "title")).toContain("haiku");
    expect(prDescriptionCommand("claude", "/wt/x", "b", "c-1")).toContain("sonnet");
  });

  test("a prompt that starts with '-' (a Markdown bullet) stays the prompt, never a CLI option", () => {
    // The bug: a user follow-up beginning with `- ` was parsed by every CLI as an unknown option and
    // the run died before the agent saw it (claude: `error: unknown option '- gather…'`). The `--`
    // end-of-options marker keeps it a positional. Each provider must put the dash-prompt AFTER `--`.
    const dash = "- gather children across all views";
    for (const provider of ["claude", "codex", "cursor"] as const) {
      const argv = agentCommand(provider, "/wt/x", dash);
      const sep = argv.indexOf("--");
      expect(sep).toBeGreaterThan(-1); // an end-of-options marker is present
      expect(argv.slice(sep + 1)).toEqual([dash]); // the prompt is the sole positional after it
      expect(argv.indexOf(dash)).toBe(argv.length - 1); // and appears nowhere a parser would read it as a flag
    }
  });

  test("recognizes new and resumed Cursor runs for recovered status and stopping", () => {
    expect(isHeadlessAgentProcess("123 /Users/x/.local/bin/cursor-agent -p implement feat-1 --force --trust")).toBe(true);
    expect(isHeadlessAgentProcess("123 cursor-agent -p continue feat-1 --resume a-1 --force --trust")).toBe(true);
    expect(isHeadlessAgentProcess("123 cursor-agent --resume a-1")).toBe(false);
  });

  test("uses the selected provider for isolated title and PR-description one-shots", () => {
    expect(oneShotCommand("claude", "/wt/x", "title", "title")).toContain("haiku");
    expect(oneShotCommand("codex", "/wt/x", "title", "title")[0]).toBe("codex");
    expect(oneShotCommand("codex", "/wt/x", "body", "description")).toContain("--ephemeral");
    expect(oneShotCommand("cursor", "/wt/x", "body", "description")[0]).toBe("cursor-agent");
    expect(oneShotCommand("cursor", "/wt/x", "body", "description")).toContain("ask"); // read-only
    expect(oneShotCommand("codex", "/wt/x", "body", "description")).not.toContain("claude");
    expect(oneShotCommand("cursor", "/wt/x", "body", "description")).not.toContain("claude");
  });

  test("PR descriptions resume each provider's native session in read-only mode", () => {
    // Claude pins sonnet like the one-shot: without it the resume inherits the implementation
    // model (opus) and Promote blocks on it for ~twice as long.
    expect(prDescriptionCommand("claude", "/wt/x", "body", "c-1")).toEqual([
      "claude", "-p", "body", "--resume", "c-1", "--model", "sonnet", "--tools", "", "--disable-slash-commands", "--output-format", "json",
    ]);
    expect(prDescriptionCommand("claude", "/wt/x", "body", "c-1")).not.toContain("opus");
    expect(prDescriptionCommand("codex", "/wt/x", "body", "x-1")).toEqual([
      "codex", "exec", "resume", "--json", "-c", 'sandbox_mode="read-only"', "x-1", "body",
    ]);
    expect(prDescriptionCommand("cursor", "/wt/x", "body", "a-1")).toEqual([
      "cursor-agent", "-p", "body", "--resume", "a-1", "--output-format", "json", "--mode", "ask", "--trust",
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

  test("parses Cursor's JSON result, session id, and usage", () => {
    expect(parseCursorOutput(JSON.stringify({
      type: "result", is_error: false, duration_ms: 1943, result: "Finished the work",
      session_id: "cursor-123", usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 7 },
    }))).toEqual({
      sessionId: "cursor-123", result: "Finished the work", isError: false,
      meta: { model: "Cursor", numTurns: 1, durationMs: 1943, inputTokens: 12, outputTokens: 3, cacheReadTokens: 5, cacheCreationTokens: 7 },
    });
    expect(parseCursorOutput("not json").isError).toBe(false); // non-JSON crash → exit code decides
  });

  test("parses Claude's stream-json final result event (same shape the old json form emitted)", () => {
    const parsed = parseClaudeStreamOutput([
      JSON.stringify({ type: "system", subtype: "init", session_id: "c-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "On it" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Finished the work", session_id: "c-1", total_cost_usd: 0.02, num_turns: 3 }),
    ].join("\n"));
    expect(parsed.result).toBe("Finished the work");
    expect(parsed.isError).toBe(false);
    expect(parsed.sessionId).toBe("c-1");
    expect(parsed.meta).toMatchObject({ costUsd: 0.02, numTurns: 3 });
    // A crash with no result event still yields a usable (non-throwing) outcome.
    expect(parseClaudeStreamOutput("boom, not json").isError).toBe(false);
  });

  test("maps claude stream events to structured steps, including thinking and tool results", () => {
    // Text keeps its newlines now (it's rendered as a paragraph, not squashed into one trail line).
    const text = claudeSteps({ type: "assistant", message: { content: [{ type: "text", text: "resolve the\n conflicts" }] } });
    expect(text).toMatchObject([{ kind: "text", text: "resolve the\n conflicts" }]);
    // Thinking used to be dropped entirely — it's the whole "what was it reasoning about" question.
    expect(claudeSteps({ type: "assistant", message: { content: [{ type: "thinking", thinking: "the lock is held" }] } }))
      .toMatchObject([{ kind: "thinking", text: "the lock is held" }]);
    // A tool call is stored as the content part it arrived as — id, name, and the WHOLE input — with
    // no pre-rendered label: an Edit's old/new strings survive, and the chat decides the wording.
    const call = claudeSteps({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Edit", input: { file_path: "/wt/x/src/foo.ts", old_string: "a", new_string: "b" } }] } });
    expect(call).toEqual([{ at: expect.any(Number), kind: "tool", id: "tu_1", name: "Edit", input: { file_path: "/wt/x/src/foo.ts", old_string: "a", new_string: "b" } }]);
    expect(call[0]).not.toHaveProperty("text");
    // A result carries the id of the call it answers — even when empty, since it's what marks the
    // call finished.
    expect(claudeSteps({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "2 pass 0 fail" }] } }))
      .toMatchObject([{ kind: "result", id: "tu_1", output: "2 pass 0 fail", isError: false }]);
    expect(claudeSteps({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: "boom" }], is_error: true }] } }))
      .toMatchObject([{ kind: "result", id: "tu_2", output: "boom", isError: true }]);
    expect(claudeSteps({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_3", content: "" }] } }))
      .toMatchObject([{ kind: "result", id: "tu_3", isError: false }]);
    // Bookkeeping events still contribute nothing.
    expect(claudeSteps({ type: "result", result: "done" })).toEqual([]);
    expect(claudeSteps({ type: "system", subtype: "init", session_id: "c-1" })).toEqual([]);
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
    expect(attachCommand({ worktreePath: "/wt/x", provider: "cursor", sessionId: "a-1" })).toBe('cd "/wt/x" && cursor-agent --resume a-1 --force');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "cursor" })).toBe('cd "/wt/x" && cursor-agent --continue --force');
    // No id but the provider has run here → continue its latest; `fresh` → start a new session.
    expect(attachCommand({ worktreePath: "/wt/x", provider: "claude" })).toBe('cd "/wt/x" && claude --continue --permission-mode auto');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "claude", fresh: true })).toBe('cd "/wt/x" && claude --permission-mode auto');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "codex", fresh: true })).toBe('cd "/wt/x" && codex --dangerously-bypass-approvals-and-sandbox');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "cursor", fresh: true })).toBe('cd "/wt/x" && cursor-agent --force');
  });

  test("Copy CLI seeds a fresh interactive session with the handoff file on a model switch", () => {
    const seedFile = "/state/handoff/r--feat.md";
    // Each provider starts a NEW interactive session with the transcript as its opening prompt.
    expect(attachCommand({ worktreePath: "/wt/x", provider: "claude", fresh: true, seedFile }))
      .toBe('cd "/wt/x" && claude "$(cat "/state/handoff/r--feat.md")" --permission-mode auto');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "codex", fresh: true, seedFile }))
      .toBe('cd "/wt/x" && codex "$(cat "/state/handoff/r--feat.md")" --dangerously-bypass-approvals-and-sandbox');
    expect(attachCommand({ worktreePath: "/wt/x", provider: "cursor", fresh: true, seedFile }))
      .toBe('cd "/wt/x" && cursor-agent "$(cat "/state/handoff/r--feat.md")" --force');
    // A known native session id always resumes it directly — no seed, the prior model isn't re-run.
    expect(attachCommand({ worktreePath: "/wt/x", provider: "cursor", sessionId: "a-1", seedFile }))
      .toBe('cd "/wt/x" && cursor-agent --resume a-1 --force');
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
    const saved = apiFake.enrichmentData.get("r::feat") as any;
    expect(saved.agentProvider).toBe("claude");
    expect(saved.sessionId).toBe("c-1");
    expect(saved.transcript).toEqual([{
      id: "run-1", provider: "claude", prompt: "build it", response: "built it",
      structured: { outcome: "Built it", verification: ["bun test passed"], decisions: [], remaining: [], commits: ["abc Built"] },
      sessionId: "c-1", startedAt: 10, finishedAt: 20,
    }]);
  });

  test("old transcript turns without structured outcomes still load", async () => {
    apiFake.enrichmentData.set("r::feat", { transcript: prior });
    apiFake.agentsData = [{ branch: "feat", worktreePath: "/wt/feat", agentStatus: "idle" }];
    await store.refresh();
    expect(store.useWorkstreams).toBeDefined();
    expect(apiFake.enrichmentData.get("r::feat")?.transcript).toEqual(prior);
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

  test("a session the provider reports missing is not resumed — it starts fresh", async () => {
    // The stuck-card loop: the first run died before claude created the session, so its id was never
    // real. Every follow-up then resumed it and re-failed with "No conversation found …". A latest
    // native turn carrying that session-missing error must force a fresh start, seeded from the transcript.
    const deadSession = "23c3e70d-dead";
    const failedOnly: AgentTurn[] = [
      { id: "t1", provider: "claude", sessionId: deadSession, prompt: "- gather children", response: "error: unknown option '- gather'", failed: true },
      { id: "t2", provider: "claude", sessionId: deadSession, prompt: "retry", response: "No conversation found with session ID: 23c3e70d-dead", failed: true },
    ];
    await store.followUp({ ...row, sessionId: deadSession, transcript: failedOnly }, "try again", [], { provider: "claude" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("claude");
    expect(launch.resume).toBeUndefined();          // NOT resuming the missing session
    expect(launch.handoffFrom).toBe("claude");      // fresh claude session, seeded from the transcript
    expect(launch.history).toEqual(failedOnly);
  });

  test("a plain task failure (session still exists) is resumed, not reset", async () => {
    // Guard must be precise: a run that failed for a normal reason — the session is still there —
    // must resume, or every failed follow-up would needlessly drop native continuity.
    const liveSession = "live-1";
    const taskFailed: AgentTurn[] = [
      { id: "t1", provider: "claude", sessionId: liveSession, prompt: "build it", response: "command exited 1: tests failed", failed: true },
    ];
    await store.followUp({ ...row, sessionId: liveSession, transcript: taskFailed }, "continue", [], { provider: "claude" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.resume).toBe(liveSession);
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

  test("switching to Cursor hands it the same portable transcript", async () => {
    await store.followUp(row, "take over", [], { provider: "cursor" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("cursor");
    expect(launch.resume).toBeUndefined();
    expect(launch.handoffFrom).toBe("claude");
    expect(launch.history).toEqual(prior);
  });

  test("pinning the card's agent routes every action through it, handing off from the last-run provider", async () => {
    store.setCardProvider(row, "codex"); // persisted per branch, read by providerFor
    expect(apiFake.enrichmentData.get("r::feat")?.preferredProvider).toBe("codex");
    // Fix CI (not just Follow up) now honours the pin — it used to hard-default to the last-run provider.
    await store.fixCi({ ...row, preferredProvider: "codex" });
    const launch = apiFake.agentLaunches.at(-1)!;
    expect(launch.provider).toBe("codex");
    expect(launch.resume).toBeUndefined();  // switching agents → portable handoff, never a stale native resume
    expect(launch.handoffFrom).toBe("claude");
    expect(launch.history).toEqual(prior);
  });

  test("Copy CLI / Promote follow the pin, and never resume an agent that hasn't run here", async () => {
    // Pin matches the last run → resume its native session by id.
    expect(store.resumeTarget(row)).toEqual({ provider: "claude", sessionId: "claude-session", fresh: false });
    // Pin points at an agent that never ran here → a FRESH session, not a session id from another
    // provider and not a `--continue` that errors with "no conversation to continue".
    const switched = store.resumeTarget({ ...row, preferredProvider: "codex" });
    expect(switched).toEqual({ provider: "codex", fresh: true });
    expect(attachCommand({ worktreePath: "/wt/feat", ...switched })).toBe('cd "/wt/feat" && codex --dangerously-bypass-approvals-and-sandbox');
    // The Claude counterpart of the reported bug: fresh Claude start, never `claude --continue`.
    const toClaude = store.resumeTarget({ ...row, agentProvider: "codex", sessionId: "codex-1", transcript: [{ id: "t", provider: "codex", prompt: "x", response: "y", sessionId: "codex-1" }], preferredProvider: "claude" });
    expect(attachCommand({ worktreePath: "/wt/feat", ...toClaude })).toBe('cd "/wt/feat" && claude --permission-mode auto');
    // A stored session with no recorded provider is treated as Claude's, so it still resumes by id.
    expect(store.resumeTarget({ ...row, agentProvider: undefined })).toEqual({ provider: "claude", sessionId: "claude-session", fresh: false });
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

  test("Cursor resets after repeated observed failures but otherwise resumes natively", async () => {
    const failed: AgentTurn[] = Array.from({ length: 3 }, (_, i) => ({
      id: `a-${i}`, provider: "cursor", prompt: `turn ${i}`, response: "failed", sessionId: "cursor-session", failed: true,
    }));
    await store.followUp({ ...row, agentProvider: "cursor", sessionId: "cursor-session", transcript: failed }, "repair", [], { provider: "cursor" });
    expect(apiFake.agentLaunches.at(-1)!.resume).toBeUndefined();

    await store.followUp({ ...row, agentProvider: "cursor", sessionId: "cursor-session", transcript: failed.slice(0, 2) }, "continue", [], { provider: "cursor" });
    expect(apiFake.agentLaunches.at(-1)!.resume).toBe("cursor-session");
  });

  test("Copy CLI hands the portable transcript to a switched-in model without resuming the old one", async () => {
    // Claude ran here and is (say) maxed out; the card is pinned to Cursor, which has never run here.
    const r: store.Row = { ...row, agentProvider: "claude", sessionId: "claude-session", preferredProvider: "cursor", transcript: prior, worktreePath: "/wt/feat" };
    const cmd = await store.cliCommand(r);
    expect(apiFake.handoffs).toHaveLength(1);
    expect(apiFake.handoffs[0]!.content).toContain("taking over this worktree from Claude");
    // Interactive Cursor session seeded from the transcript file — Claude is never re-invoked.
    expect(cmd).toBe('cd "/wt/feat" && cursor-agent "$(cat "/state/handoff/feat.md")" --force');
  });

  test("Copy CLI resumes natively when the pinned model already ran here (no handoff written)", async () => {
    const r: store.Row = { ...row, agentProvider: "cursor", sessionId: "cursor-session", preferredProvider: "cursor", worktreePath: "/wt/feat" };
    const cmd = await store.cliCommand(r);
    expect(apiFake.handoffs).toHaveLength(0);
    expect(cmd).toBe('cd "/wt/feat" && cursor-agent --resume cursor-session --force');
  });
});

  // Live steps for the other two providers. The transcript layer was always provider-agnostic; only
  // the event mapping was Claude-only, so a Codex or Cursor card showed "working…" and then a result
  // with nothing in between. Both mappings are written against events captured from REAL runs, not
  // guessed — the shapes below are verbatim.
  test("maps Codex item events to steps, including a command's output and exit status", () => {
    expect(codexSteps({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "done" } }))
      .toMatchObject([{ kind: "text", text: "done" }]);
    // A started item is the call (the item's own fields are its input, keyed by the item id); the
    // completed one is its result, carrying the same id.
    expect(codexSteps({ type: "item.started", item: { id: "i1", type: "command_execution", command: "/bin/zsh -lc ls", status: "in_progress" } }))
      .toMatchObject([{ kind: "tool", id: "i1", name: "command_execution", input: { command: "/bin/zsh -lc ls" } }]);
    expect(codexSteps({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" } }))
      .toMatchObject([{ kind: "result", id: "i1", output: "a.txt", isError: false }]);
    expect(codexSteps({ type: "item.completed", item: { type: "command_execution", command: "false", aggregated_output: "", exit_code: 1 } }))
      .toMatchObject([{ kind: "result", output: "exited 1", isError: true }]);
    // An unfamiliar tool still shows up rather than vanishing from the conversation.
    expect(codexSteps({ type: "item.started", item: { type: "web_search", query: "orca" } }))
      .toMatchObject([{ kind: "tool", name: "web_search", input: { query: "orca" } }]);
    expect(codexSteps({ type: "turn.completed", usage: {} })).toEqual([]);
  });

  test("maps Cursor stream events to steps, joining thinking deltas into one block", () => {
    const state = { thinking: "" };
    // Cursor is the one provider that exposes REAL reasoning text — but only in deltas, with a
    // completed event that carries none. Emitting each delta would stutter; they're joined.
    expect(cursorSteps({ type: "thinking", subtype: "delta", text: "Running ls " }, state)).toEqual([]);
    expect(cursorSteps({ type: "thinking", subtype: "delta", text: "to list files" }, state)).toEqual([]);
    expect(cursorSteps({ type: "thinking", subtype: "completed" }, state))
      .toMatchObject([{ kind: "thinking", text: "Running ls to list files" }]);
    expect(state.thinking).toBe(""); // and the buffer resets for the next block

    expect(cursorSteps({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll list the files." }] } }, state))
      .toMatchObject([{ kind: "text", text: "I'll list the files." }]);

    const shell = { shellToolCall: { args: { command: "ls" }, result: { success: { command: "ls", exitCode: 0, stdout: "a.txt\n", stderr: "" } } } };
    expect(cursorSteps({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: shell }, state))
      .toMatchObject([{ kind: "tool", id: "c1", name: "shell", input: { command: "ls" } }]);
    expect(cursorSteps({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: shell }, state))
      .toMatchObject([{ kind: "result", id: "c1", output: "a.txt", isError: false }]);
  });

  test("Cursor's outcome is the last result event of the stream, and the old buffered body still parses", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "c-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "cur-1", duration_ms: 7830, usage: { inputTokens: 4819, outputTokens: 75 } }),
    ].join("\n");
    expect(parseCursorOutput(stream)).toMatchObject({ sessionId: "cur-1", result: "done", isError: false });
    // A single JSON body — the older form, and what a crash may leave behind — still works.
    expect(parseCursorOutput(JSON.stringify({ type: "result", is_error: true, result: "boom", session_id: "cur-2" })))
      .toMatchObject({ sessionId: "cur-2", result: "boom", isError: true });
  });