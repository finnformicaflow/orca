// E2E for the top-right usage meter (server/usage.shapeUsage → /api/usage → App.UsageMeter):
// Claude's 5-hour + weekly subscription limits show in the header, and the widget hides entirely
// when you're not on a Claude.ai plan (endpoint returns null). Driven against the fake api
// (tests/apiFake.ts), rendered into a real DOM. Plus a pure shapeUsage unit check (no network).
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { shapeUsage } from "../server/usage";

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
  await act(async () => { await store.refresh(); });
});

const meter = () => container!.querySelector("[aria-label='Claude usage limits']");

test("shows the 5-hour and weekly percentages in the header", async () => {
  apiFake.usageData = { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null } };
  await mount();
  const text = meter()?.textContent ?? "";
  expect(text).toContain("5h");
  expect(text).toContain("38%");
  expect(text).toContain("wk");
  expect(text).toContain("55%");
});

test("renders nothing when not logged in / not on a Claude.ai plan (usage is null)", async () => {
  apiFake.usageData = null;
  await mount();
  expect(meter()).toBeNull();
});

test("shapeUsage clamps/rounds utilization and defaults missing windows to 0%", () => {
  expect(shapeUsage({ five_hour: { utilization: 37.6, resets_at: "2026-07-08T20:00:00Z" }, seven_day: { utilization: 120 } }))
    .toEqual({ fiveHour: { utilization: 38, resetsAt: "2026-07-08T20:00:00Z" }, sevenDay: { utilization: 100, resetsAt: null } });
  expect(shapeUsage(null)).toEqual({ fiveHour: { utilization: 0, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null } });
});
