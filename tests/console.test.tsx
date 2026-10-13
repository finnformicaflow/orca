// The Vercel-style console (sidebar shell, Overview, Agents, Agent page, Usage/Repos/Settings): the
// pure derivations first — usage rows, chart helpers, durations, the chat log's counters and find,
// repo summaries — then the pages rendered against the fake api (tests/apiFake.ts) in a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { repoFilterAtom } from "@/lib/atoms";
import {
  agentFailure, downsample, formatDuration, instanceOrder, niceMax, repoSummaries, routingBroken, rowDuration, timeTicks, untilReset,
  usageGroups, type OverviewRow,
} from "@/workstream";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const w = (utilization: number, h: number | null = 2) => ({ utilization, resetsAt: h === null ? null : inHours(h) });

describe("console derivations (pure)", () => {
  test("usage rows: one Claude login → 5-hour / weekly / Fable / extra spend as value / limit; Codex after", () => {
    const groups = usageGroups({
      claude: { fiveHour: w(38, 2.25), sevenDay: w(55, 50), fable: w(12, 100), extra: { usedMinor: 8535, limitMinor: 20000, currency: "GBP", exponent: 2, utilization: 43 } },
      codex: { windows: [{ label: "5h", ...w(9, 1) }, { label: "wk", ...w(30, 30) }] },
    }, NOW);
    expect(groups.map((g) => g.title)).toEqual(["Claude", "Codex"]);
    expect(groups[0]!.rows.map((r) => [r.label, r.value, r.limit, r.resetsIn])).toEqual([
      ["5-hour window", "38%", "100%", "2h 15m"],
      ["Weekly", "55%", "100%", "2d 2h"],
      ["Fable weekly", "12%", "100%", "4d 4h"],
      ["Extra usage", "£85.35", "£200.00", null],
    ]);
    expect(groups[1]!.rows.map((r) => [r.label, r.pct])).toEqual([["5-hour window", 9], ["Weekly", 30]]);
    expect(usageGroups(null)).toEqual([]);
    expect(untilReset(inHours(-1), NOW)).toBeNull();
  });

  test("usage rows with hydra: the fleet mean over the logins in rotation, then every login with its state", () => {
    const login = (name: string, five: number, state?: string, usage = true) => ({
      name, state, usage: usage ? { fiveHour: w(five), sevenDay: w(five / 2, 40), fable: null, extra: null } : null,
    });
    const groups = usageGroups({
      claude: null, codex: null, routing: { hydra: true, shim: true },
      profiles: [login("work", 80), login("home", 40, "exhausted"), login("old", 0, "not signed in on this machine", false)],
    }, NOW);
    expect(groups.map((g) => [g.title, g.subtitle, g.state, g.dim])).toEqual([
      ["Claude", "2 logins in rotation · 1 exhausted", undefined, undefined],
      ["work", undefined, undefined, false],
      ["home", undefined, "exhausted", false],
      ["old", undefined, "not signed in on this machine", true],
    ]);
    expect(groups[0]!.rows.map((r) => [r.label, r.pct])).toEqual([["5-hour window", 60], ["Weekly", 30]]);
    expect(routingBroken({ claude: null, codex: null, routing: { hydra: true, shim: false } })).toBe(true);
    expect(routingBroken({ claude: null, codex: null, routing: { hydra: false, shim: false } })).toBe(false);
  });

  test("charts: downsampling keeps the shape in at most N points; round maxima; time ticks", () => {
    const from = NOW - 168 * 3_600_000;
    const week = Array.from({ length: 10_080 }, (_, i) => ({ at: from + i * 60_000, v: i % 2 ? 10 : 30 }));
    const d = downsample(week, 300, from, NOW);
    expect(d.length).toBeLessThanOrEqual(301);
    expect(d.every((p) => Math.abs(p.v - 20) < 1)).toBe(true); // alternating 10/30 averages to 20
    expect(downsample(week.slice(0, 10), 300, from, NOW)).toHaveLength(10);
    expect([niceMax(0), niceMax(15.3), niceMax(31), niceMax(100), niceMax(0.4)]).toEqual([1, 20, 50, 100, 0.5]);
    const t = timeTicks(NOW - 6 * 3_600_000, NOW, 4);
    expect(t).toHaveLength(4);
    expect(t[3]!.label).toBe("now"); // the right edge
    expect(t[0]!.label).toBe(new Date(NOW - 6 * 3_600_000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })); // clock time within a day
    expect(timeTicks(NOW - 168 * 3_600_000, NOW)[0]!.label).toBe(new Date(NOW - 168 * 3_600_000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })); // dates beyond
  });

  test("instance order: cloud first, then local, then others alphabetically — regardless of input order", () => {
    expect(instanceOrder(["local", "cloud"])).toEqual(["cloud", "local"]);
    expect(instanceOrder(["cloud", "local"])).toEqual(["cloud", "local"]);
    expect(instanceOrder(["local", "cloud", "zed", "alpha"])).toEqual(["cloud", "local", "alpha", "zed"]);
    expect(instanceOrder(["local"])).toEqual(["local"]);
    expect(instanceOrder([])).toEqual([]);
  });

  test("durations: running counts from launch, otherwise the last turn's length; Vercel's compact format", () => {
    expect(formatDuration(44_000)).toBe("44s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(125 * 60_000)).toBe("2h 5m");
    expect(rowDuration({ agentStatus: "running", agentStartedAt: NOW - 90_000 }, NOW)).toBe(90_000);
    expect(rowDuration({ agentStatus: "done", transcript: [{ provider: "claude", prompt: "", startedAt: 1_000, finishedAt: 61_000 }] }, NOW)).toBe(60_000);
    expect(rowDuration({}, NOW)).toBeUndefined();
  });

  test("repo summaries: the overview's numbers per repo, plus last activity", () => {
    const rows: OverviewRow[] = [
      { repo: "a", branch: "x", title: "x", lane: "LOCAL", agentStatus: "running", transcript: [{ provider: "claude", prompt: "", startedAt: 500 }] },
      { repo: "a", branch: "y", title: "y", lane: "IN_REVIEW", prNumber: 2, ciStatus: "failing" },
      { repo: "b", branch: "z", title: "z", lane: "DONE", prNumber: 3 },
    ];
    expect(repoSummaries(rows, ["a", "b", "c"])).toEqual([
      { repo: "a", total: 2, running: 1, attention: 1, openPrs: 1, local: 1, mergedToday: 0, lastActivity: 500 },
      { repo: "b", total: 1, running: 0, attention: 0, openPrs: 0, local: 0, mergedToday: 1, lastActivity: 0 },
      { repo: "c", total: 0, running: 0, attention: 0, openPrs: 0, local: 0, mergedToday: 0, lastActivity: 0 },
    ]);
  });
});

