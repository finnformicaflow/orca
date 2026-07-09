// E2E for the "Test master" menu row: launching a base-branch preview per repo, reflecting its
// ready state, and surfacing a failed start as Retry + a Log popover trigger. Driven against the
// fake api (tests/apiFake.ts) into a real DOM. See PreviewControl.TestMasterRow.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { TestMasterRow } from "@/views/PreviewControl";

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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  apiFake.reset();
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
