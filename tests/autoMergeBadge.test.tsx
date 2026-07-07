// E2E for the auto-merge card badge (server/gh.listPrs → store Row.autoMergeEnabled →
// Board.ConditionBadges): an open PR with GitHub auto-merge armed shows a purple "Auto-merge"
// badge alongside the other GitHub condition badges (ready for review, CI, …). Driven against the
// fake api (tests/apiFake.ts), rendered into a real DOM.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
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

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); }); // clear the shared store's live PRs so we don't leak rows into other test files
});

const pr = (over: Record<string, unknown>) => ({
  number: 1, title: "feat", branch: "feat-x", url: "u", state: "OPEN", isDraft: false,
  ciStatus: "none", reviewStatus: "none", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
});
const badge = (label: string) =>
  [...container!.querySelectorAll("[data-slot='badge']")].find((b) => b.textContent?.trim().startsWith(label));

test("open PR with auto-merge armed shows the capitalised Auto-merge badge; a plain PR does not", async () => {
  apiFake.prsData = [pr({ number: 1, branch: "feat-am", autoMergeEnabled: true })];
  await act(async () => { await store.refresh(); });
  await mount();
  expect(badge("Auto-merge")).not.toBeUndefined();
});

test("open PR without auto-merge shows no Auto-merge badge", async () => {
  apiFake.prsData = [pr({ number: 2, branch: "feat-plain", autoMergeEnabled: false })];
  await act(async () => { await store.refresh(); });
  await mount();
  expect(badge("Auto-merge")).toBeUndefined();
});
