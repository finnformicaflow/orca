// "New chat": start a conversation without a task. The worktree is cut in the background (so the
// first message has a cwd + branch to record turns against), no agent is launched, and the new
// card's terminal opens on its own so you can type the first message straight away — the way a
// blank chat works in Claude Code web. Against the fake api (tests/apiFake.ts), rendered into a DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Board } from "@/views/Board";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("new chat", () => {
  test("creates a worktree with no task, launches nothing, and opens the card's terminal", async () => {
    await mount(<Board />);
    const button = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "New chat")!;
    expect(button).toBeTruthy();
    // It takes the attach button's slot beside send, so the repo/provider dropdowns aren't squeezed.
    expect(container!.querySelector('button[title="Attach files"]')).toBeNull();
    expect(button.nextElementSibling?.getAttribute("title")).toContain("Send");
    await click(button);

    // The worktree is being created; the button waits rather than double-firing.
    expect(apiFake.pending).not.toBeNull();
    expect(button.disabled).toBe(true);
    await act(async () => { apiFake.pending!({ branch: "new-chat-ab12", worktreePath: "/wt/new-chat-ab12", title: "New chat" }); apiFake.pending = null; await flush(); await flush(); await flush(); });

    // No run was fired — the first message will come from the terminal's composer.
    expect(apiFake.agentLaunches).toHaveLength(0);
    // The card landed, and its terminal is already open with the composer ready.
    const dialog = [...container!.querySelectorAll("dialog")].find((d) => /Terminal · New chat/.test(d.textContent ?? ""))!;
    expect(dialog).toBeTruthy();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("textarea")).toBeTruthy();
    expect(button.disabled).toBe(false);

    // The first message is an ordinary chat turn: no "taking over from the transcript" handoff
    // header over an empty history, just the message with the chat scaffolding.
    const row: store.Row = { repo: "r", hasRemote: false, branch: "new-chat-ab12", title: "New chat", prompt: "", lane: "LOCAL", worktreePath: "/wt/new-chat-ab12", agentProvider: "claude" };
    await act(async () => { await store.followUp(row, "what does the auth module do?"); await flush(); });
    expect(apiFake.agentLaunches).toHaveLength(1);
    expect(apiFake.agentLaunches[0]!.handoffFrom).toBeUndefined();
    expect(apiFake.agentLaunches[0]!.prompt).toContain("what does the auth module do?");
    expect(apiFake.agentLaunches[0]!.prompt).not.toContain("portable conversation transcript");
  });
});
