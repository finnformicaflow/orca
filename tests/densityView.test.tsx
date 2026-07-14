// E2E for the dense-view toggle: flipping orca.density to "dense" strips a (non-Done) card down to
// its at-a-glance status — repo, title, and status/condition badges stay, while the prompt, diffstat
// and preview+actions footer are dropped; "comfortable" shows them all. Done cards ignore density
// (already compact). Driven against the fake api (tests/apiFake.ts), rendered into a real DOM. See
// Board.WorkstreamCard + lib/atoms.densityAtom.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { WorkstreamCard } from "@/views/Board";
import { densityAtom } from "@/lib/atoms";
import type { Row } from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<WorkstreamCard row={row} />); await flush(); await flush(); });
}

const base: Row = {
  repo: "r", hasRemote: true, branch: "dense-1", title: "Add dense view",
  prompt: "Make the board denser", lane: "IN_REVIEW", worktreePath: "/wt/dense-1", prNumber: 7, prUrl: "https://x/7",
  mergeable: "MERGEABLE", ciStatus: "passing",
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  getDefaultStore().set(densityAtom, "comfortable");
  localStorage.clear();
  apiFake.reset();
});

describe("dense view", () => {
  test("comfortable (default) shows the prompt, diffstat and actions footer", async () => {
    apiFake.summaryData = { files: [{}, {}], commits: [{}], additions: 12, deletions: 3 };
    await mount(base);
    expect(container!.textContent).toContain("Make the board denser"); // prompt
    expect(container!.textContent).toContain("2 files"); // diffstat
    expect([...container!.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Follow up")).toBe(true); // actions
  });

  test("dense drops the prompt, diffstat and actions footer but keeps title + status badges", async () => {
    getDefaultStore().set(densityAtom, "dense");
    apiFake.summaryData = { files: [{}, {}], commits: [{}], additions: 12, deletions: 3 };
    await mount(base);
    // At-a-glance status survives.
    expect(container!.textContent).toContain("Add dense view"); // title
    expect(container!.textContent).toContain("CI"); // condition badge
    expect(container!.querySelector('[href="https://x/7"]')).not.toBeNull(); // PR destination link
    // Detail + footer are gone.
    expect(container!.textContent).not.toContain("Make the board denser"); // prompt
    expect(container!.textContent).not.toContain("2 files"); // diffstat
    expect([...container!.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Follow up")).toBe(false); // actions
  });

  test("a Done card ignores dense (stays as-is)", async () => {
    getDefaultStore().set(densityAtom, "dense");
    await mount({ ...base, lane: "DONE", mergedAt: new Date().toISOString() });
    expect(container!.textContent).toContain("Add dense view");
    expect(container!.textContent).toContain("merged"); // Done cards render their normal merged line
  });
});
