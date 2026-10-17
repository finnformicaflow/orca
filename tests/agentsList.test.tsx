// E2E for the condensed Agents list (views/Agents.tsx): the column set and the no-horizontal-scroll
// layout (workstream.listColumns / listMinWidth), the right-click menu (the ⋯ menu's own items at
// the pointer), the running row's spinner + live elapsed time on ONE shared ticker (lib/ticker), and
// readable model labels instead of initials. Pure pieces first, then the view against the fake api.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Agents } from "@/views/Agents";
import { Board } from "@/views/Board";
import { navigate } from "@/lib/route";
import { createTicker, ticker } from "@/lib/ticker";
import { LIST_CHROME_PX, formatElapsed, listColumns, listFits, listGridTemplate, listMinWidth, modelBadge } from "@/workstream";
import { openTip } from "./tip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

describe("agents list layout (pure)", () => {
  test("the column set is only what you act on; no Instance column (it's a row menu/tooltip detail)", () => {
    expect(listColumns().map((c) => c.key)).toEqual(["workstream", "status", "pr", "signals", "actions"]);
    // Gone: the latest instruction, branch, model avatar, instance and the separate PR # column.
    const keys = listColumns().map((c) => c.key as string);
    for (const gone of ["instruction", "branch", "model", "prNumber", "updated", "instance"]) expect(keys).not.toContain(gone);
  });

  test("no horizontal scroll from 1280px up: the floors fit beside the sidebar; flexible tracks take the rest", () => {
    const cols = listColumns();
    for (const vw of [1280, 1440, 1920, 2560]) expect(listFits(cols, vw)).toBe(true);
    expect(listMinWidth(cols)).toBeLessThanOrEqual(1280 - LIST_CHROME_PX);
    const t = listGridTemplate(cols);
    expect(t).toBe("minmax(10rem,2fr) 8.5rem 8.5rem minmax(6rem,1fr) 10rem");
    expect(cols.at(-1)).toMatchObject({ key: "actions", label: "Actions" });
    expect(t).not.toContain("auto"); // a content-sized track could push the row wider than the card
  });

  test("elapsed: clock-style, stable width as it ticks", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(12 * 60_000 + 5_000)).toBe("12:05");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("0:00");
  });

  test("model labels are readable names with the provider in the tooltip, never initials", () => {
    expect(modelBadge(undefined, "claude-fable-5-1")).toEqual({ label: "Fable 5.1", title: "Model: Claude · Fable 5.1" });
    expect(modelBadge("Opus 5.5", "claude-opus-5-5")).toEqual({ label: "Opus 5.5", title: "Last run on Opus 5.5" });
    expect(modelBadge("Opus 5.5", "claude-sonnet-5")!.title).toBe("Last run on Opus 5.5 · next run: Claude · Sonnet 5");
    expect(modelBadge(undefined, "gpt-5.5")!.label).toBe("GPT-5.5");
    expect(modelBadge("Codex", undefined)).toEqual({ label: "Codex", title: "Last run on Codex" });
    expect(modelBadge(undefined, undefined)).toBeUndefined();
  });

  test("ticker: one interval however many subscribers, stopped when the last leaves", () => {
    let intervals = 0, cleared = 0, now = 1_000, fire = () => {};
    const t = createTicker(1000, { setInterval: (fn) => { intervals++; fire = fn; return intervals; }, clearInterval: () => { cleared++; }, now: () => now });
    expect(t.stats()).toEqual({ listeners: 0, running: false });
    let calls = 0;
    const offs = [1, 2, 3].map(() => t.subscribe(() => { calls++; }));
    expect(intervals).toBe(1);
    expect(t.stats()).toEqual({ listeners: 3, running: true });
    now = 2_000; fire();
    expect(t.getSnapshot()).toBe(2_000);
    expect(calls).toBe(3); // one tick notifies each subscriber once
    offs.forEach((off) => off());
    expect(cleared).toBe(1);
    expect(t.stats()).toEqual({ listeners: 0, running: false });
    now = 5_500;
    expect(t.getSnapshot()).toBe(5_000); // idle: the clock, floored to the period
  });
});

// ---- the view ----

const flush = () => new Promise((r) => setTimeout(r, 0));
const pointerdown = async (el: Element) => { await act(async () => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); }); };
const contextmenu = async (el: Element, x = 120, y = 40) => { await act(async () => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 })); await flush(); await flush(); }); };
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await flush(); await flush(); }); };
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<Agents />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  localStorage.clear();
  navigate("/");
});

