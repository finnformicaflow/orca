// E2E for the header (App): the left-hand lockup is a monospace "Orca" wordmark beside an SVG orca
// mark, and the board is the only view — the old Board/List/Review nav buttons are gone, so "/"
// always renders the kanban grid (no list-view toggle). Driven against the fake api (tests/apiFake.ts),
// rendered into a real DOM.
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
const btnByText = (label: string) =>
  [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("header", () => {
  test("renders the kanban grid by default (the board is the only view)", async () => {
    await mount();
    expect(gridEl()).not.toBeNull();
  });

  test("the wordmark is a monospace 'Orca' beside an SVG orca mark, linking home", async () => {
    await mount();
    const home = container!.querySelector('button[aria-label="Orca — go to board"]')!;
    expect(home).not.toBeNull();
    expect(home.querySelector("svg")).not.toBeNull(); // the orca mark
    const word = [...home.querySelectorAll("span")].find((s) => s.textContent?.trim() === "Orca")!;
    expect(word).not.toBeUndefined();
    expect(word.className).toContain("font-mono");
  });

  test("the old Board/List/Review nav buttons are gone", async () => {
    await mount();
    expect(btnByText("Board")).toBeUndefined();
    expect(btnByText("List")).toBeUndefined();
    expect(btnByText("Review")).toBeUndefined();
  });
});
