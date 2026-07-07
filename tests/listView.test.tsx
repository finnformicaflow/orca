// E2E for the board display toggle (App.Nav → boardViewAtom → Board): the header nav offers a
// "List" button next to "Board"; clicking List stacks the swimlanes as collapsible sections that
// scroll internally (max-w-3xl + an overflow-y-auto pane) instead of side-by-side kanban columns
// (grid), and the choice persists. Section headers collapse like an accordion. Driven against the
// fake api (tests/apiFake.ts), rendered into a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./apiFake";
import * as store from "@/store";
import { App } from "@/App";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  localStorage.clear();
});

const gridEl = () => container!.querySelector(".xl\\:grid-cols-5");
const listEl = () => container!.querySelector(".max-w-3xl");
const navBtn = (label: string) =>
  [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const clickEl = async (el?: Element | null) =>
  await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });

describe("board display toggle", () => {
  test("defaults to the kanban grid; Board/List buttons sit in the nav", async () => {
    await mount();
    expect(gridEl()).not.toBeNull();
    expect(listEl()).toBeNull();
    expect(navBtn("Board")).not.toBeUndefined();
    expect(navBtn("List")).not.toBeUndefined();
  });

  test("clicking List stacks the lanes as a scrolling section pane and persists; Board switches back", async () => {
    await mount();
    await clickEl(navBtn("List"));
    expect(listEl()).not.toBeNull();
    expect(gridEl()).toBeNull();
    // Only the list content scrolls — there's an internal overflow-y-auto pane.
    expect(listEl()!.querySelector(".overflow-y-auto")).not.toBeNull();
    expect(localStorage.getItem("orca.boardView")).toBe('"list"');

    await clickEl(navBtn("Board"));
    expect(gridEl()).not.toBeNull();
    expect(listEl()).toBeNull();
    expect(localStorage.getItem("orca.boardView")).toBe('"board"');
  });

  test("list section headers collapse like an accordion", async () => {
    await mount();
    await clickEl(navBtn("List"));
    // The Local section always renders (with the New-draft composer); its header toggles it closed.
    const header = [...container!.querySelectorAll("button[aria-expanded]")]
      .find((b) => b.textContent?.toLowerCase().includes("local"))!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(listEl()!.querySelector("textarea")).not.toBeNull(); // composer visible while expanded
    await clickEl(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(listEl()!.querySelector("textarea")).toBeNull(); // collapsed → content hidden
  });
});
