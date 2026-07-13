// E2E for the "Test master" menu row: launching a base-branch preview per repo, reflecting its
// ready state, and surfacing a failed start as Retry + a Log popover trigger. Driven against the
// fake api (tests/apiFake.ts) into a real DOM. See PreviewControl.TestMasterRow.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { TestMasterMenu, TestMasterRow } from "@/views/PreviewControl";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r", base "main") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<TestMasterRow repo="r" />); await flush(); });
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
const button = (label: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  await store.stopMaster("r"); // clear the module-level master-preview state + poll timer between tests
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); });
});

test("TM3 header: the Test master button sits by the repo controls, after the usage meter", async () => {
  apiFake.usageData = { claude: { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 20, resetsAt: null }, extra: null }, codex: null };
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); await flush(); });

  const meter = container.querySelector("[aria-label='Claude usage limits']")!;
  const testMaster = container.querySelector("[aria-label='Test master']")!;
  expect(meter).toBeTruthy();
  expect(testMaster).toBeTruthy();
  // Test master moved to the right of the usage meter (next to the repo selector), not before it.
  expect(meter.compareDocumentPosition(testMaster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("TM1 test-master row: launches the base preview and opens once ready", async () => {
  apiFake.previewSvcs = [{ name: "web", port: 5173, url: "http://localhost:5173", open: true, running: true, ready: true, startedAt: 1 }];
  await mount();
  // Idle: offers to test the repo's base branch by name.
  expect(button("Test main")).toBeTruthy();

  await click(button("Test main")!);
  expect(apiFake.calls).toContain("previewMaster:r"); // hit the base-preview endpoint for this repo
  expect(button("Open main")).toBeTruthy();           // ready → surfaces the open link
});

test("TM2 test-master row: a failed start shows Retry + a Log popover trigger", async () => {
  apiFake.previewMasterError = "sh: nest: command not found";
  await mount();

  await click(button("Test main")!);
  expect(button("Retry main")).toBeTruthy();               // failed start drops back to a retry affordance…
  expect(button("Preview failed — show log")).toBeTruthy(); // …with the card-styled log trigger below it (opens a popover)
});

test("TM4 test-master row: survives the popover closing — no reset, no duplicate launch", async () => {
  apiFake.previewSvcs = [{ name: "web", port: 5173, url: "http://localhost:5173", open: true, running: true, ready: true, startedAt: 1 }];
  await mount();
  expect(button("Test main")).toBeTruthy();
  await click(button("Test main")!);
  expect(button("Open main")).toBeTruthy();
  const starts = () => apiFake.calls.filter((c) => c === "previewMaster:r").length;
  const launched = starts();

  // Closing the popover unmounts the row — but the preview lifecycle lives in the store, so the
  // detached preview keeps running and a reopened row re-reads it instead of resetting/relaunching.
  act(() => root!.unmount());
  await mount();
  expect(button("Open main")).toBeTruthy(); // still connected to the running preview
  expect(button("Test main")).toBeFalsy();  // NOT reset to the idle "launch" affordance
  expect(starts()).toBe(launched);          // no second base-preview launch
});

test("TM5 menu trigger: spinner while a base preview boots, badge once it's live", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<TestMasterMenu />); await flush(); });
  const trigger = () => container!.querySelector("[aria-label='Test master']")!;

  // Booting (running, not yet ready) → spinner in place of the flask.
  apiFake.previewSvcs = [{ name: "web", port: 5173, url: "http://localhost:5173", open: true, running: true, ready: false, startedAt: 1 }];
  await act(async () => { await store.startMaster("r"); await flush(); });
  expect(trigger().querySelector(".animate-spin")).toBeTruthy();

  // Fully up → badge dot, no spinner.
  apiFake.previewSvcs = [{ name: "web", port: 5173, url: "http://localhost:5173", open: true, running: true, ready: true, startedAt: 1 }];
  await act(async () => { await store.startMaster("r"); await flush(); });
  expect(trigger().querySelector(".animate-spin")).toBeFalsy();
  expect(trigger().querySelector("[aria-label='a base preview is running']")).toBeTruthy();
});
