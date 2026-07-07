// E2E for the enriched swimlane card details: the worktree name (click-to-copy) and a coloured
// diffstat must render on every lane EXCEPT Done, on their own lines. Driven against the fake api
// (tests/apiFake.ts) — the card polls api.summary — rendered into a real DOM. See Board.WorkstreamCard.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { WorkstreamCard } from "@/views/Board";
import type { Row } from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));

let copied = "";
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
});

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(row: Row) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<WorkstreamCard row={row} />); await flush(); await flush(); });
}

const base: Row = {
  repo: "r", hasRemote: true, branch: "enrich-cards-1", title: "Enrich cards",
  prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/enrich-cards-1", prNumber: 7, prUrl: "https://x/7",
  mergeable: "MERGEABLE",
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  copied = "";
  apiFake.reset();
});

describe("swimlane card details", () => {
  test("a non-local (In Review) card shows the worktree name and a coloured diffstat", async () => {
    apiFake.summaryData = { files: [{}, {}], commits: [{}], additions: 12, deletions: 3 };
    await mount(base);

    const name = container!.querySelector<HTMLElement>('button[title="Copy worktree name"]');
    expect(name?.textContent).toContain("enrich-cards-1");

    // Diffstat is a SEPARATE line from the name, with green additions + red deletions and a file count.
    const add = container!.querySelector(".text-emerald-700");
    const del = container!.querySelector(".text-destructive");
    expect(add?.textContent).toBe("+12");
    expect(del?.textContent).toBe("−3");
    expect(container!.textContent).toContain("2 files");
  });

  test("clicking the worktree name copies it", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount(base);
    const name = container!.querySelector<HTMLElement>('button[title="Copy worktree name"]')!;
    await act(async () => { name.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(copied).toBe("enrich-cards-1");
  });

  test("a PR card shows a copy-link icon that copies the PR url", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount(base);
    const btn = container!.querySelector<HTMLElement>('button[title="Copy PR link"]')!;
    expect(btn).not.toBeNull();
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(copied).toBe("https://x/7");
  });

  test("a local card with no PR has no copy-link icon", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, lane: "LOCAL", prNumber: undefined, prUrl: undefined });
    expect(container!.querySelector('button[title="Copy PR link"]')).toBeNull();
  });

  test("a Done card shows neither the copy-name control nor the diffstat", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 5, deletions: 5 };
    await mount({ ...base, lane: "DONE", mergedAt: new Date().toISOString() });
    expect(container!.querySelector('button[title="Copy worktree name"]')).toBeNull();
    expect(container!.textContent).not.toContain("+5");
  });
});
