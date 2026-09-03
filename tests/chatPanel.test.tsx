// ChatPanel (views/Chat.tsx) renders the branch's durable conversation from GET /api/turns as a
// terminal-style log — the content of the card's terminal modal. Rendered into a real DOM against
// the fake api.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { groupSteps, type AgentStep } from "../shared/agent";
import { toolDetail, toolLabel } from "@/steps";
import { chatPrompt, followUpPrompt, promptInstruction } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });
}
const text = () => container!.textContent ?? "";

const base: Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude",
};

beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
});

test("renders every turn in the branch, not just the most recent", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "add the cache", response: "Added it.", finishedAt: 2 },
    { id: "run-2", provider: "codex", prompt: "now add a test", response: "Test added.", finishedAt: 4 },
  ]);

  await mount(base);

  // The whole point: the earlier exchange is still on screen.
  expect(text()).toContain("add the cache");
  expect(text()).toContain("Added it.");
  expect(text()).toContain("now add a test");
  expect(text()).toContain("Test added.");
  expect(text()).toContain("Codex"); // each turn is attributed to the provider that ran it
});

test("shows a structured outcome as labelled sections", async () => {
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "ship it", response: "## Outcome\nShipped.", finishedAt: 2,
    structured: { outcome: "Shipped.", verification: ["bun run check"], decisions: [], remaining: ["docs"], commits: ["abc123 ship"] },
  }]);

  await mount(base);

  expect(text()).toContain("Shipped.");
  expect(text()).toContain("Remaining");
  expect(text()).toContain("docs");
  expect(text()).toContain("abc123 ship");
});

test("an unfinished turn shows as in-progress instead of vanishing", async () => {
  // Turns are written at LAUNCH, so a run killed by a bridge restart stays visible as an interrupted
  // exchange — the case that used to lose the conversation entirely.
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "long job", response: "" }]);

  await mount({ ...base, agentStatus: "running" });

  expect(text()).toContain("long job");
  expect(text()).toContain("working…");
});

test("a failed turn is kept and surfaced, not dropped", async () => {
  apiFake.turnsData.set("r::feat", [
    { id: "run-1", provider: "claude", prompt: "break it", response: "exit 1", failed: true, finishedAt: 2 },
  ]);

  await mount(base);

  expect(text()).toContain("break it");
  expect(text()).toContain("exit 1");
  expect(text()).toContain("failed");
});

test("an empty conversation says so rather than rendering a blank panel", async () => {
  await mount(base);
  expect(text()).toContain("No history yet");
});

test("the composer sends a follow-up through the normal launch path", async () => {
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "first", response: "done", finishedAt: 2 }]);
  await mount(base);

  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "and now this");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  const send = container!.querySelector<HTMLButtonElement>('button[title="Send (⌘+Enter)"]')!;
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });

  // Same headless one-shot every board action uses — the chat view adds no second runtime.
  expect(apiFake.claudePrompts.at(-1)).toContain("and now this");
});

test("the log shows only what you typed, not the prompt scaffolding wrapped around it", async () => {
  // A chat message is sent as instruction + a block of conversation rules + the outcome contract.
  // All of that is for the agent; in the log it buried the one line you actually wrote.
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", finishedAt: 2, response: "Sure.",
    prompt: chatPrompt("what do you think of the cache?"),
  }]);
  await mount(base);

  expect(text()).toContain("what do you think of the cache?");
  expect(text()).not.toContain("You are replying in a conversation");
  expect(text()).not.toContain("Finish your final response");
});

test("the composer clears as soon as you send, while the launch is still in flight", async () => {
  apiFake.turnsData.set("r::feat", []);
  apiFake.holdClaude = true; // launching an agent takes seconds — the box must not wait for it
  await mount(base);

  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "and now this");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  const send = container!.querySelector<HTMLButtonElement>('button[title="Send (⌘+Enter)"]')!;
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });

  expect(box.value).toBe(""); // cleared although the launch hasn't resolved
  await act(async () => { apiFake.releaseClaude?.(); await flush(); await flush(); });
  expect(apiFake.claudePrompts.at(-1)).toContain("and now this");
});

test("a failed send puts the text back in the box", async () => {
  apiFake.turnsData.set("r::feat", []);
  apiFake.claudeError = "launch exploded";
  await mount(base);

  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "retry me");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  const send = container!.querySelector<HTMLButtonElement>('button[title="Send (⌘+Enter)"]')!;
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });

  expect(box.value).toBe("retry me");
  expect(text()).toContain("launch exploded");
});

test("promptInstruction keeps a plain prompt whole", () => {
  expect(promptInstruction("just this")).toBe("just this");
  expect(promptInstruction(followUpPrompt("fix the flake"))).toBe("fix the flake");
});

