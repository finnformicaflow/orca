// E2E for the copy shortcuts in Actions → Agent: Copy worktree copies the branch path, while Copy
// CLI copies the active provider's resumable command. Copy CLI also remains in the card's top-right
// copy menu (see cardDetails.test.tsx). Driven against the preloaded fake api
// (tests/apiFake.ts) and rendered into a real DOM. See WorkstreamActions.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { WorkstreamActions } from "@/views/WorkstreamActions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
// Radix opens menus/submenus on pointerdown, not click — drive it the way a pointer would.
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

let copied = "";
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
});

// A local branch that already has a worktree, so ensureWorktree returns its path without a round-trip.
const row: store.Row = { repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat" };

let root: Root | undefined;
let container: HTMLElement | undefined;
function mount(workstream: store.Row = row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(<WorkstreamActions row={workstream} />); });
}

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  copied = "";
});

const menuitem = (text: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === text);

describe("Copy worktree action", () => {
  test("Actions → Agent → Copy worktree copies the worktree path", async () => {
    mount();
    await pointerdown([...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"))!);
    // Open the Agent submenu, then click Copy worktree.
    const agentTrigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Agent")!;
    await pointerdown(agentTrigger);
    await click(agentTrigger);
    const item = menuitem("Copy worktree")!;
    expect(item).not.toBeNull();
    await click(item);
    expect(copied).toBe("/wt/feat");
  });

  test("Actions → Agent → Copy CLI copies the exact Codex resume command", async () => {
    mount({ ...row, agentProvider: "codex", sessionId: "codex-123" });
    await pointerdown([...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"))!);
    const agentTrigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Agent")!;
    await pointerdown(agentTrigger);
    await click(agentTrigger);
    const item = menuitem("Copy CLI")!;
    expect(item).not.toBeNull();
    await click(item);
    expect(copied).toBe('cd "/wt/feat" && codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox codex-123');
  });

  const openSlackItem = async (label: string) => {
    await pointerdown([...container!.querySelectorAll("button")].find((button) => button.textContent?.includes("Actions"))!);
    const slackTrigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Slack")!;
    await pointerdown(slackTrigger);
    await click(slackTrigger);
    const item = menuitem(label)!;
    expect(item).not.toBeNull();
    await click(item);
  };
  const pr = { ...row, hasRemote: true, lane: "IN_REVIEW" as const, prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" };

  test("Slack action lives only in Actions → Slack, not as a card button, and copies when no webhook", async () => {
    apiFake.slackWebhook = false; // no webhook → server reports posted:false → clipboard fallback
    mount(pr);
    expect([...container!.querySelectorAll("button")].some((button) => button.textContent?.includes("Copy Slack"))).toBe(false);
    await openSlackItem("Copy message");
    // No ClipboardItem in the test DOM → the plain-text fallback: title + URL, NOT the Markdown link
    // that pasted literally into Slack. (The rich text/html flavour is unit-tested via slackClipboard.)
    expect(copied).toBe("#7 Feat\nhttps://github.com/acme/app/pull/7");
  });

  test("Slack notify auto-sends the mrkdwn message via the webhook without touching the clipboard", async () => {
    apiFake.slackWebhook = true; // a webhook is configured → server posts, no copy
    mount(pr);
    await openSlackItem("Copy message"); // label stays "Copy" here (config cached webhook-off); behavior sends
    expect(apiFake.slackSends).toEqual([{ repo: "r", text: "<https://github.com/acme/app/pull/7|#7 Feat>" }]);
    expect(copied).toBe(""); // posted → clipboard untouched
  });
});
