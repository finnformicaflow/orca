// E2E for the board display toggle (App.ViewToggle → boardViewAtom → Board): the header offers a
// Board/List switch next to the nav; clicking List stacks the swimlanes as vertical sections
// (max-w-3xl) instead of side-by-side kanban columns (grid), and the choice persists. Driven against
// the fake api (tests/apiFake.ts), rendered into a real DOM.
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
const click = async (sel: string) =>
  await act(async () => { container!.querySelector<HTMLElement>(sel)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });

describe("board display toggle", () => {
  test("defaults to the kanban grid; a List/Board switch sits in the header", async () => {
    await mount();
    expect(gridEl()).not.toBeNull();
    expect(listEl()).toBeNull();
    expect(container!.querySelector('button[aria-label="List view"]')).not.toBeNull();
    expect(container!.querySelector('button[aria-label="Board view"]')).not.toBeNull();
  });

  test("clicking List stacks the lanes as sections and persists; Board switches back", async () => {
    await mount();
    await click('button[aria-label="List view"]');
    expect(listEl()).not.toBeNull();
    expect(gridEl()).toBeNull();
    expect(localStorage.getItem("orca.boardView")).toBe('"list"');

    await click('button[aria-label="Board view"]');
    expect(gridEl()).not.toBeNull();
    expect(listEl()).toBeNull();
    expect(localStorage.getItem("orca.boardView")).toBe('"board"');
  });
});
