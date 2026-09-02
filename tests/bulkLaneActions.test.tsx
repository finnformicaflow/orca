// E2E for the swimlane ⋯ bulk-actions menu: one action applied to every card in a lane that can take
// it. The menu is state-gated (workstream.bulkActions) — items only appear when some card is eligible
// and each says how many it will hit — and running one fires the SAME per-card action per card.
// Driven against the fake api (tests/apiFake.ts), rendered into a real DOM. See Board.LaneActions.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Board } from "@/views/Board";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
// Radix opens menus on pointerdown, not click — drive it the way a pointer would.
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

const pr = (over: Record<string, unknown>) => ({
  number: 7, title: "feat", branch: "feat-x", url: "https://x/7", state: "OPEN", isDraft: false,
  ciStatus: "passing", reviewStatus: "commented", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
});

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Board />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); });
}

const confirmed: string[] = [];
window.confirm = (message?: string) => { confirmed.push(String(message)); return true; };
// Copy verbs are aggregate (one clipboard write per lane, not per card) — capture what they write.
const copied: string[] = [];
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  confirmed.length = 0;
  copied.length = 0;
  localStorage.clear();
});

// The lane header's ⋯ trigger, by lane title.
const laneMenu = (title: string) =>
  [...container!.querySelectorAll("h3")].find((h) => h.textContent?.startsWith(title))!.querySelector<HTMLElement>('button[aria-label="Bulk actions"]');
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) => i.textContent?.trim());
const item = (text: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim().startsWith(text))!;

// A submenu trigger, drilled into the way a pointer would (Radix opens on pointerdown, then click).
const openSub = async (label: string) => { const t = item(label); await pointerdown(t); await click(t); };

describe("swimlane bulk actions", () => {
  test("In Review groups the verbs (Slack / PR / Agent) and each item carries only the eligible cards", async () => {
    apiFake.prsData = [pr({}), pr({ number: 8, branch: "feat-y", title: "feat y", url: "https://x/8", ciStatus: "failing" })];
    // #8 was announced long ago and never bumped → it needs a bump, #7 has never been announced.
    // Seed through the bridge store (enrichment lives in the DB since #50, not localStorage); mount()
    // runs store.refresh(), which hydrates the mirror from it.
    apiFake.enrichmentData.set("r::feat-y", { slackNotifiedAt: "2020-01-01T00:00:00Z" });
    await mount();
    await pointerdown(laneMenu("In Review")!);
    // Grouped verbs collapse into their submenu; the lane-shaping ones (Merge, Close PR) stay flat.
    expect(items()).toEqual(["Slack", "PR", "Agent", "Merge 1", "Close PR 2"]);

    await openSub("Slack");
    expect(items().slice(5)).toEqual(["Send message 1", "Send bump 1"]); // counts: eligible cards per action
    await click(item("Send message"));
    expect(confirmed).toEqual(["Send message on 1 card in in review?"]);
    expect(apiFake.slackSends).toEqual([{ repo: "r", text: "<https://x/7|#7 feat>" }]); // only the un-announced PR
  });

  test("the PR submenu runs a PR verb across the lane, and Copy PR links is one aggregate copy", async () => {
    apiFake.prsData = [pr({}), pr({ number: 8, branch: "feat-y", title: "feat y", url: "https://x/8" })];
    await mount();
    await pointerdown(laneMenu("In Review")!);
    await openSub("PR");
    await click(item("Add preview"));
    expect(confirmed).toEqual(["Add preview on 2 cards in in review?"]);
    expect(apiFake.calls.filter((c) => c.startsWith("addPreviewLabel:"))).toEqual(["addPreviewLabel:7", "addPreviewLabel:8"]);

    await pointerdown(laneMenu("In Review")!);
    await openSub("PR");
    await click(item("Copy PR links"));
    expect(copied).toEqual(["https://x/7\nhttps://x/8"]); // no confirm — nothing is mutated
    expect(confirmed).toHaveLength(1);
  });

  test("Address review fires the agent on every open PR (not only changes-requested ones)", async () => {
    apiFake.prsData = [pr({}), pr({ number: 8, branch: "feat-y", title: "feat y", url: "https://x/8" })];
    await mount();
    await pointerdown(laneMenu("In Review")!);
    await openSub("Agent");
    await click(item("Address review"));
    expect(apiFake.agentLaunches).toHaveLength(2);
  });

  test("Mergeable's Merge runs the per-card merge on every approved PR, behind an it-can't-be-undone confirm", async () => {
    apiFake.prsData = [pr({ reviewStatus: "approved" }), pr({ number: 8, branch: "feat-y", reviewStatus: "approved" })];
    await mount();
    await pointerdown(laneMenu("Mergeable")!);
    await click(item("Merge"));
    expect(confirmed).toEqual(["Merge on 2 cards in mergeable? This can't be undone."]);
    expect(apiFake.calls.filter((c) => c.startsWith("merge:"))).toEqual(["merge:7", "merge:8"]);
  });
});
