// E2E for the console shell (App + components/Shell): Vercel's left sidebar — the Orca mark with the
// instance switcher, Find, the nav (Overview, Agents, Repos, Usage, Settings), you at the foot and a
// persisted collapse — and a top bar with the breadcrumb. "/" is the Overview; Agents keeps the
// swimlanes behind a persisted List | Board toggle (with the density toggle beside it on Board).
// Driven against the fake api (tests/apiFake.ts), rendered into a real DOM.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import { getDefaultStore } from "jotai";
import * as store from "@/store";
import { App } from "@/App";
import { agentQueryAtom, boardViewAtom, densityAtom, instanceScopeAtom, sidebarCollapsedAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";

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
  // The atoms outlive localStorage within one run: a dense board left behind here once made later
  // files' cards hide their prompt.
  const s = getDefaultStore();
  s.set(boardViewAtom, "list");
  s.set(densityAtom, "comfortable");
  s.set(sidebarCollapsedAtom, false);
  s.set(instanceScopeAtom, "all");
  s.set(agentQueryAtom, "");
  await act(async () => navigate("/"));
});

const gridEl = () => container!.querySelector(".xl\\:grid-cols-5");
const btnByText = (label: string) =>
  [...container!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const navLabel = (b: Element) => b.querySelector('[data-slot="nav-label"]')?.textContent?.trim();
const navItem = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('nav[aria-label="Main"] button')].find((b) => navLabel(b) === label)!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); }); };
const crumb = () => container!.querySelector('nav[aria-label="Breadcrumb"]')!.textContent;

