// E2E for the top-right usage meter (server/usage.shapeUsage → /api/usage → App.UsageMeter):
// Claude and Codex limits show as stacked terminal-style rows, and the widget hides entirely when
// neither provider is authenticated (endpoint returns null). Driven against the fake api
// (tests/apiFake.ts), rendered into a real DOM. Plus a pure shapeUsage unit check (no network).
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App, mergeUsage, untilReset } from "@/App";
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

test("mergeUsage keeps a provider's last-good value when a poll returns it null", () => {
  const claude = { fiveHour: { utilization: 40, resetsAt: null }, sevenDay: { utilization: 50, resetsAt: null }, extra: null };
  const codex = { windows: [{ label: "wk", durationMinutes: 10_080, utilization: 20, resetsAt: null }] };
  // Both present, then a poll where Codex transiently failed → Codex is retained, not dropped.
  expect(mergeUsage({ claude, codex }, { claude, codex: null })).toEqual({ claude, codex });
  // Cold start filling in over two polls: Claude first, then Codex, each preserved.
  expect(mergeUsage({ claude, codex: null }, { claude: null, codex })).toEqual({ claude, codex });
  // Nothing seen yet → just the new snapshot.
  expect(mergeUsage(null, { claude, codex: null })).toEqual({ claude, codex: null });
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

test("with hydra's logins, the meter shows one group per login with 5h, 1w AND the Fable window", async () => {
  apiFake.usageData = {
    claude: { fiveHour: { utilization: 95, resetsAt: null }, sevenDay: { utilization: 60, resetsAt: null }, extra: null },
    codex: null,
    profiles: [
      { name: "personal", state: "ok", usage: { fiveHour: { utilization: 95, resetsAt: null }, sevenDay: { utilization: 60, resetsAt: null }, extra: null, fable: { utilization: 21, resetsAt: null } } },
      { name: "work", state: "ok", usage: { fiveHour: { utilization: 12, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null } },
    ],
  };
  await mount();
  const personal = container!.querySelector("[aria-label='Claude personal usage limits']");
  const work = container!.querySelector("[aria-label='Claude work usage limits']");
  expect(personal?.textContent).toContain("claude·personal");
  expect(personal?.textContent).toContain("95%");
  expect(personal?.textContent).toContain("fable");   // the per-model window, from hydra's limits[] parse
  expect(personal?.textContent).toContain("21%");
  expect(work?.textContent).toContain("12%");
  expect(work?.textContent).not.toContain("fable");   // an account with no Fable window shows no bar
  // An ordinary "ok" login carries no state tag.
  expect(personal?.querySelector("[data-slot='usage-state']")).toBeNull();
});

test("a login that can't be used says why instead of showing misleading bars", async () => {
  apiFake.usageData = {
    claude: null, codex: null,
    profiles: [
      { name: "work", state: "exhausted", usage: { fiveHour: { utilization: 95, resetsAt: null }, sevenDay: { utilization: 40, resetsAt: null }, extra: null, fable: null } },
      { name: "spare", state: "not signed in on this machine", usage: null }, // no reading at all…
      { name: "old", state: "disabled", usage: null },
    ],
  };
  await mount();
  const work = container!.querySelector("[aria-label='Claude work usage limits']");
  expect(work?.querySelector("[data-slot='usage-state']")?.textContent).toBe("exhausted");
  expect(work?.textContent).toContain("95%"); // bars still shown — exhausted is a reading
  // …but the login still appears, named, with its reason, so the board shows every account hydra knows.
  const spare = container!.querySelector("[aria-label='Claude spare usage limits']");
  expect(spare?.textContent).toContain("claude·spare");
  expect(spare?.querySelector("[data-slot='usage-state']")?.textContent).toBe("not signed in on this machine");
  expect(spare?.textContent).not.toContain("%");
  expect(container!.querySelector("[aria-label='Claude old usage limits']")?.querySelector("[data-slot='usage-state']")?.textContent).toBe("disabled");
});

test("warns when hydra is installed but the bridge's `claude` isn't its shim (runs silently unrouted)", async () => {
  const one = { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null, fable: null };
  apiFake.usageData = { claude: one, codex: null, profiles: [{ name: "work", state: "ok", usage: one }], routing: { hydra: true, shim: false } };
  await mount();
  const warn = container!.querySelector("[data-slot='routing-warning']");
  expect(warn?.textContent).toContain("routing off");
  expect(warn?.getAttribute("title")).toContain("install.sh --shim");
});

test("no warning when the shim is active, or when hydra isn't installed at all", async () => {
  const one = { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: { utilization: 5, resetsAt: null }, extra: null };
  apiFake.usageData = { claude: one, codex: null, profiles: [{ name: "work", state: "ok", usage: one }], routing: { hydra: true, shim: true, bin: "/v/2.1.268" } };
  await mount();
  expect(container!.querySelector("[data-slot='routing-warning']")).toBeNull();
  act(() => root?.unmount()); container?.remove();
  apiFake.usageData = { claude: one, codex: null, routing: { hydra: false, shim: false } }; // no hydra → nothing to warn about
  await mount();
  expect(container!.querySelector("[data-slot='routing-warning']")).toBeNull();
});

test("mergeUsage keeps the last-known routing verdict across a poll that omitted it", () => {
  const claude = { fiveHour: { utilization: 40, resetsAt: null }, sevenDay: { utilization: 50, resetsAt: null }, extra: null };
  const routing = { hydra: true, shim: true };
  expect(mergeUsage({ claude, codex: null, routing }, { claude, codex: null })).toEqual({ claude, codex: null, profiles: undefined, routing });
});
