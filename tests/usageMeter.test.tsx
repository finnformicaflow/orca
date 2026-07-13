// E2E for the top-right usage meter (server/usage.shapeUsage → /api/usage → App.UsageMeter):
// Claude and Codex limits show as stacked terminal-style rows, and the widget hides entirely when
// neither provider is authenticated (endpoint returns null). Driven against the fake api
// (tests/apiFake.ts), rendered into a real DOM. Plus a pure shapeUsage unit check (no network).
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App, untilReset } from "@/App";
import { shapeCodexUsage, shapeUsage } from "../server/usage";

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
  apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
  await mount();
  const text = meter()?.textContent ?? "";
  expect(text).toContain("5h");
  expect(text).toContain("38%");
  expect(text).toContain("1w");
  expect(text).toContain("55%");
});

test("shows the time left till each window resets", async () => {
  const in90m = new Date(Date.now() + 90 * 60_000).toISOString();
  apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: in90m }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
  await mount();
  expect(meter()?.textContent ?? "").toContain("1h 30m");
});

test("untilReset formats the countdown compactly, null when unknown/past", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  expect(untilReset(null, now)).toBeNull();
  expect(untilReset("2026-07-08T11:00:00Z", now)).toBeNull(); // already past
  expect(untilReset("2026-07-08T12:45:00Z", now)).toBe("45m");
  expect(untilReset("2026-07-08T13:30:00Z", now)).toBe("1h 30m");
  expect(untilReset("2026-07-08T13:15:00Z", now)).toBe("1h 15m");
  expect(untilReset("2026-07-08T14:00:00Z", now)).toBe("2h");
  expect(untilReset("2026-07-10T12:00:00Z", now)).toBe("2d");
  expect(untilReset("2026-07-15T14:00:00Z", now)).toBe("7d 2h");
});

test("renders nothing when no provider usage is available", async () => {
  apiFake.usageData = null;
  await mount();
  expect(meter()).toBeNull();
});

test("shows extra-usage spend as money in the plan's currency", async () => {
  apiFake.usageData = {
    claude: {
      fiveHour: { utilization: 20, resetsAt: null }, sevenDay: { utilization: 30, resetsAt: null },
      extra: { usedMinor: 8535, limitMinor: 20000, currency: "GBP", exponent: 2, utilization: 43 },
    },
    codex: null,
  };
  await mount();
  const text = meter()?.textContent ?? "";
  expect(text).toContain("$");
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

test("shows Claude and Codex terminal bars side by side without lifetime tokens", async () => {
  apiFake.usageData = {
    claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null },
    codex: { windows: [{ label: "wk", durationMinutes: 10_080, utilization: 20, resetsAt: null }] },
  };
  await mount();
  const all = container!.querySelector("[aria-label='Agent usage limits']")!;
  const claude = container!.querySelector("[aria-label='Claude usage limits']")!;
  const codex = container!.querySelector("[aria-label='Codex usage limits']");
  expect(codex?.textContent ?? "").toContain("codex");
  expect(codex?.textContent ?? "").toContain("20%");
  expect(codex?.textContent ?? "").toContain("█░░░░");
  expect(all.textContent).not.toContain("total");
  expect(claude.compareDocumentPosition(codex!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("shapeCodexUsage maps app-server windows and unix reset timestamps", () => {
  expect(shapeCodexUsage({ rateLimits: {
    primary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 76, windowDurationMins: 300, resetsAt: null },
  } })).toEqual({
    windows: [
      { label: "wk", durationMinutes: 10_080, utilization: 20, resetsAt: "2027-01-15T08:00:00.000Z" },
      { label: "5h", durationMinutes: 300, utilization: 76, resetsAt: null },
    ],
  });
  expect(shapeCodexUsage(null)).toBeNull();
});
