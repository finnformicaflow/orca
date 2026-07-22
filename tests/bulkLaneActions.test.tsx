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

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  confirmed.length = 0;
  localStorage.clear();
});

// The lane header's ⋯ trigger, by lane title.
const laneMenu = (title: string) =>
  [...container!.querySelectorAll("h3")].find((h) => h.textContent?.startsWith(title))!.querySelector<HTMLElement>('button[aria-label="Bulk actions"]');
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) => i.textContent?.trim());
const item = (text: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim().startsWith(text))!;

describe("swimlane bulk actions", () => {
  test("In Review groups Slack into a submenu split by what each PR needs, and Fix CI only for the failing one", async () => {
    apiFake.prsData = [pr({}), pr({ number: 8, branch: "feat-y", title: "feat y", url: "https://x/8", ciStatus: "failing" })];
    // #8 was announced two days ago and never bumped → it needs a bump, #7 has never been announced.
    localStorage.setItem("orca.enrichment", JSON.stringify({ "r::feat-y": { slackNotifiedAt: "2020-01-01T00:00:00Z" } }));
    window.dispatchEvent(new StorageEvent("storage", { key: "orca.enrichment" })); // the store caches enrichment in memory
    await mount();
    await pointerdown(laneMenu("In Review")!);
    expect(items()).toEqual(["Slack", "Auto-merge 2", "Fix CI 1"]); // counts: eligible cards per action

    const slack = item("Slack");
    await pointerdown(slack);
    await click(slack);
    expect(items()).toEqual(["Slack", "Auto-merge 2", "Fix CI 1", "Send message 1", "Send bump 1"]);

    await click(item("Send message"));
    expect(confirmed).toEqual(["Send message on 1 card in in review?"]);
    expect(apiFake.slackSends).toEqual([{ repo: "r", text: "<https://x/7|#7 feat>" }]); // only the un-announced PR
  });

  test("Mergeable's Merge runs the per-card merge on every approved PR; Done has no menu", async () => {
    apiFake.prsData = [pr({ reviewStatus: "approved" }), pr({ number: 8, branch: "feat-y", reviewStatus: "approved" })];
    await mount();
    await pointerdown(laneMenu("Mergeable")!);
    await click(item("Merge"));
    expect(apiFake.calls.filter((c) => c.startsWith("merge:"))).toEqual(["merge:7", "merge:8"]);
    expect(laneMenu("Done")).toBeNull(); // nothing left to do on merged work
  });
});
