// "New chat": a conversation, not a task. The button opens a composer INSTANTLY (nothing is created
// yet); submitting paints the optimistic card and, in the background, cuts the worktree and fires the
// first message through the chat path (chatPrompt, not the launch work-order). The card's terminal
// opens by itself once its branch exists. Against the fake api (tests/apiFake.ts) in a real DOM.
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
  if (apiFake.pending) { const p = apiFake.pending; apiFake.pending = null; await act(async () => { p({ branch: "drain", worktreePath: "/x", title: "x" }); await flush(); await flush(); }); }
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("new chat", () => {
  test("opens a composer instantly, then creates the card + worktree optimistically on submit", async () => {
    await mount(<Board />);
    const button = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "New chat")!;
    expect(button).toBeTruthy();
    // It takes the attach button's slot beside send, so the repo/provider dropdowns aren't squeezed.
    expect(container!.querySelector('button[title="Attach files"]')).toBeNull();

    await click(button);
    // Instant: a composer is up and NOTHING has been created yet.
    const dialog = [...container!.querySelectorAll("dialog")].find((d) => /New chat ·/.test(d.textContent ?? ""))!;
    expect(dialog.open).toBe(true);
    expect(apiFake.pending).toBeNull();
    expect(apiFake.titleProviders).toHaveLength(0);

    const box = dialog.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "what does the auth module do?");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await click(dialog.querySelector('button[title="Send (⌘+Enter)"]')!);

    // Submitted: the dialog closes, the optimistic card is on the board while the worktree is cut.
    expect(dialog.open).toBe(false);
    expect(apiFake.pending).not.toBeNull();
    expect(container!.textContent).toContain("what does the auth module do?");

    await act(async () => { apiFake.pending!({ branch: "auth-module-ab12", worktreePath: "/wt/auth-module-ab12", title: "Auth module" }); apiFake.pending = null; await flush(); await flush(); await flush(); });

    // The first message went through the chat path: no work-order scaffolding, no handoff header.
    expect(apiFake.agentLaunches).toHaveLength(1);
    expect(apiFake.agentLaunches[0]!.prompt).toContain("what does the auth module do?");
    expect(apiFake.agentLaunches[0]!.prompt).toContain("You are replying in a conversation");
    expect(apiFake.agentLaunches[0]!.prompt).not.toContain("portable conversation transcript");
    // And the new card's terminal opened on its own.
    const terminal = [...container!.querySelectorAll("dialog")].find((d) => /Terminal · Auth module/.test(d.textContent ?? ""))!;
    expect(terminal).toBeTruthy();
    expect(terminal.open).toBe(true);
  });
});
