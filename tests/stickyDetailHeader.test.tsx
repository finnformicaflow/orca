// E2E for the sticky worktree-detail header: a long diff scrolls the page, so "Back to board", the
// title and the tab bar must stay pinned instead of scrolling away — and each file's accordion
// header must stay visible (just below that page header) while you read its hunks. We render the
// real LocalDetail on the Files tab and assert the sticky wrappers + the --stick offset that keeps
// the file header from sliding under the page header. See LocalDetail.tsx and DiffView (PrDetail.tsx).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { LocalDetail } from "@/views/LocalDetail";
import { PrDetail } from "@/views/PrDetail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));

const DIFF = `diff --git a/web/src/App.tsx b/web/src/App.tsx
+++ b/web/src/App.tsx
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode = <LocalDetail repo="r" branch="sticky-1" sub="files" />) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(node);
    await flush(); await flush(); await flush();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
});

describe("sticky worktree-detail header", () => {
  test("back/title/tabs are pinned, and each file's diff header sticks below them", async () => {
    apiFake.worktrees.set("sticky-1", { branch: "sticky-1", worktreePath: "/wt/sticky-1" });
    apiFake.diffText = DIFF;
    await store.refresh();
    await mount();

    // Back button, title and the tab bar all live inside ONE sticky, opaque, full-bleed wrapper.
    const back = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Back to board"));
    expect(back).toBeDefined();
    const sticky = back!.closest(".sticky");
    expect(sticky).not.toBeNull();
    expect(sticky!.className).toMatch(/\btop-0\b/);
    expect(sticky!.className).toMatch(/\bbg-background\b/);
    expect(sticky!.className).toMatch(/-mx-4/); // covers the page padding, so nothing peeks past it
    expect(sticky!.textContent).toContain("sticky-1");
    expect(sticky!.querySelector('[role="tablist"]')).not.toBeNull();
    // The pinned header publishes its height so the diff headers can park below it.
    expect(container!.querySelector<HTMLElement>("[style*='--stick']")).not.toBeNull();

    // The file's accordion header sticks (on Radix's h3 wrapper — the trigger can't move inside it)
    // at that offset, and no clipping ancestor kills it.
    const trigger = container!.querySelector<HTMLElement>("[data-slot=accordion-trigger]");
    expect(trigger?.textContent).toContain("web/src/App.tsx");
    const item = trigger!.closest("[data-slot=accordion-item]")!;
    expect(item.className).toContain("[&>h3]:sticky");
    expect(item.className).toContain("var(--stick");
    expect(item.className).not.toContain("overflow-hidden");

    // While stuck, its rounded top corners would let the code underneath peek through — the header
    // is a scroll-state container and the stylesheet squares the radius off for exactly that state.
    expect(item.className).toContain("container-type:scroll-state");
    const css = await Bun.file(new URL("../web/src/styles.css", import.meta.url)).text();
    expect(css.replace(/\s+/g, " ")).toContain("@container scroll-state(stuck: top) { [data-slot=\"accordion-trigger\"] { border-radius: 0; }");
  });

  // Collapsing a file you'd scrolled deep into used to delete that height from above the viewport,
  // lurching the page upward past the files below it. The header must stay put on screen instead.
  test("collapsing a file keeps its header at the same screen position", async () => {
    apiFake.worktrees.set("sticky-1", { branch: "sticky-1", worktreePath: "/wt/sticky-1" });
    apiFake.diffText = DIFF;
    await store.refresh();
    await mount();

    const trigger = container!.querySelector<HTMLElement>("[data-slot=accordion-trigger]")!;
    // happy-dom has no layout engine, so script the two measurements the handler takes: stuck just
    // below the page header, then (once the diff collapsed) far above the viewport.
    const tops = [64, -1800];
    trigger.getBoundingClientRect = () => ({ top: tops.shift() ?? 0 }) as DOMRect;
    const scrolls: number[][] = [];
    Object.assign(window, { scrollBy: (x: number, y: number) => scrolls.push([x, y]) });

    await act(async () => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(trigger.getAttribute("data-state")).toBe("closed");
    await new Promise((r) => requestAnimationFrame(() => r(null))); // the handler corrects on the next frame
    expect(scrolls).toEqual([[0, -1864]]); // the lost height taken back out of the scroll position
  });

  // Same page, one lane later: once the branch is promoted the same review happens on the PR route,
  // so its header has to be pinned too (it wasn't, and the pinning "disappeared" after promotion).
  test("the PR detail page pins its header the same way", async () => {
    apiFake.diffText = DIFF;
    await mount(<PrDetail repo="r" number={66} sub="files" />);

    const back = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Back to board"));
    const sticky = back!.closest(".sticky");
    expect(sticky).not.toBeNull();
    expect(sticky!.className).toMatch(/\btop-0\b/);
    expect(sticky!.className).toMatch(/\bbg-background\b/);
    expect(sticky!.textContent).toContain("PR 66");
    expect(sticky!.querySelector('[role="tablist"]')).not.toBeNull();
    expect(container!.querySelector<HTMLElement>("[style*='--stick']")).not.toBeNull();
  });
});
