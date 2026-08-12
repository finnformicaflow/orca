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

test("a tool's output stays inside its own accordion instead of spilling into the log", async () => {
  // The bug: results were recorded as their own steps, so the collapsed call held only the command
  // while its (much longer) output rendered unconditionally underneath — "all collapsed, but the
  // majority of the text is just there". groupSteps folds the result into the call it belongs to.
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "run the tests", response: "Done.", finishedAt: 2,
    steps: [
      { at: 1, kind: "text", text: "Running the suite now." },
      { at: 2, kind: "tool", name: "Bash", text: "Running: bun test", detail: "bun test" },
      { at: 3, kind: "tool", name: "result", output: "SECRET_TOOL_OUTPUT 289 pass" },
    ],
  }]);

  await mount(base);

  expect(text()).toContain("Running the suite now."); // narration is the readable thread — visible
  expect(text()).toContain("Running: bun test");      // the call's summary line — visible
  expect(text()).not.toContain("SECRET_TOOL_OUTPUT"); // its output — behind the toggle
  expect(text()).not.toContain("Tool result");        // and NOT a second row of its own

  // Opening that one call reveals the command AND its output together.
  const toggle = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Running: bun test"));
  await act(async () => { toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(text()).toContain("SECRET_TOOL_OUTPUT 289 pass");
});

test("groupSteps pairs parallel calls with their results in order, and keeps an orphan visible", () => {
  // Claude emits several tool_use blocks in one event and their results in a later one, so matching
  // is positional: first call ↔ first result.
  const grouped = groupSteps([
    { at: 1, kind: "tool", name: "Read", text: "Reading a.ts" },
    { at: 1, kind: "tool", name: "Read", text: "Reading b.ts" },
    { at: 2, kind: "tool", name: "result", output: "contents of a" },
    { at: 2, kind: "tool", name: "result", output: "contents of b", isError: true },
  ]);
  expect(grouped).toHaveLength(2); // two calls, no free-floating result rows
  expect(grouped[0]).toMatchObject({ text: "Reading a.ts", output: "contents of a" });
  expect(grouped[1]).toMatchObject({ text: "Reading b.ts", output: "contents of b", isError: true });

  // A result with no call to match (a transcript read mid-run) is kept, with a label so it is still
  // collapsible rather than rendering bare.
  expect(groupSteps([{ at: 1, kind: "tool", name: "result", output: "orphan" }]))
    .toMatchObject([{ text: "Tool result", output: "orphan" }]);

  // Pure: the caller's steps are not mutated (the panel re-groups on every render).
  const input: AgentStep[] = [{ at: 1, kind: "tool", name: "Bash", text: "Running: x" }, { at: 2, kind: "tool", name: "result", output: "out" }];
  groupSteps(input);
  expect(input[0]!.output).toBeUndefined();
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
