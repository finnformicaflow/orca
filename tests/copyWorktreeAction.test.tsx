// E2E for the "Copy worktree" item added to the Actions → Agent submenu: it copies the branch's
// worktree path to the clipboard (adopting a worktree first if there isn't one). Copy CLI moved off
// to the card's copy menu (see cardDetails.test.tsx). Driven against the preloaded fake api
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
function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(<WorkstreamActions row={row} />); });
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
});