const pr = (over: Record<string, unknown>) => ({
  number: 7, title: "feat", branch: "feat-x", url: "https://x/7", state: "OPEN", isDraft: false,
  ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
});
function seed() {
  apiFake.prsData = [pr({ number: 8, branch: "feat-ci", title: "Red CI", ciStatus: "failing", additions: 120, deletions: 34 })];
  apiFake.agentsData = [
    { branch: "local-run", worktreePath: "/wt/local-run", agentStatus: "running", agentStartedAt: Date.now() - 65_000 },
    { branch: "local-idle", worktreePath: "/wt/local-idle", agentStatus: "done", agentMeta: { model: "Opus 5.5" } },
  ];
}
const rowOf = (branch: string) => container!.querySelector<HTMLElement>(`[data-branch="${branch}"]`)!;
const menuItems = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) => i.textContent?.trim());
const ctxMenu = () => document.body.querySelector<HTMLElement>('[data-slot="row-context-menu"]');

describe("agents list view", () => {
  test("a header names the columns; the list never scrolls sideways; no per-row repo icon", async () => {
    seed();
    await mount();
    const head = container!.querySelector('[data-slot="workstream-list-header"]')!;
    // No Instance column — it's a row menu action ("Move to…") and a title tooltip now, not a track.
    expect([...head.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent)).toEqual(["Workstream", "Status", "PR", "Checks & review", "Actions"]);
    const list = container!.querySelector<HTMLElement>('[data-slot="workstream-list"]')!;
    expect(list.className).toContain("overflow-hidden");
    expect(list.className).not.toContain("overflow-x-auto");
    expect(list.querySelector('[class*="min-w-["]')).toBeNull(); // no fixed minimum forcing a scroll
    expect(rowOf("feat-ci").style.gridTemplateColumns).toBe(listGridTemplate(listColumns()));
    expect(rowOf("feat-ci").querySelectorAll('[role="cell"]')).toHaveLength(5); // one per header, the last holding preview + ⋯
    expect(rowOf("feat-ci").querySelector(".lucide-folder-git2")).toBeNull();
    // The row menu's trigger is vertical dots, not horizontal — same menu, same right-click.
    expect(rowOf("feat-ci").querySelector('button[aria-label="Actions"] svg')!.classList.contains("lucide-ellipsis-vertical")).toBe(true);
    expect(rowOf("feat-ci").querySelector(".lucide-ellipsis")).toBeNull(); // the old horizontal icon is gone
    // Regression: the ⋯ button's wrapper must space itself with flex/gap, not a margin-based
    // space-y-* utility — that still reserves space for its `display:none` siblings (the closed
    // rename/terminal dialogs), which inflated the wrapper past the button's own height and threw
    // its vertical centering off from its neighbours in the Actions cell. jsdom has no real layout
    // engine to catch the pixel offset itself (verified separately with Playwright), so this pins
    // the markup shape that causes it.
    const actionsBtn = rowOf("feat-ci").querySelector<HTMLElement>('button[aria-label="Actions"]')!;
    const actionsWrapper = actionsBtn.parentElement!.parentElement!;
    expect(actionsWrapper.className).not.toMatch(/\bspace-y-/);
    // Preview cell: idle, enabled (the fake config's repo "r" has RepoFeatures.previews on).
    expect(rowOf("feat-ci").querySelector<HTMLElement>('[data-slot="preview-cell"]')!.dataset.state).toBe("none");
    // The PR-preview text link sits right next to the model name in the subline — "add" state,
    // since feat-ci has neither a previewUrl nor the preview label yet.
    const inline = rowOf("feat-ci").querySelector<HTMLElement>('[data-slot="pr-preview-inline"]')!;
    expect(inline.dataset.state).toBe("add");
    expect(inline.textContent).toContain("Add preview");
    // (its own leading "·" separator sits between the two)
    const modelLabel = rowOf("feat-ci").querySelector('[data-slot="model-label"]')!;
    expect(inline.previousElementSibling?.previousElementSibling).toBe(modelLabel.closest('[data-slot="tip"]') ?? modelLabel);
    // Readable models: the run's reported model, else the pinned one — no initials avatar.
    expect(rowOf("local-idle").querySelector('[data-slot="model-label"]')!.textContent).toBe("Opus 5.5");
    expect(container!.querySelector('[data-slot="model-avatar"]')).toBeNull();
    // A PR's own diffstat (free from the same gh list call) shows in the subline, coloured.
    const diff = rowOf("feat-ci").querySelector<HTMLElement>('[data-slot="diffstat"]')!;
    expect(diff.textContent).toBe("+120 −34");
    expect(diff.querySelector(".text-emerald-700")!.textContent).toBe("+120");
    expect(diff.querySelector(".text-destructive")!.textContent).toBe("−34");
    // Instance is gone as a column and, with native hover titles removed, no longer shown on the
    // desktop row at all (only the phone's stacked subline carries an instance chip).
    const workstreamCell = rowOf("local-idle").querySelector('[role="cell"]')!;
    expect(workstreamCell.getAttribute("title")).toBeNull();
  });

  test("the orchestrator's `orca status` shows no chip on the Agents row, for either merge class — the purple Auto-merge PR pill already shows the queued state", async () => {
    seed();
    apiFake.enrichmentData.set("r::local-idle", { orchestrated: true, orchStatus: { plan: "Cache first", waitingOn: "Finn's call on TTL", mergeClass: "small", at: "2026-10-13T00:00:00Z" } });
    await mount();
    // The chip-only cell renders nothing regardless of merge class: no chip, and the plan/waiting
    // line doesn't ride this cell either.
    expect(rowOf("local-idle").querySelector('[data-slot="row-signals"] [data-slot="orch-status"]')).toBeNull();
    expect(rowOf("local-run").querySelector('[data-slot="orch-status"]')).toBeNull(); // none set, nothing shown
  });

  test("diffstat for a branch with no PR yet comes from the worktree's own git diff (useSummary)", async () => {
    seed();
    apiFake.summaryData = { files: [{ path: "a.ts", additions: 7, deletions: 1 }], commits: [{ hash: "abc", subject: "wip" }], additions: 7, deletions: 1 };
    await mount();
    const diff = rowOf("local-idle").querySelector<HTMLElement>('[data-slot="diffstat"]')!;
    expect(diff.textContent).toBe("+7 −1");
    // A PR row never calls the worktree summary for its diffstat — gh's own count wins.
    expect(rowOf("feat-ci").querySelector('[data-slot="diffstat"]')!.textContent).toBe("+120 −34");
  });

  test("running: a spinner and an elapsed time on the shared ticker, which ticks live and stops with the last row", async () => {
    seed();
    await mount();
    const run = rowOf("local-run");
    expect(run.querySelector('[data-slot="run-spinner"]')).not.toBeNull();
    expect(run.querySelector('[data-slot="status-dot"]')).toBeNull();
    const elapsed = () => run.querySelector('[data-slot="elapsed"]')!.textContent!;
    expect(elapsed()).toMatch(/^1:0[56]$/);
    expect(rowOf("local-idle").querySelector('[data-slot="elapsed"]')).toBeNull();
    expect(ticker.stats()).toEqual({ listeners: 1, running: true }); // only the running row subscribes
    const before = elapsed();
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    expect(elapsed()).not.toBe(before);
    act(() => root?.unmount());
    root = undefined;
    expect(ticker.stats()).toEqual({ listeners: 0, running: false });
  });

  test("quick actions: every verb that applies, icon-only with a tooltip, immediately left of the preview cell; a click runs the verb, not the row", async () => {
    apiFake.prsData = [
      pr({ number: 8, branch: "feat-ci", title: "Red CI", ciStatus: "failing" }),
      pr({ number: 9, branch: "feat-draft", title: "Draft", isDraft: true, mergeable: "CONFLICTING" }),
      pr({ number: 10, branch: "feat-ok", title: "Approved", reviewStatus: "approved" }),
    ];
    apiFake.agentsData = [{ branch: "local-idle", worktreePath: "/wt/local-idle", agentStatus: "done" }];
    apiFake.summaryData = { files: [{ path: "a.ts", additions: 1, deletions: 0 }], commits: [{ hash: "abc", subject: "wip" }], additions: 1, deletions: 0 };
    await mount();
    const quick = (branch: string) => [...rowOf(branch).querySelectorAll<HTMLElement>("[data-quick-action]")];
    const ids = (branch: string) => quick(branch).map((q) => q.dataset.quickAction);
    expect(ids("feat-ci")).toEqual(["addressPr"]); // review data not loaded: CI alone decides; a real problem shows Address PR alone
    expect(ids("feat-draft")).toEqual(["markReady", "addressPr"]);
    expect(ids("feat-ok")).toEqual(["merge", "autoMerge"]); // approved + clean: Merge and Enable auto-merge (GitHub's), never Slack
    expect(ids("local-idle")).toEqual(["createPr"]); // the worktree has commits of its own
    // Icon-only: no text in the button, the label as its aria-label and in its tooltip.
    for (const q of quick("feat-draft")) {
      const btn = q.querySelector("button")!;
      expect(btn.textContent).toBe("");
      expect(btn.className).toContain("size-7");
      expect(openTip(btn).textContent).toBe(btn.getAttribute("aria-label")!);
      expect(q.closest('[data-slot="tip"]')!.className).not.toContain("max-md:hidden"); // the first two always show
    }
    expect(quick("feat-draft")[1]!.querySelector("button")!.getAttribute("aria-label")).toBe("Address PR");
    // In the Actions cell, gap-1, immediately left of the preview cell, then the ⋯.
    const group = rowOf("feat-draft").querySelector<HTMLElement>('[data-slot="quick-actions"]')!;
    expect(group.className).toContain("gap-1");
    expect(group.nextElementSibling!.querySelector('[data-slot="preview-cell"]') ?? (group.nextElementSibling!.matches('[data-slot="preview-cell"]') ? group.nextElementSibling : null)).not.toBeNull();
    expect(group.parentElement!.querySelector('button[aria-label="Actions"]')).not.toBeNull();
    // The verb runs (the same store verb as the header's) and the row does not navigate.
    await act(async () => { quick("feat-draft")[0]!.querySelector("button")!.click(); await flush(); await flush(); });
    expect(apiFake.calls).toContain("markReady:9");
    expect(location.pathname).toBe("/");
  });

  test("quick actions read the review digest only from the cache: no extra review fetch per row, and a cached unresolved thread makes Address PR the one quick action", async () => {
    apiFake.prsData = [pr({ number: 7, branch: "feat-x", reviewStatus: "approved" })];
    apiFake.agentsData = [];
    apiFake.reviewEvidenceData = [{ id: "T1", path: "src/a.ts", line: 12, author: "alice", body: "Handle null", url: "https://review/T1", resolved: false }];
    store._resetReviewSignals();
    await mount();
    await act(async () => { await flush(); await flush(); });
    // ONE fetch for the row — the review cluster's own lazy one; the buttons only peek at its cache.
    expect(apiFake.reviewSignalCalls).toEqual(["r#7"]);
    expect([...rowOf("feat-x").querySelectorAll<HTMLElement>("[data-quick-action]")].map((q) => q.dataset.quickAction)).toEqual(["addressPr"]); // a person's unresolved thread with no marker counts as a warning
  });

  test("right-click opens the ⋯ menu's own actions at the pointer; Esc and an outside click close it", async () => {
    seed();
    await mount();
    const row = rowOf("feat-ci");
    // The ⋯ menu's items, for comparison.
    await pointerdown(row.querySelector('button[aria-label="Actions"]')!);
    const dots = menuItems(document.body);
    // Address PR and Add preview live in the PR submenu, as on the ⋯.
    expect(dots).toEqual(["Open", "Open PR #8", "Copy branch", "Follow up…", "Rename…", "Hand off…", "PR", "Agent", "Slack", "Close PR"]);
    await key(document.body.querySelector('[role="menu"]')!, "Escape");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    await contextmenu(row);
    const menu = ctxMenu()!;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menuItems(menu)).toEqual(dots);
    expect(menu.className).toContain("shadow-menu"); // Geist's menu token
    const anchor = document.body.querySelector<HTMLElement>('[data-slot="context-anchor"]')!;
    expect(anchor.style.left).toBe("120px");
    expect(anchor.style.top).toBe("40px");
    await key(menu, "Escape");
    expect(ctxMenu()).toBeNull();

    await contextmenu(row);
    expect(ctxMenu()).not.toBeNull();
    await pointerdown(document.body);
    expect(ctxMenu()).toBeNull();
  });

  test("a finger's long-press never opens the right-click menu (a tablet's desktop rows); the mouse's right-click still does", async () => {
    seed();
    await mount();
    const row = rowOf("local-idle");
    await act(async () => { row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
    await contextmenu(row);
    expect(ctxMenu()).toBeNull();
    await act(async () => { row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 2 })); });
    await contextmenu(row);
    expect(ctxMenu()).not.toBeNull();
  });

  test("keyboard: rows are focusable, the menu key opens the same menu, an item runs its action, Enter opens the row", async () => {
    seed();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });
    await mount();
    const row = rowOf("local-idle");
    expect(row.tabIndex).toBe(0);
    row.focus();
    await contextmenu(row, 0, 0); // a keyboard-raised contextmenu has no pointer position
    const menu = ctxMenu()!;
    expect(menu).not.toBeNull();
    expect(menuItems(menu)).toContain("Move to cloud"); // a worktree can move instance
    const copy = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Copy branch")!;
    await act(async () => { copy.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
    expect(copied).toEqual(["local-idle"]);
    expect(ctxMenu()).toBeNull();
    await key(row, "Enter");
    expect(location.pathname).toBe("/r/local/local-idle");
  });
});