test("agent failure box: a failed run's error, else the failed check's command, exit code and output tail", async () => {
  expect(agentFailure({ agentStatus: "error", agentError: "claude: not logged in" })).toEqual({ title: "Run failed", detail: "claude: not logged in" });
  const check = { command: "bun run check", ok: false, exitCode: 1, output: "x\n".repeat(20) + "1 fail", durationMs: 9 };
  const f = agentFailure({ agentStatus: "done", agentCheck: check })!;
  expect(f.title).toBe("Check failed");
  expect(f.detail).toStartWith('Command "bun run check" exited with 1');
  expect(f.detail.split("\n").length).toBeLessThanOrEqual(14); // only the tail
  expect(agentFailure({ agentStatus: "done", agentCheck: { ...check, ok: true } })).toBeUndefined();
});

// ---- the pages, against the fake api ----


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function open(path: string) {
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
const $ = (slot: string) => container!.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
const type = async (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
});

describe("the console's pages", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    await act(async () => { await store.refresh(); });
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    getDefaultStore().set(repoFilterAtom, "all");
    localStorage.clear();
    navigate("/");
  });

  const turns = [
    { id: "t1", provider: "claude", prompt: "p", instruction: "Build the login form", response: "## Outcome\nForm built.", startedAt: NOW - 3_600_000, finishedAt: NOW - 3_500_000 },
    { id: "t2", provider: "claude", prompt: "p", instruction: "Fix the flaky login test", response: "claude: not logged in", failed: true, startedAt: NOW - 600_000, finishedAt: NOW - 590_000 },
    { id: "t3", provider: "claude", prompt: "p", instruction: "Try again", response: "Stopped.", stopped: true, startedAt: NOW - 300_000, finishedAt: NOW - 290_000 },
  ];
  const seedLocal = () => {
    apiFake.agentsData = [{ branch: "feat-login", worktreePath: "/wt/feat-login", agentStatus: "error", agentError: "claude: not logged in" }];
    apiFake.enrichmentData.set("r::feat-login", { title: "Login form", transcript: turns });
    apiFake.turnsData.set("r::feat-login", turns);
    apiFake.summaryData = { files: [{ path: "src/login.tsx", additions: 40, deletions: 2 }], commits: [{ hash: "6eaab29aaaa", subject: "Add the login form" }], additions: 40, deletions: 2 };
  };

  test("agent page: a Details card — the failure box like Build Failed, status, model, source branch + latest commit", async () => {
    seedLocal();
    await open("/r/local/feat-login");
    expect(container!.querySelector('nav[aria-label="Breadcrumb"]')!.textContent).toContain("Login form");
    const details = $("agent-details");
    expect(details.querySelector('[data-slot="failure-box"]')!.textContent).toContain("Run failed");
    expect(details.querySelector('[data-slot="failure-box"]')!.textContent).toContain("claude: not logged in");
    expect(details.querySelector('[data-slot="detail-status"]')!.textContent).toContain("Error");
    expect(details.querySelector('[data-slot="detail-created"]')!.textContent).toContain("ago");
    expect(details.querySelector('[data-slot="detail-model"]')!.textContent).not.toBe("");
    const source = details.querySelector('[data-slot="detail-source"]')!.textContent!;
    expect(source).toContain("feat-login");
    expect(source).toContain("6eaab29");
    expect(source).toContain("Add the login form");
    // The page's actions live in the compact header row now, not on the card.
    expect(details.querySelector('button[aria-label="Actions"]')).toBeNull();
    expect($("agent-header").querySelector('button[aria-label="Actions"]')).not.toBeNull();
    // The local preview control (link/Add preview + its Stop button) sits beside the PR one — not
    // just a click away on the Preview tab.
    expect(details.querySelector('[data-slot="preview-cell"]')).not.toBeNull();
    const tabs = [...container!.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Overview", "Chat", "Files changed (1)", "Preview"]);
  });

  // Finn: the header wasted height (a repo line, a 2xl title, links, then the tabs on their own
  // row) and the Chat tab's window was short. Now ONE row — title, status, branch, actions — with the
  // tabs directly under it, both in the sticky block flush under the top bar, and the chat sized to
  // the viewport minus the top bar, main's bottom padding and that header's live height.
  test("agent page: one compact sticky header row — title, status, branch, actions — with the tabs right under it; the chat fills the rest", async () => {
    seedLocal();
    await open("/r/local/feat-login/chat");
    const head = $("agent-header");
    expect(head.querySelector("h1")!.textContent).toContain("Login form");
    expect(head.querySelector("h1")!.className).not.toContain("text-2xl");
    expect(head.querySelector('[data-slot="agent-header-status"]')!.textContent).toBe("Error");
    expect(head.querySelector('[data-slot="agent-header-source"]')!.textContent).toContain("feat-login");
    expect(head.querySelector('button[aria-label="Actions"]')).not.toBeNull();
    const sticky = head.closest(".sticky")!;
    expect(sticky.querySelector('[role="tablist"]')).not.toBeNull(); // tabs in the same pinned block
    expect(sticky.className).toMatch(/(^|\s)-mt-6(\s|$)/); // flush under the top bar, over main's top padding
    expect(sticky.children).toHaveLength(2); // the row and the tabs — nothing else stacked in it
    expect(sticky.closest('[data-slot="tabs"]')!.className).toContain("gap-0");
    const chat = $("agent-chat");
    // Full-bleed, and on desktop it takes main's bottom padding: only the top bar and the header remain.
    expect(chat.className).toContain("md:h-[calc(var(--vvh,100dvh)-3.5rem-env(safe-area-inset-top)-var(--stick,0px))]");
    expect(chat.className).toContain("h-[calc(var(--vvh,100dvh)-9rem-");
    expect(chat.className.split(/\s+/)).toEqual(expect.arrayContaining(["-mx-4", "md:-mx-6", "md:-mb-6"]));
    // Even padding around the header, and the tabs pulled left so "Overview" lines up with the repo name.
    expect(sticky.className.split(/\s+/)).toContain("py-2");
    expect(sticky.querySelector('[role="tablist"]')!.className).toContain("-ml-[13px]");
  });

  test("agent page: Overview has no chat section — the conversation lives on its own Chat tab", async () => {
    seedLocal();
    await open("/r/local/feat-login");
    expect(container!.querySelector('[data-slot="agent-chat"]')).toBeNull();
    expect(container!.querySelector("textarea")).toBeNull(); // no composer on this tab either
    expect(container!.querySelector('[data-slot="agent-details"]')).not.toBeNull(); // the rest of Overview stays
  });

  // Finn: "remove the bar with the error / warning and Find in chat, I have no idea what any of that
  // does" — the conversation is the log and the composer, nothing above it.
  test("agent page: the Chat tab — no toolbar (no counters, no Find in chat), timestamped tinted turns, composer focused", async () => {
    seedLocal();
    await open("/r/local/feat-login/chat");
    const chat = $("agent-chat");
    expect(chat.textContent).not.toContain("Conversation"); // no card header
    for (const slot of ["chat-logbar", "chat-errors", "chat-warnings", "chat-working"]) expect(chat.querySelector(`[data-slot="${slot}"]`)).toBeNull();
    expect(chat.querySelector('input[aria-label="Find in chat"]')).toBeNull();
    const times = chat.querySelectorAll('[data-slot="turn-time"]');
    expect(times).toHaveLength(3);
    // Sticky within each turn's own row, offset below the running/stop banner's own sticky bar so
    // the two are never stuck in the same place at once; a background keeps the stuck line readable.
    for (const t of times) {
      expect(t.className).toContain("sticky");
      expect(t.className).toContain("top-7");
      expect(t.className).toContain("bg-neutral-950");
    }
    expect(chat.querySelector('[data-slot="chat-turn"][data-failed]')!.className).toContain("bg-red-500/10"); // tinted like an error line
    // The composer is at the foot, with focus — opening the Chat tab is one of the ways in.
    const box = chat.querySelector("textarea")!;
    expect(box).not.toBeNull();
    expect(document.activeElement).toBe(box);
    // Even padding all round the composer, and the messages smaller than the modal's terminal.
    expect(box.closest(".border-t")!.className.split(/\s+/)).toEqual(["border-t", "p-4"]);
    const log = chat.querySelector<HTMLElement>(".font-mono.overflow-y-auto")!;
    expect(log.className).toContain("text-[11px]");
    expect(log.className).toContain("[&_.prose]:text-[12px]");
  });

  // Finn: the Ask pill sat on top of the Chat tab's composer, which fills the viewport's foot.
  test("agent page: the quick-ask pill is hidden on the Chat tab, and back on Overview", async () => {
    seedLocal();
    await open("/r/local/feat-login/chat");
    expect(container!.querySelector('[data-slot="quick-ask"]')).toBeNull();
    act(() => root?.unmount()); container?.remove();
    await open("/r/local/feat-login");
    expect(container!.querySelector('[data-slot="quick-ask"]')).not.toBeNull();
  });

  test("agent page: a running agent shows in the header's status (the chat has no toolbar for it)", async () => {
    apiFake.agentsData = [{ branch: "feat-login", worktreePath: "/wt/feat-login", agentStatus: "running" }];
    await open("/r/local/feat-login/chat");
    expect($("agent-header").querySelector('[data-slot="agent-header-status"]')!.textContent).toBe("Running");
  });

  test("agent page: clicking the Chat tab focuses its composer without disturbing Overview's own load", async () => {
    seedLocal();
    await open("/r/local/feat-login");
    expect(document.activeElement).not.toBe(container!.querySelector("textarea")); // Overview has none, and nothing stole focus
    const tab = [...container!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "Chat")!;
    // Radix switches tabs on mousedown, not click.
    await act(async () => { tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); await flush(); await flush(); });
    expect(document.activeElement).toBe($("agent-chat").querySelector("textarea"));
  });

  test("agent page: the Chat tab is the conversation alone; a coworker's PR has no Chat tab", async () => {
    seedLocal();
    await open("/r/local/feat-login/chat");
    expect($("agent-chat")).not.toBeNull();
    expect(container!.querySelector('[data-slot="agent-details"]')).toBeNull();
    act(() => root?.unmount()); container?.remove();
    apiFake.prDetailData = { title: "Someone else's work", author: "alice", head: "their-branch" };
    await open("/r/prs/42");
    expect($("pr-details").textContent).toContain("alice");
    expect([...container!.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain("Chat");
    expect(container!.querySelector('[data-slot="agent-chat"]')).toBeNull();
  });

  test("Repos: one row per repo with its numbers; a click opens Agents scoped to it", async () => {
    seedLocal();
    await open("/repos");
    const row = $("repo-row");
    expect(row.textContent).toContain("r");
    expect(row.textContent).toContain("Needs you1");
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(location.pathname).toBe("/agents");
    expect(getDefaultStore().get(repoFilterAtom)).toBe("r");
  });

  test("Settings: theme and density, and the configuration this bridge runs with (read-only)", async () => {
    await open("/settings");
    expect($("settings-appearance").querySelector('[role="group"][aria-label="Theme"]')).not.toBeNull();
    expect($("settings-appearance").querySelector('[role="group"][aria-label="Density"]')).not.toBeNull();
    const cfg = $("settings-config");
    expect(cfg.textContent).toContain("laptop");
    expect(cfg.textContent).toContain("base main");
  });

  test("Settings: each machine's hourly cost is editable — a rate saves, empty clears it back to automatic", async () => {
    await open("/settings");
    const input = (name: string) => $("settings-machine-cost").querySelector<HTMLInputElement>(`[aria-label="${name} USD per hour"]`)!;
    expect([...$("settings-machine-cost").querySelectorAll('[data-slot="machine-rate"]')].map((i) => i.getAttribute("aria-label")))
      .toEqual(["cloud USD per hour", "laptop USD per hour"]);
    expect(input("cloud").value).toBe(""); // nothing configured: automatic
    const type = async (el: HTMLInputElement, v: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => { set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
      await act(async () => { el.form!.requestSubmit(); await flush(); });
    };
    await type(input("cloud"), "0.2331");
    expect(input("cloud").value).toBe("0.2331"); // the store's mirror now holds it
    await type(input("cloud"), "");
    expect(apiFake.setInstanceRateCalls).toEqual([{ instance: "cloud", hourlyUsd: 0.2331 }, { instance: "cloud", hourlyUsd: null }]);
    expect(input("cloud").value).toBe("");
  });
});

// The surface rules from Finn's audit, asserted on the rendered pages so they can't drift back:
// 1px hairlines only, no shadows outside menus / popovers / modals, 8px cards, and no card nested in
// a card's border (the conversation runs full-bleed in its card, like Vercel's Build Logs).
describe("surfaces: Vercel's hairlines, radii and shadows", () => {
  beforeAll(() => store.configReady);
  afterEach(async () => {
    apiFake.reset();
    await act(async () => { await store.refresh(); });
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    localStorage.clear();
    navigate("/");
  });
  // The orchestrator's floating launcher and window are out of scope ("stays as it is"): a floating
  // button keeps its lift, as Vercel's does.
  const classes = () => [...container!.querySelectorAll<HTMLElement>("[class]")]
    .filter((el) => !el.closest('[aria-label$="orchestrator"]'))
    .map((el) => el.getAttribute("class")!);
  const offending = (re: RegExp) => classes().filter((c) => re.test(c));

  for (const path of ["/", "/agents", "/previews", "/usage", "/repos", "/settings", "/r/local/feat-login"]) {
    test(`${path}: 1px borders, no stray shadows, 8px cards`, async () => {
      apiFake.agentsData = [{ branch: "feat-login", worktreePath: "/wt/feat-login", agentStatus: "done" }];
      apiFake.turnsData.set("r::feat-login", [{ id: "t1", provider: "claude", prompt: "p", instruction: "go", response: "done", startedAt: NOW, finishedAt: NOW + 1 }]);
      await open(path);
      expect(offending(/(^|\s)border(-[lrtbxy])?-(2|4|8)(\s|$)/)).toEqual([]);
      expect(offending(/(^|\s)(hover:|focus:)?shadow-(xs|sm|md|lg|xl|2xl)(\s|$)/)).toEqual([]);
      for (const card of container!.querySelectorAll<HTMLElement>("section[data-slot]")) {
        expect(card.className).toContain("rounded-lg");
        expect(card.className).not.toContain("shadow");
      }
    });
  }

  test("the agent page's conversation runs full-bleed on its Chat tab: no card, no border of its own, the page's theme", async () => {
    apiFake.agentsData = [{ branch: "feat-login", worktreePath: "/wt/feat-login", agentStatus: "done" }];
    await open("/r/local/feat-login/chat");
    const chat = container!.querySelector<HTMLElement>('[data-slot="agent-chat"]')!;
    expect(chat.closest("section[data-slot]")).toBeNull(); // no VCard wrapper — a plain fill container
    const log = chat.querySelector<HTMLElement>(".font-mono.overflow-y-auto")!;
    expect(log.className).not.toMatch(/(^|\s)(border|rounded-md)(\s|$)/);
    expect(chat.querySelector(".log-themed")).not.toBeNull(); // follows the page's light/dark theme
  });
});
