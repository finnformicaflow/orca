// The card's terminal is a modal showing the branch's conversation (durable turns) with the
// follow-up composer — not a live shell. The old detail-page Chat tab is gone; this is now the one
// place the conversation lives. Rendered into a real DOM against the fake api (tests/apiFake.ts).
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
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

const row: store.Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "do a thing", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude", sessionId: "claude-abc",
};

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

describe("card terminal (conversation modal)", () => {
  test("the terminal button opens a modal showing the branch's conversation", async () => {
    apiFake.turnsData.set("r::feat", [
      { id: "run-1", provider: "claude", prompt: "add the cache", response: "Added it.", finishedAt: 2 },
    ]);
    await mount(<WorkstreamCard row={row} />);

    // The card has more than one <dialog> now (terminal + rename) — pick the terminal one by its header.
    const dialog = [...container!.querySelectorAll("dialog")].find((d) => /Terminal/.test(d.textContent ?? ""))!;
    expect(dialog.open).toBe(false); // closed until opened — ChatPanel isn't mounted yet
    // The <dialog> must carry NO display utility, or an author `display` rule overrides the UA
    // `dialog:not([open]){display:none}` and the closed dialog renders inline in the swimlane,
    // wrecking the card layout. Layout lives on an inner wrapper instead.
    for (const cls of ["flex", "grid", "block", "inline-flex", "inline-block", "table"]) {
      expect(dialog.classList.contains(cls)).toBe(false);
    }

    const button = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Open terminal")!;
    expect(button).toBeTruthy();
    await click(button);

    expect(dialog.open).toBe(true);
    // The durable conversation renders inside — the whole point of the rework.
    expect(dialog.textContent).toContain("add the cache");
    expect(dialog.textContent).toContain("Added it.");
    // And a composer to send the next message (the reused follow-up component).
    expect(dialog.querySelector("textarea")).toBeTruthy();
  });

  test("the New-draft chatbox carries no interactive terminal toggle", async () => {
    await mount(<Board />);
    const toggle = [...document.body.querySelectorAll("button")].find((b) => /Headless|drive it by hand/.test(b.getAttribute("title") ?? ""));
    expect(toggle).toBeUndefined();
  });

  test("the detail views no longer route a Chat tab (it lives in the terminal now)", () => {
    const prTabs: PrTab[] = ["overview", "files", "checks", "preview"];
    const localTabs: LocalTab[] = ["overview", "files", "preview"];
    expect(prTabs).not.toContain("chat" as PrTab);
    expect(localTabs).not.toContain("chat" as LocalTab);
  });
});