test("a tool's output stays inside its own accordion instead of spilling into the log", async () => {
  // The bug: results were recorded as their own steps, so the collapsed call held only the command
  // while its (much longer) output rendered unconditionally underneath — "all collapsed, but the
  // majority of the text is just there". groupSteps folds the result into the call it belongs to.
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "run the tests", response: "Done.", finishedAt: 2,
    steps: [
      { at: 1, kind: "text", text: "Running the suite now." },
      { at: 2, kind: "tool", id: "tu_1", name: "Bash", input: { command: "bun test" } },
      { at: 3, kind: "result", id: "tu_1", output: "SECRET_TOOL_OUTPUT 289 pass" },
    ],
  }]);

  await mount(base);

  expect(text()).toContain("Running the suite now."); // narration is the readable thread — visible
  expect(text()).toContain("Running: bun test");      // the call's label, derived from its input — visible
  expect(text()).not.toContain("SECRET_TOOL_OUTPUT"); // its output — behind the toggle
  expect(text()).not.toContain("Tool result");        // and NOT a second row of its own

  // Opening that one call reveals the command AND its output together.
  const toggle = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Running: bun test"));
  await act(async () => { toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(text()).toContain("SECRET_TOOL_OUTPUT 289 pass");
});

test("a tool call on a live run is open while it works and folds itself when its result lands", async () => {
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "run the tests", response: "",
    steps: [{ at: 2, kind: "tool", id: "tu_1", name: "Bash", input: { command: "bun test" } }],
  }]);
  await mount({ ...base, agentStatus: "running" });
  // In flight: the input is what there is to watch, so it's open without a click.
  expect(text()).toContain("Running: bun test…");
  expect(container!.querySelector("pre")?.textContent).toBe("bun test");
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  await act(async () => {
    stream.dispatchEvent(Object.assign(new Event("step"), {
      data: JSON.stringify({ runId: "run-1", steps: [{ at: 3, kind: "result", id: "tu_1", output: "SECRET_TOOL_OUTPUT 289 pass" }] }),
    }));
    await flush();
  });
  // Done: it collapses on its own, output tucked behind the toggle like any finished call.
  expect(text()).not.toContain("Running: bun test…");
  expect(text()).not.toContain("SECRET_TOOL_OUTPUT");
});

test("a finished turn does not repeat its final message as the last step", async () => {
  // The model's last text IS the response Output renders; showing it in the steps too doubled it.
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "run the tests", response: "All 289 tests pass.", finishedAt: 2,
    steps: [{ at: 1, kind: "text", text: "Running the suite now." }, { at: 2, kind: "text", text: "All 289 tests pass." }],
  }]);
  await mount(base);
  expect(text().split("All 289 tests pass.")).toHaveLength(2); // exactly once
  expect(text()).toContain("Running the suite now.");
});

test("the log shows the recorded instruction when the turn has one, whatever the prompt looks like", async () => {
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", finishedAt: 2, response: "On it.",
    instruction: "Fix the failing CI checks", prompt: "Some prompt shape the marker list has never seen.\n\nFinish your final response with these concise sections:",
  }]);
  await mount(base);
  expect(text()).toContain("Fix the failing CI checks");
  expect(text()).not.toContain("Some prompt shape");
});

test("groupSteps pairs results with calls by id, by order when there is none, and keeps an orphan visible", () => {
  // Parallel calls can come back in any order; the id says which is which.
  const grouped = groupSteps([
    { at: 1, kind: "tool", id: "a", name: "Read", input: { file_path: "a.ts" } },
    { at: 1, kind: "tool", id: "b", name: "Read", input: { file_path: "b.ts" } },
    { at: 2, kind: "result", id: "b", output: "contents of b", isError: true },
    { at: 2, kind: "result", id: "a", output: "contents of a" },
  ]);
  expect(grouped).toHaveLength(2); // two calls, no free-floating result rows
  expect(grouped[0]).toMatchObject({ id: "a", output: "contents of a", done: true });
  expect(grouped[1]).toMatchObject({ id: "b", output: "contents of b", isError: true, done: true });

  // Rows written before ids (and before `kind: "result"`) still pair positionally.
  const legacy = groupSteps([
    { at: 1, kind: "tool", name: "Read", text: "Reading a.ts" },
    { at: 2, kind: "tool", name: "result", output: "contents of a" },
  ]);
  expect(legacy).toMatchObject([{ text: "Reading a.ts", output: "contents of a", done: true }]);

  // A result with no call to match (a transcript read mid-run) is kept, with a label so it is still
  // collapsible rather than rendering bare.
  expect(groupSteps([{ at: 1, kind: "result", id: "zzz", output: "orphan" }]))
    .toMatchObject([{ text: "Tool result", output: "orphan" }]);

  // Pure: the caller's steps are not mutated (the panel re-groups on every render).
  const input: AgentStep[] = [{ at: 1, kind: "tool", id: "x", name: "Bash", input: {} }, { at: 2, kind: "result", id: "x", output: "out" }];
  groupSteps(input);
  expect(input[0]!.output).toBeUndefined();
  expect(input[0]!.done).toBeUndefined();
});

