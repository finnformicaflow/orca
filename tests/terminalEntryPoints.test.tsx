// The hand-driven terminal's UI entry points were removed pending a rework: no "Open terminal" on
// the card (neither the button beside Test locally nor the Agent-menu item), and no Terminal tab in
// the detail views. The tmux/WebSocket backend and Terminal.tsx are deliberately kept — only the
// ways in are gone — so this asserts their absence. Driven against the fake api (tests/apiFake.ts).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Board, WorkstreamCard } from "@/views/Board";
import type { PrTab, LocalTab } from "@/lib/route";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));

const row: store.Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "do a thing", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude", sessionId: "claude-abc",
};

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); });
}

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("terminal entry points removed", () => {
  test("the card has no Open terminal button and no terminal dialog", async () => {
    await mount(<WorkstreamCard row={row} />);
    const openBtn = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Open terminal");
    expect(openBtn).toBeUndefined();
    expect(container!.querySelector("dialog")).toBeNull(); // the modal terminal is gone
    // Nothing on the card ensures a session any more — no way to open a terminal.
    expect(apiFake.terminalEnsures).toHaveLength(0);
  });

  test("the New-draft chatbox carries no interactive terminal toggle", async () => {
    await mount(<Board />);
    const toggle = [...document.body.querySelectorAll("button")].find((b) => /Headless|drive it by hand/.test(b.getAttribute("title") ?? ""));
    expect(toggle).toBeUndefined();
  });

  test("neither detail view still routes a Terminal tab", () => {
    // The tab was reachable at /…/terminal; that value is no longer part of the tab unions, so a stale
    // bookmark can't resolve to a Terminal tab.
    const prTabs: PrTab[] = ["overview", "chat", "files", "checks", "preview"];
    const localTabs: LocalTab[] = ["overview", "chat", "files", "preview"];
    expect(prTabs).not.toContain("terminal" as PrTab);
    expect(localTabs).not.toContain("terminal" as LocalTab);
  });
});