// ---- loading skeleton (list + board) ----
// Before the first agents+PRs refresh settles, useWorkstreams() reads [] — indistinguishable from a
// genuinely empty board — so both views must read useWorkstreamsLoaded() to tell "still loading" from
// "loaded, nothing here" and show row/card skeletons (not the empty state) meanwhile. Counts and chip
// badges must hold a placeholder rather than flash 0.
describe("agents loading skeleton", () => {
  test("list view: row skeletons while loading, never the empty state; count and chip badges hold a placeholder, not 0", async () => {
    store._resetWorkstreamsLoaded(); // a module singleton an earlier test's mount() already flipped
    seed();
    apiFake.holdPrs = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container!); root.render(<Agents />); await flush(); });
    void store.refresh(); // fired, not awaited — held on pollPrs until releasePrs()
    await flush();
    const list = container!.querySelector('[data-slot="workstream-list"]')!;
    expect(list.querySelectorAll('[data-slot="workstream-row-skeleton"]').length).toBeGreaterThan(0);
    expect(list.textContent).not.toContain("No agents match");
    // The header still names the columns — only the body is a placeholder.
    expect(list.querySelector('[data-slot="workstream-list-header"]')).not.toBeNull();
    const count = container!.querySelector('[data-slot="agents-count"]')!;
    expect(count.textContent).toBe(""); // a skeleton pill, not "0 of 0"
    expect(count.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    const openChip = container!.querySelector('[data-chip="pr:open"]')!;
    expect(openChip.querySelector('[data-slot="quick-count"]')!.textContent).toBe("");
    expect(openChip.querySelector('[data-slot="quick-count"] [data-slot="skeleton"]')).not.toBeNull();
    await act(async () => { apiFake.releasePrs!(); await flush(); await flush(); });
    expect(list.querySelectorAll('[data-slot="workstream-row-skeleton"]').length).toBe(0);
    expect(container!.querySelector('[data-slot="agents-count"]')!.textContent).toBe("3 of 3"); // seed()'s two agents + one PR
  });

  test("loaded and genuinely empty shows the empty state, never skeletons", async () => {
    apiFake.prsData = [];
    apiFake.agentsData = [];
    await mount();
    expect(container!.querySelector('[data-slot="workstream-row-skeleton"]')).toBeNull();
    expect(container!.textContent).toContain("No agents match");
    expect(container!.querySelector('[data-slot="agents-count"]')!.textContent).toBe("0 of 0");
  });

  test("board view: lane counts hold a placeholder (not 0) and cards are skeletons while loading", async () => {
    store._resetWorkstreamsLoaded();
    seed();
    apiFake.holdPrs = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container!); root.render(<Board />); await flush(); });
    void store.refresh();
    await flush();
    const laneHeader = (title: string) => [...container!.querySelectorAll("h3")].find((h) => h.textContent?.startsWith(title))!;
    const local = laneHeader("Local");
    expect(local.querySelector('[data-slot="skeleton"]')).not.toBeNull(); // the count placeholder
    expect(local.textContent?.trim()).toBe("Local"); // no "0" appended yet
    expect(container!.querySelectorAll('[data-slot="workstream-card-skeleton"]').length).toBeGreaterThan(0);
    await act(async () => { apiFake.releasePrs!(); await flush(); await flush(); });
    expect(container!.querySelectorAll('[data-slot="workstream-card-skeleton"]').length).toBe(0);
    expect(laneHeader("Local").textContent?.trim()).toBe("Local 2"); // seed()'s two local agents, no PR
  });
});
