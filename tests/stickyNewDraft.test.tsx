// E2E for the sticky new-draft box: with many Local sessions the column scrolls, but the chat input
// that starts a new session must stay pinned to the top so it's always reachable — no scrolling back
// up to type. We render the whole Board and assert the new-draft composer sits inside a `sticky`
// wrapper at the top of the (scrolling) Local column. See Board.tsx (the LOCAL lane).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as store from "@/store";
import { Board } from "@/views/Board";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Board />); await flush(); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("sticky new-draft box", () => {
  test("the new-draft composer is pinned in a sticky wrapper at the top of the Local column", async () => {
    await mount();
    // The composer is identified by its textarea placeholder.
    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Describe a feature"]');
    expect(textarea).not.toBeNull();
    // Walk up to the sticky wrapper that keeps it reachable while the column scrolls.
    const sticky = textarea!.closest(".sticky");
    expect(sticky).not.toBeNull();
    expect(sticky!.className).toContain("top-0"); // pinned to the top of the scroll container
    // A solid (opaque) backdrop, so cards scroll *under* the bar instead of showing through it.
    expect(sticky!.className).toMatch(/\bbg-background\b/);
  });
});
