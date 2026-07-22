// The Chat tab (views/Chat.tsx) renders the branch's durable conversation from GET /api/turns.
// Before it, turns were recorded and never displayed anywhere: the detail view showed only the
// LATEST run's prompt and final blob, so every earlier exchange in a branch was invisible. Rendered
// into a real DOM against the fake api.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";

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

  // The whole point of the tab: the earlier exchange is still on screen.
  expect(text()).toContain("add the cache");
  expect(text()).toContain("Added it.");
  expect(text()).toContain("now add a test");
  expect(text()).toContain("Test added.");
  expect(text()).toContain("Codex"); // each turn is attributed to the provider that ran it
});

test("shows a structured outcome as its sections rather than the raw blob", async () => {
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
  expect(text()).toContain("Working…");
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
  expect(text()).toContain("No turns yet");
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