describe("console shell", () => {
  test("'/' is the Overview: usage, the agents snapshot, instances and recent activity — not the kanban grid", async () => {
    await mount();
    for (const slot of ["usage-card", "agents-card", "recent-activity"]) expect(container!.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    expect(container!.querySelector('[data-slot^="instance-"]')).not.toBeNull();
    expect(gridEl()).toBeNull();
    expect(crumb()).toContain("Overview");
    // The health chip is gone: its numbers live in the instance card now. The header's compact
    // usage meter (views/Vitals.HeaderUsageMeter) is covered end-to-end in usageMeter.test.tsx —
    // here it's simply absent because this test's fake api answers /api/usage with nothing signed in.
    expect(container!.querySelector('[data-slot="header-usage"]')).toBeNull();
    expect(container!.querySelector('[data-slot="instance-health"]')).toBeNull();
  });

  test("the header usage meter sits immediately left of \"Ask the orchestrator\" in the top bar, both right-aligned", async () => {
    apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
    await mount();
    const bar = container!.querySelector<HTMLElement>('[data-slot="topbar"]')!;
    const meter = bar.querySelector('[data-slot="header-usage"]')!;
    const ask = bar.querySelector('[data-slot="ask-orchestrator"]')!;
    expect(meter.nextElementSibling).toBe(ask); // nothing else between them
    const group = ask.parentElement!;
    expect(group.className).toContain("ml-auto"); // the pair, not either one alone, owns the right alignment
    expect(group.parentElement).toBe(bar); // the right-aligned slot is a direct child of the top bar
    expect([...bar.children].at(-1)).toBe(group); // the rightmost thing in the bar
  });

  // The bug this guards: while the app is still loading, HeaderUsageMeter renders nothing (no poll
  // answer yet), and "Ask the orchestrator" used to collapse against the breadcrumbs because it had
  // no stable right-aligning element before it.
  test("\"Ask the orchestrator\" stays right-aligned even while the usage meter has not loaded yet", async () => {
    apiFake.holdUsage = true; // the usage poll never answers — HeaderUsageMeter renders null throughout
    await mount();
    const bar = container!.querySelector<HTMLElement>('[data-slot="topbar"]')!;
    expect(bar.querySelector('[data-slot="header-usage"]')).toBeNull(); // still loading
    const ask = bar.querySelector('[data-slot="ask-orchestrator"]')!;
    const group = ask.parentElement!;
    expect(group.className).toContain("ml-auto");
    expect(group.parentElement).toBe(bar);
    expect([...bar.children].at(-1)).toBe(group); // still the rightmost thing, loaded or not
  });

  // Measured on a cold load (orca-shot, a trace of getBoundingClientRect each frame): the button's
  // left edge moved 1211.2 → 1222.0 when Geist replaced the fallback font, and the page then grew
  // past the viewport, so a classic scrollbar took ~15px off the right. Neither shows in a DOM-only
  // render, so this pins the two rules that hold the button still.
  test("\"Ask the orchestrator\" keeps its place while the page loads: a fixed width, and the scrollbar gutter reserved", async () => {
    await mount();
    const ask = container!.querySelector<HTMLElement>('[data-slot="ask-orchestrator"]')!;
    expect(ask.className.split(/\s+/)).toContain("w-[12.25rem]"); // its width can't follow the font
    const label = ask.querySelector<HTMLElement>('[data-slot="ask-orchestrator-label"]')!;
    expect(label.className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "min-w-0"])); // a wider fallback font can't widen it
    const css = readFileSync(join(import.meta.dir, "..", "web", "src", "styles.css"), "utf8");
    expect(css).toMatch(/html\s*\{\s*scrollbar-gutter:\s*stable;/);
    // Radix's scroll lock would add the reserved gutter again as a body margin on every menu open.
    expect(css).toMatch(/html body\[data-scroll-locked\]\s*\{\s*margin-right:\s*0 !important;/);
  });

  test("the top bar is opaque: a solid background, no translucency or blur for scrolled content to show through", async () => {
    await mount();
    const bar = container!.querySelector<HTMLElement>('[data-slot="topbar"]')!;
    const cls = bar.className.split(/\s+/);
    expect(cls).toContain("bg-background");
    expect(cls).toContain("sticky");
    expect(cls.filter((c) => /^bg-background\/|^backdrop-blur/.test(c))).toEqual([]);
  });

  test("the sidebar: Orca mark + instance switcher, Find, the five pages, and the active one marked", async () => {
    await mount();
    const sidebar = container!.querySelector('[data-slot="sidebar"]')!;
    expect(sidebar.querySelector("svg")).not.toBeNull(); // the orca mark
    expect(sidebar.textContent).toContain("Orca");
    expect(sidebar.querySelector('[data-slot="instance-scope"]')!.textContent).toBe("All instances"); // two instances in the fake config
    expect(sidebar.querySelector('input[aria-label="Find agents"]')).not.toBeNull();
    const items = [...sidebar.querySelectorAll('nav[aria-label="Main"] button')].map(navLabel);
    expect(items).toEqual(["Overview", "Agents", "Previews", "Repos", "GitHub", "Handoffs", "Usage", "Settings"]);
    expect(navItem("Overview").getAttribute("aria-current")).toBe("page");
    for (const [label, path, slot] of [["Agents", "/agents", "workstream-list"], ["Repos", "/repos", "repos-list"], ["GitHub", "/github", "github-accounts"], ["Usage", "/usage", "usage-card"], ["Settings", "/settings", "settings-appearance"]] as const) {
      await click(navItem(label));
      expect(location.pathname).toBe(path);
      expect(navItem(label).getAttribute("aria-current")).toBe("page");
      expect(crumb()).toContain(label);
      expect(container!.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
  });

  test("the instance switcher scopes the pages to one machine, and remembers it", async () => {
    await mount();
    getDefaultStore().set(instanceScopeAtom, "cloud");
    await act(flush);
    expect(container!.querySelector('[data-slot="instance-scope"]')!.textContent).toBe("cloud");
    // The Overview now shows that machine's card only.
    expect(container!.querySelector('[data-slot="instance-cloud"]')).not.toBeNull();
    expect(container!.querySelector('[data-slot="instance-laptop"]')).toBeNull();
    expect(localStorage.getItem("orca.ui.v1.instanceScope")).toBe('"cloud"');
  });

  test("Find: typing filters the Agents list (going there), and 'F' focuses it from anywhere", async () => {
    await mount();
    const find = container!.querySelector<HTMLInputElement>('input[aria-label="Find agents"]')!;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await flush();
    });
    expect(document.activeElement).toBe(find);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "gauge");
      find.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    expect(location.pathname).toBe("/agents");
    expect(container!.querySelector<HTMLInputElement>('input[aria-label="Search workstreams"]')!.value).toBe("gauge"); // one query, shared
  });

  test("the sidebar's foot: Add New is the last action, above the divider; you on ONE thin line below it; collapsed, the expand button sits above you", async () => {
    await mount();
    const profile = container!.querySelector<HTMLElement>('[data-slot="profile"]')!;
    expect(profile.className).toContain("h-8"); // one line, not a two-line block
    expect(profile.textContent).toBe("Youlaptop"); // "You", a dot, then the machine
    const actions = container!.querySelector<HTMLElement>('[data-slot="sidebar-actions"]')!;
    const foot = container!.querySelector<HTMLElement>('[data-slot="sidebar-foot"]')!;
    expect(actions.querySelector('[data-slot="add-new"]')).not.toBeNull();
    expect(actions.nextElementSibling).toBe(foot); // straight above the divider (the foot's border-t) and you
    expect(foot.className).toContain("border-t");
    expect(foot.querySelector('[data-slot="add-new"]')).toBeNull();
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    const you = container!.querySelector<HTMLElement>('[data-slot="sidebar-you"]')!;
    expect(you.className).toContain("md:flex-col-reverse"); // the toggle renders above the avatar
    expect(you.lastElementChild!.querySelector("button")!.getAttribute("aria-label")).toBe("Expand sidebar"); // the toggle, now wrapped in its tooltip
    expect(container!.querySelector('[data-slot="sidebar-actions"] [data-slot="add-new"]')!.getAttribute("aria-label")).toBe("Add New"); // an icon now
  });

  test("the sidebar collapses to icons and stays collapsed across a reload", async () => {
    await mount();
    await click(container!.querySelector('button[aria-label="Collapse sidebar"]')!);
    expect(container!.querySelector('[data-slot="sidebar"]')!.getAttribute("data-collapsed")).toBe("true");
    expect(localStorage.getItem("orca.ui.v1.sidebarCollapsed")).toBe("true");
    act(() => root?.unmount());
    container?.remove();
    await mount();
    expect(container!.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull();
  });

  test("Agents: the List | Board toggle swaps the view and is remembered across a reload", async () => {
    navigate("/agents");
    await mount();
    expect(btnByText("List")!.getAttribute("aria-pressed")).toBe("true");
    await click(btnByText("Board")!);
    expect(gridEl()).not.toBeNull(); // the swimlanes
    expect(container!.querySelector('[data-slot="workstream-list"]')).toBeNull();
    expect(localStorage.getItem("orca.ui.v1.agents.view")).toBe('"board"');
    // A fresh mount (a reload) keeps the choice.
    act(() => root?.unmount());
    container?.remove();
    await mount();
    expect(btnByText("Board")!.getAttribute("aria-pressed")).toBe("true");
    expect(gridEl()).not.toBeNull();
    await click(btnByText("List")!);
    expect(localStorage.getItem("orca.ui.v1.agents.view")).toBe('"list"');
    expect(gridEl()).toBeNull();
  });

  test("the density toggle (Board view only) flips comfortable ⇄ dense (aria-pressed + persisted)", async () => {
    navigate("/agents");
    await mount();
    expect(container!.querySelector('button[aria-label^="Switch to"]')).toBeNull(); // the list has no cards to densify
    await click(btnByText("Board")!);
    const toggle = container!.querySelector<HTMLButtonElement>('button[aria-label^="Switch to"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false"); // comfortable by default
    await act(async () => { toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("orca.ui.v1.density")).toBe('"dense"');
  });
});