test("a tool's label and detail come from its stored input, not from the row", () => {
  expect(toolLabel({ at: 1, kind: "tool", name: "Bash", input: { command: "bun   test" } })).toBe("Running: bun test");
  expect(toolLabel({ at: 1, kind: "tool", name: "Edit", input: { file_path: "/wt/x/src/foo.ts", old_string: "a", new_string: "b" } })).toBe("Editing foo.ts");
  expect(toolLabel({ at: 1, kind: "tool", name: "command_execution", input: { command: "ls" } })).toBe("Running: ls"); // codex
  expect(toolLabel({ at: 1, kind: "tool", name: "shell", input: { command: "ls" } })).toBe("Running: ls"); // cursor
  expect(toolLabel({ at: 1, kind: "tool", name: "mcp__slack__post", input: { channel: "#eng" } })).toBe("Using mcp__slack__post");
  expect(toolLabel({ at: 1, kind: "tool", name: "Bash", text: "Running: old row" })).toBe("Running: old row"); // legacy
  // Detail: a lone command reads bare; a richer input shows everything the row kept.
  expect(toolDetail({ at: 1, kind: "tool", name: "Bash", input: { command: "bun test" } })).toBe("bun test");
  expect(toolDetail({ at: 1, kind: "tool", name: "Edit", input: { file_path: "f", old_string: "a", new_string: "b" } })).toContain('"new_string": "b"');
  expect(toolDetail({ at: 1, kind: "tool", name: "Bash", detail: "old detail" })).toBe("old detail"); // legacy
});

test("the log follows new output, but not while the reader has scrolled up", async () => {
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "go", startedAt: 1 }]);
  await mount(base);

  const log = container!.querySelector("div.overflow-y-auto") as HTMLElement;
  // happy-dom doesn't lay out, so drive the geometry the scroll handler reads.
  Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(log, "clientHeight", { value: 200, configurable: true });
  const scrolled: number[] = [];
  log.scrollTo = ((opts: { top: number }) => scrolled.push(opts.top)) as unknown as typeof log.scrollTo;

  // A step pushed down the live stream is what appends output to the log.
  const stream = (globalThis as unknown as { EventSource: { opened: EventTarget[] } }).EventSource.opened.at(-1)!;
  const push = async (text: string) => {
    await act(async () => {
      stream.dispatchEvent(Object.assign(new Event("step"), {
        data: JSON.stringify({ runId: "run-1", steps: [{ at: 1, kind: "text", text }] }),
      }));
      await flush();
    });
  };

  // Reader scrolls up to read something → following stops, so incoming steps don't yank them away.
  log.scrollTop = 200;
  await act(async () => { log.dispatchEvent(new Event("scroll")); });
  await push("while scrolled up");
  expect(text()).toContain("while scrolled up"); // still rendered — just not scrolled to
  expect(scrolled).toHaveLength(0);

  // Back at the bottom → following resumes and the next arrival scrolls again.
  log.scrollTop = 800; // 1000 - 200: pinned to the bottom
  await act(async () => { log.dispatchEvent(new Event("scroll")); });
  await push("back at the bottom");
  expect(scrolled).toEqual([1000]);
});

test("an instruction held mid-run shows as queued, and can be cancelled", async () => {
  // Before this, the composer invited "queue the next instruction" and the bridge answered 409 — the
  // message just vanished. It's now visibly waiting, and revocable while it still is.
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "big refactor", startedAt: 1 }]);
  apiFake.queuedData.set("feat", [
    { id: 7, repo: "r", branch: "feat", instruction: "also update the docs", attachments: [], createdAt: 2 },
  ]);

  await mount({ ...base, agentStatus: "running" });

  expect(text()).toContain("also update the docs");
  expect(text()).toContain("sends when the current run finishes"); // not silently pending

  const cancel = [...container!.querySelectorAll("button")].find((b) => b.textContent === "cancel");
  await act(async () => { cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(text()).not.toContain("also update the docs");
});

test("a slow attachment save can't resurrect the message you already sent", async () => {
  // Attachments persist as data URLs via FileReader, so a save started when the file was attached
  // can still be in flight when you hit send. It used to land AFTER the clear, rewriting the draft —
  // so reopening the modal put the sent message (and its file) back in the box.
  apiFake.turnsData.set("r::feat", []);
  await mount(base);

  const box = container!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "here is the spec");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["PK"], "spec.docx", { type: "application/octet-stream" })] } });
  await act(async () => { container!.querySelector("textarea")!.parentElement!.dispatchEvent(drop); });

  // Send WITHOUT waiting for the attachment's save to settle — the race.
  const send = container!.querySelector<HTMLButtonElement>('button[title="Send (⌘+Enter)"]')!;
  await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await flush(); await flush(); await flush(); });

  expect(box.value).toBe("");
  expect(localStorage.getItem("orca.chat.r::feat")).toBeNull(); // nothing left to reopen with
});
