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
import { shapeUsage, untilReset } from "../server/usage";

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

test("shows the time left till each window resets", async () => {
  const in90m = new Date(Date.now() + 90 * 60_000).toISOString();
  apiFake.usageData = { fiveHour: { utilization: 38, resetsAt: in90m }, sevenDay: { utilization: 55, resetsAt: null } };
  await mount();
  expect(meter()?.textContent ?? "").toContain("2h"); // 90m rounds to 2h
});

test("untilReset formats the countdown compactly, null when unknown/past", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  expect(untilReset(null, now)).toBeNull();
  expect(untilReset("2026-07-08T11:00:00Z", now)).toBeNull(); // already past
  expect(untilReset("2026-07-08T12:45:00Z", now)).toBe("45m");
  expect(untilReset("2026-07-08T14:00:00Z", now)).toBe("2h");
  expect(untilReset("2026-07-10T12:00:00Z", now)).toBe("2d");
});

test("renders nothing when not logged in / not on a Claude.ai plan (usage is null)", async () => {
  apiFake.usageData = null;
  await mount();
  expect(meter()).toBeNull();
});

test("shows extra-usage spend as money in the plan's currency", async () => {
  apiFake.usageData = {
    fiveHour: { utilization: 20, resetsAt: null }, sevenDay: { utilization: 30, resetsAt: null },
    extra: { usedMinor: 8535, limitMinor: 20000, currency: "GBP", exponent: 2, utilization: 43 },
  };
  await mount();
  const text = meter()?.textContent ?? "";
  expect(text).toContain("extra");
  expect(text).toContain("£85.35"); // 8535 minor / 10^2, GBP → pound-formatted
});

test("shapeUsage clamps/rounds utilization, defaults windows to 0%, and extracts extra-usage spend", () => {
  expect(shapeUsage({ five_hour: { utilization: 37.6, resets_at: "2026-07-08T20:00:00Z" }, seven_day: { utilization: 120 } }))
    .toEqual({ fiveHour: { utilization: 38, resetsAt: "2026-07-08T20:00:00Z" }, sevenDay: { utilization: 100, resetsAt: null }, extra: null });
  expect(shapeUsage(null)).toEqual({ fiveHour: { utilization: 0, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null }, extra: null });

  // enabled extra_usage → surfaced in minor units + currency; disabled → null (widget skips it)
  const withExtra = shapeUsage({ extra_usage: { is_enabled: true, used_credits: 8535, monthly_limit: 20000, currency: "GBP", decimal_places: 2, utilization: 42.7, disabled_reason: null } });
  expect(withExtra.extra).toEqual({ usedMinor: 8535, limitMinor: 20000, currency: "GBP", exponent: 2, utilization: 43 });
  expect(shapeUsage({ extra_usage: { is_enabled: false } }).extra).toBeNull();
});
