// The phone layout and the PWA. Pure decisions first (Enter on touch, preview links seen from a phone,
// staleness, a newer build), then the installable-app files, then the App rendered as a 390px touch
// screen (window.matchMedia answering the phone's media queries) against the fake api — and the same
// App as a desktop, which must show none of it.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { getDefaultStore } from "jotai";
import { orchestratorOpenAtom } from "@/lib/atoms";
import { COARSE_QUERY, NARROW_QUERY, enterSends, expandTruncatedOnTap, keepComposerFocus, keyboardOpen, trackVisualViewport } from "@/lib/viewport";
import { poll } from "@/lib/poll";
import { PULL_REFRESH_PX, pullState, swipeArm, swipeDecision, swipeOffset, STALE_AFTER_MS, launchOverlay, newerBuild, previewHref, previewLabel, staleAge } from "@/workstream";
import { themeColor } from "@/lib/theme";
import { UpdateBanner } from "@/components/Freshness";
import { SHEET_CLOSE_MS } from "@/components/BottomSheet";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);

describe("phone decisions (pure)", () => {
  test("Enter sends with a keyboard; on a touch screen it is a newline and the button sends", () => {
    const plain = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
    expect(enterSends(plain, false)).toBe(true);
    expect(enterSends({ ...plain, shiftKey: true }, false)).toBe(false);
    expect(enterSends({ ...plain, isComposing: true }, false)).toBe(false);
    expect(enterSends(plain, true)).toBe(false);
  });

  test("a preview link never points a phone at its own localhost", () => {
    // An owner with no ORCA_PREVIEW_HOST hands out localhost; seen over the tailnet, the page's host wins.
    expect(previewHref({ url: "http://localhost:5199" }, "orca-box.tail622bd5.ts.net")).toBe("http://orca-box.tail622bd5.ts.net:5199");
    expect(previewHref({ url: "http://127.0.0.1:5199/app/" }, "100.64.0.7")).toBe("http://100.64.0.7:5199/app/");
    // Unchanged: the tailnet url stays; the laptop's own page still opens its loopback.
    expect(previewHref({ url: "http://orca-box:9001" }, "orca-box")).toBe("http://orca-box:9001");
    expect(previewHref({ url: "http://orca-box:9001", localUrl: "http://localhost:9001" }, "localhost")).toBe("http://localhost:9001");
    expect(previewLabel("http://orca-box.tail622bd5.ts.net:5199")).toBe("orca-box.tail622bd5.ts.net:5199");
  });

  test("stale: only once the board has loaded and gone unanswered past the threshold", () => {
    expect(staleAge(0, 10_000_000)).toBeNull(); // nothing loaded yet is "loading", not stale
    expect(staleAge(1_000, 1_000 + STALE_AFTER_MS)).toBeNull();
    expect(staleAge(1_000, 1_000 + STALE_AFTER_MS + 5)).toBe(STALE_AFTER_MS + 5);
  });

  test("a newer build: a different served id; never in dev or on a garbled answer", () => {
    expect(newerBuild("2026-10-13T07:00:00Z", { build: "2026-10-13T08:00:00Z" })).toBe(true);
    expect(newerBuild("2026-10-13T07:00:00Z", { build: "2026-10-13T07:00:00Z" })).toBe(false);
    expect(newerBuild("dev", { build: "x" })).toBe(false);
    expect(newerBuild(undefined, { build: "x" })).toBe(false);
    expect(newerBuild("a", "<html>")).toBe(false);
  });
});

describe("installable app (PWA files)", () => {
  const read = (p: string) => Bun.file(new URL(`../web/${p}`, import.meta.url));
  const pngSize = async (p: string) => { const b = new DataView(await read(p).arrayBuffer()); return [b.getUint32(16), b.getUint32(20)]; };

  test("manifest: standalone, themed, with home-screen icons that exist at their stated sizes", async () => {
    const m = await read("public/manifest.webmanifest").json() as { display: string; theme_color: string; start_url: string; icons: { src: string; sizes: string; purpose?: string }[] };
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    for (const icon of m.icons.filter((i) => i.src.endsWith(".png"))) {
      const [w, h] = await pngSize(`public${icon.src}`);
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    expect(await pngSize("public/apple-touch-icon.png")).toEqual([180, 180]);
  });

  test("maskable icon: its own file, full-bleed, the whole mark inside the 80% safe zone", async () => {
    const m = await read("public/manifest.webmanifest").json() as { icons: { src: string; sizes: string; purpose?: string }[] };
    const maskable = m.icons.filter((i) => i.purpose === "maskable");
    expect(maskable.map((i) => i.src)).toEqual(["/icon-maskable-512.png"]); // never the round "any" icon, which Android would crop
    expect(m.icons.filter((i) => i.purpose !== "maskable").map((i) => i.src)).not.toContain("/icon-maskable-512.png");
    expect(await pngSize("public/icon-maskable-512.png")).toEqual([512, 512]);
    const svg = await read("public/icon-maskable.svg").text();
    expect(svg).toContain('<rect width="24" height="24" fill="#000" />'); // full bleed
    const [, tx, ty, k] = svg.match(/translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/)!.map(Number);
    // The mark's path spans x 2…22.5, y 3…15.5; every corner of that box must fall within r = 0.4 × 24.
    for (const [x, y] of [[2, 3], [22.5, 3], [2, 15.5], [22.5, 15.5]]) expect(Math.hypot(tx! + k! * x! - 12, ty! + k! * y! - 12)).toBeLessThanOrEqual(9.6);
  });

  test("manifest polish: an id, any orientation, the theme tokens' colours, shortcuts the app understands", async () => {
    const m = await read("public/manifest.webmanifest").json() as {
      id: string; orientation: string; theme_color: string; background_color: string;
      user_preferences: { color_scheme_dark: { theme_color: string; background_color: string } };
      shortcuts: { name: string; url: string }[];
    };
    expect(m.id).toBe("/");
    expect(m.orientation).toBe("any");
    expect([themeColor(false), themeColor(true)]).toEqual(["#f9f9f8", "#111111"]); // PR 134's --background tokens
    expect([m.theme_color, m.background_color]).toEqual([themeColor(false), themeColor(false)]);
    const html = await read("index.html").text();
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${themeColor(false)}" />`);
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${themeColor(true)}" />`);
    expect(m.user_preferences.color_scheme_dark).toEqual({ theme_color: themeColor(true), background_color: themeColor(true) });
    expect(m.shortcuts.map((s) => [s.name, launchOverlay(new URL(s.url, "http://x").search)])).toEqual([["New agent", "new"], ["Orchestrator", "orchestrator"]]);
    expect(launchOverlay("?open=nope")).toBeNull();
  });

  test("installed-app feel: standalone CSS stops overscroll, tap delay and highlight, chrome selection; touch gets pressed states", async () => {
    const css = await read("src/styles.css").text();
    const block = (open: string) => { const i = css.indexOf(open); expect(i).toBeGreaterThan(-1); let depth = 0, j = css.indexOf("{", i); const start = j; for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) break; } return css.slice(start, j); };
    const standalone = block("@media (display-mode: standalone)");
    for (const decl of ["overscroll-behavior: none", "touch-action: manipulation", "-webkit-tap-highlight-color: transparent", "user-select: none", "-webkit-touch-callout: none"]) expect(standalone).toContain(decl);
    expect(standalone).toMatch(/:where\(input, textarea, \[contenteditable="true"\]\) \{\s*-webkit-user-select: text;\s*user-select: text;/); // fields stay editable
    expect(standalone).not.toMatch(/\bmain\b|\.prose|body \{[^}]*user-select/); // content stays selectable
    const touch = block("@media (hover: none)");
    expect(touch).toContain(":active");
    expect(touch).toContain("currentColor");
  });

  // Finn: the repos selector opened as a bottom sheet on a phone, and the top bar vanished while it
  // was open. Menus and selects now anchor under their trigger (only BottomSheet.tsx is a sheet), and
  // Radix's scroll lock may not turn the body into a scroll container that takes the sticky bar away.
  test("phone CSS: menus and selects anchor like desktop, and a scroll lock keeps the top bar in place", async () => {
    const css = await read("src/styles.css").text();
    const i = css.indexOf("@media (max-width: 767px) {");
    let depth = 0, j = css.indexOf("{", i);
    for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) break; }
    const phone = css.slice(i, j);
    expect(phone).not.toMatch(/inset:\s*auto 0 0 0/); // nothing pins the popper wrapper to the foot
    expect(phone).not.toMatch(/border-radius:\s*12px 12px 0 0/);
    expect(phone).toMatch(/html body\[data-scroll-locked\]\s*\{\s*overflow-x:\s*clip !important;\s*overflow-y:\s*visible !important;/);
  });

  test("index.html: manifest, theme-color per scheme, Apple tags, safe-area viewport", async () => {
    const html = await read("index.html").text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: light\)"/);
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)"/);
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" />');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain("viewport-fit=cover");
  });

  test("favicon is round, like Vercel's: a black circle with the white mark", async () => {
    expect(await read("public/favicon.svg").text()).toContain("<circle");
  });

  test("home-screen icon survives iOS tinted mode: full-bleed black tile, no white background or inner circle, mark in the safe zone", async () => {
    // iOS derives a tinted/dark-mode variant from the image's luminance with no say from the app —
    // a white tile or a black circle on white comes out as a near-invisible grey blob once tinted.
    const svg = await read("public/icon.svg").text();
    expect(svg).not.toContain("<circle");
    expect(svg).not.toContain('fill="#fff" />'); // no white tile behind the mark
    expect(svg).toContain('<rect width="24" height="24" fill="#000" />'); // full bleed, like icon-maskable.svg
    const [, tx, ty, k] = svg.match(/translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/)!.map(Number);
    // The mark's path spans x 2…22.5, y 3…15.5; every corner of that box must fall within r = 0.4 × 24.
    for (const [x, y] of [[2, 3], [22.5, 3], [2, 15.5], [22.5, 15.5]]) expect(Math.hypot(tx! + k! * x! - 12, ty! + k! * y! - 12)).toBeLessThanOrEqual(9.6);
  });
});

describe("polling", () => {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  afterEach(() => { visibility = "visible"; });

  test("hidden: nothing is fetched; shown again: it fetches at once, not a tick later", async () => {
    let calls = 0;
    visibility = "hidden";
    const stop = poll(() => { calls++; }, 60_000);
    await Bun.sleep(10);
    expect(calls).toBe(0);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Bun.sleep(10);
    expect(calls).toBe(1);
    stop();
  });
});

// ---- the App on a phone and on a desktop ----

const realMatchMedia = window.matchMedia;
function emulate(phone: boolean, on = phone ? [NARROW_QUERY, COARSE_QUERY] : []) {
  window.matchMedia = ((q: string) => ({ matches: on.includes(q), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(path: string, phone: boolean, queries?: string[]) {
  emulate(phone, queries);
  apiFake.agentsData = [
    { branch: "feat-phone", worktreePath: "/wt/feat-phone", agentStatus: "error", agentError: "rate limited", agentStartedAt: Date.now() - 60_000, agentFinishedAt: Date.now() - 30_000 },
  ];
  navigate(path);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
}
afterEach(async () => {
  window.matchMedia = realMatchMedia;
  act(() => { getDefaultStore().set(orchestratorOpenAtom, false); });
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  localStorage.clear();
  navigate("/");
});
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await flush(); await flush(); }); };

describe("the phone layout (390px, touch)", () => {
  test("a bottom bar within thumb reach; the top bar trades its Ask box for the round mark, with no hamburger", async () => {
    apiFake.usageData = { claude: { fiveHour: { utilization: 38, resetsAt: null }, sevenDay: { utilization: 55, resetsAt: null }, extra: null }, codex: null };
    await mount("/", true);
    const bar = $('[data-slot="bottom-bar"]')!;
    const items = [...bar.querySelectorAll("button")];
    expect(items.map((b) => b.textContent)).toEqual(["Overview", "Agents", "New agent", "Orchestrator", "Settings"]);
    expect(bar.className).toContain("md:hidden"); // never on a desktop-width screen
    expect(bar.className).toContain("safe-area-inset-bottom");
    expect($('[data-slot="topbar-mark"]')!.className).toContain("md:hidden");
    expect($('[data-slot="ask-orchestrator"]')!.className).toContain("max-md:hidden");
    expect($('[data-slot="header-usage"]')!.className).toContain("max-md:hidden"); // doesn't fit the phone's top bar either
    expect($('[data-slot="quick-ask"]')!.className).toContain("max-md:hidden"); // …and the pill folds into the bottom bar's Orchestrator
    expect($('button[aria-label="Open menu"]')).toBeNull(); // no hamburger — Overview replaced it in the bar
    expect($('[data-slot="sidebar"]')!.className).toContain("max-md:hidden"); // the off-canvas drawer is gone too
    // Overview is current on "/"; New agent is the centred, third of five items.
    expect(items[0]!.getAttribute("aria-current")).toBe("page");
    expect(items[2]!.textContent).toBe("New agent");
    await click(items.find((b) => b.textContent === "Agents")!);
    expect(location.pathname).toBe("/agents");
    expect(items[0]!.getAttribute("aria-current")).toBeNull();
  });

  // Regression: the dialog used to render inside the sidebar's hidden-on-phone <aside> (max-md:hidden).
  // A browser never promotes a <dialog> to the top layer while an ancestor has display: none, so
  // showModal() opened it with nothing on screen even though .open read true. It must now sit
  // outside that <aside> (Shell.AddNew portals it to document.body) so it shows on a phone too.
  test("the bottom bar's New agent opens Add New outside the hidden sidebar, so it is visible on a phone", async () => {
    await mount("/", true);
    const sidebar = $('[data-slot="sidebar"]')!;
    expect(sidebar.className).toContain("max-md:hidden");
    const bar = $('[data-slot="bottom-bar"]')!;
    await click([...bar.querySelectorAll("button")].find((b) => b.textContent === "New agent")!);
    const dialog = $<HTMLDialogElement>('dialog[data-slot="add-new-dialog"]')!;
    expect(dialog.open).toBe(true);
    expect(sidebar.contains(dialog)).toBe(false); // never a descendant of the hidden aside
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog.querySelector("textarea")).not.toBeNull(); // the New-draft composer renders inside it
  });

  test("the bottom bar's Settings navigates to /settings and is marked current there", async () => {
    await mount("/", true);
    const bar = $('[data-slot="bottom-bar"]')!;
    const settings = [...bar.querySelectorAll("button")].find((b) => b.textContent === "Settings")!;
    expect(settings.getAttribute("aria-current")).toBeNull();
    await click(settings);
    expect(location.pathname).toBe("/settings");
    expect(settings.getAttribute("aria-current")).toBe("page");
  });

  test("Settings on a phone carries what the old hamburger drawer exposed that isn't in the bottom bar: Find, the instance switcher, and links to Previews/Repos/GitHub/Usage", async () => {
    await mount("/settings", true);
    const nav = $('[data-slot="settings-mobile-nav"]')!;
    expect(nav.className).toContain("md:hidden");
    expect(nav.querySelector('input[aria-label="Find agents"]')).not.toBeNull();
    expect(nav.querySelector('[role="group"][aria-label="Instance"]')).not.toBeNull();
    const links = [...nav.querySelectorAll('nav[aria-label="More pages"] button')].map((b) => b.textContent);
    expect(links).toEqual(["Inbox", "Previews", "Repos", "GitHub", "Usage"]);
    await click(nav.querySelectorAll('nav[aria-label="More pages"] button')[2]!); // Repos
    expect(location.pathname).toBe("/repos");
  });

  test("Agents: rows stack with the instruction, error and branch on screen; one ⋯ per row; filters in a sheet", async () => {
    await mount("/agents", true);
    expect($('[data-slot="workstream-list-header"]')).toBeNull();
    const row = $('[data-branch="feat-phone"]')!;
    expect(row.dataset.layout).toBe("stacked");
    expect(row.style.gridTemplateColumns).toBe("");
    expect(row.querySelector('[data-slot="row-error"]')!.textContent).toBe("rate limited");
    expect(row.textContent).toContain("feat-phone"); // the branch, which desktop keeps in a hover title
    expect(row.querySelectorAll('button[aria-haspopup="menu"]')).toHaveLength(1); // every action in one menu
    expect($('[role="group"][aria-label="Quick filters"]')).toBeNull(); // the chips are in the sheet, not the page
    await click($('[data-slot="filters-button"]')!);
    const sheet = $<HTMLDialogElement>('dialog[data-slot="filter-sheet"]')!;
    expect(sheet.open).toBe(true);
    expect(sheet.querySelectorAll('[data-slot="quick-filter"]').length).toBeGreaterThan(0);
    await click(sheet.querySelector('[data-slot="quick-filter"][data-chip="status:attention"]')!);
    expect(location.search).toContain("status=attention");
    expect($('[data-slot="filters-active"]')!.textContent).toBe("1");
  });

  test("Agents at 390px: a PR row is a taller card — title+status on line 1, branch/model/PR/preview/diffstat on line 2, the ⋯ off to the side (no fixed-width columns, nothing sits under it)", async () => {
    apiFake.prsData = [{
      number: 12, title: "feat wide", branch: "feat-wide", url: "https://x/12", state: "OPEN", isDraft: false,
      ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false,
      additions: 42, deletions: 9,
    }];
    await mount("/agents", true);
    const row = $('[data-branch="feat-wide"]')!;
    expect(row.dataset.layout).toBe("stacked");
    // No fixed-width columns on a phone: no inline grid template, no arbitrary min-width class.
    expect(row.style.gridTemplateColumns).toBe("");
    expect(row.querySelector('[class*="min-w-["]')).toBeNull();
    const cells = [...row.querySelectorAll('[role="cell"]')];
    const [line1, line2, line3] = cells;
    // Line 1: title and status share the row.
    expect(line1!.textContent).toContain("feat wide");
    expect(line1!.querySelector('[data-slot="run-status"]')).not.toBeNull();
    // Line 2: branch, model, PR, preview info, diffstat — none of that spills into line 1 or line 3.
    expect(line2!.textContent).toContain("feat-wide");
    expect(line2!.querySelector('a[data-slot="pr-link"]')).not.toBeNull();
    expect(line2!.querySelector('[data-slot="pr-preview-inline"]')).not.toBeNull();
    expect(line2!.querySelector('[data-slot="diffstat"]')!.textContent).toBe("+42 −9");
    expect(line1!.querySelector('[data-slot="diffstat"]')).toBeNull();
    expect(line2!.querySelector('[data-slot="state-pill"]')).toBeNull();
    // The state pill and PR condition badges are their own wrapping line, after line 2.
    expect(line3!.querySelector('[data-slot="state-pill"]')).not.toBeNull();
    // The ⋯ menu sits at the end of the badges line (next to the state pill/PR chips), not in a
    // dedicated trailing column that would squeeze the title/branch text — and never absolutely
    // positioned over it.
    expect(row.className).not.toContain("relative");
    const menuButton = row.querySelector<HTMLElement>('button[aria-label="Actions"]')!;
    expect(menuButton.closest('[class*="absolute"]')).toBeNull();
    expect(line3!.contains(menuButton)).toBe(true);
  });

  test("Agents at 390px: quick actions + ⋯ sit on the badges line, not a squeezing trailing column", async () => {
    apiFake.prsData = [{
      number: 12, title: "feat wide", branch: "feat-wide", url: "https://x/12", state: "OPEN", isDraft: false,
      ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", autoMergeEnabled: false,
      additions: 42, deletions: 9,
    }];
    await mount("/agents", true);
    const row = $('[data-branch="feat-wide"]')!;
    // There is exactly one trailing <div> directly under the row — the content column itself. No
    // second, shrink-0 column holding the quick actions/⋯ menu beside it: that fixed-width column
    // (with a forced 44px touch target on the Actions button) used to squeeze the title/branch text
    // into a narrow strip that truncated badly.
    const directDivs = [...row.children].filter((c) => c.tagName === "DIV");
    expect(directDivs).toHaveLength(1);
    expect(directDivs[0]!.className).toContain("flex-1");
    const menuButton = row.querySelector<HTMLElement>('button[aria-label="Actions"]')!;
    const quickButton = row.querySelector<HTMLElement>("[data-quick-action]")!;
    expect(directDivs[0]!.contains(menuButton)).toBe(true);
    expect(directDivs[0]!.contains(quickButton)).toBe(true);
    // Both sit on the badges line, next to the state pill — not off in their own dedicated column.
    const badgesLine = [...row.querySelectorAll('[role="cell"]')].find((c) => c.querySelector('[data-slot="state-pill"]'))!;
    expect(badgesLine.contains(menuButton)).toBe(true);
    expect(badgesLine.contains(quickButton)).toBe(true);
    // Condensed: icon-only, no forced oversized touch target on the Actions button.
    expect(menuButton.className).not.toContain("size-11");
    expect(menuButton.querySelector("svg")).not.toBeNull();
    expect(menuButton.textContent?.trim()).toBe("");
  });

  test("the orchestrator opens as a routed page, not the overlay panel: no drag, resize or pop out", async () => {
    await mount("/", true);
    expect(getDefaultStore().get(orchestratorOpenAtom)).toBe(false);
    await click([...$('[data-slot="bottom-bar"]')!.querySelectorAll("button")].find((b) => b.textContent === "Orchestrator")!);
    await act(async () => { await flush(); await flush(); });
    expect(location.pathname).toBe("/orchestrator");
    expect(getDefaultStore().get(orchestratorOpenAtom)).toBe(false); // the side panel never opens on a phone
    expect($('[data-slot="orchestrator-panel"]')).toBeNull();
    const page = $('[data-slot="orchestrator-page"]')!;
    expect(page).not.toBeNull();
    expect(page.querySelector("textarea")).not.toBeNull(); // the composer, in the page itself
    expect(page.querySelector('[data-slot="chat-panel"]')).not.toBeNull(); // the one chat every surface renders
    expect(document.querySelectorAll('[data-slot="orchestrator-resize"]')).toHaveLength(0);
    expect(document.querySelector('[aria-label="Pop out"]')).toBeNull();
    // The bottom bar marks it the current destination, like Agents does.
    const button = [...$('[data-slot="bottom-bar"]')!.querySelectorAll("button")].find((b) => b.textContent === "Orchestrator")!;
    expect(button.getAttribute("aria-current")).toBe("page");
  });

  test("no autofocus on mobile: opening the orchestrator page or the New-draft dialog never pops the keyboard", async () => {
    await mount("/", true);
    await click([...$('[data-slot="bottom-bar"]')!.querySelectorAll("button")].find((b) => b.textContent === "Orchestrator")!);
    await act(async () => { await flush(); await flush(); });
    const page = $('[data-slot="orchestrator-page"]')!;
    expect(document.activeElement).not.toBe(page.querySelector("textarea"));
    await click([...$('[data-slot="bottom-bar"]')!.querySelectorAll("button")].find((b) => b.textContent === "New agent")!);
    await act(async () => { await flush(); await flush(); });
    const dialog = $<HTMLDialogElement>('dialog[data-slot="add-new-dialog"]')!;
    expect(dialog.open).toBe(true);
    expect(document.activeElement).not.toBe(dialog.querySelector("textarea"));
  });

  test("the orchestrator page's own scroller holds the conversation; its back arrow returns to the previous page", async () => {
    await mount("/agents", true);
    await click([...$('[data-slot="bottom-bar"]')!.querySelectorAll("button")].find((b) => b.textContent === "Orchestrator")!);
    await act(async () => { await flush(); await flush(); });
    const page = $('[data-slot="orchestrator-page"]')!;
    // The chat's own div is the thing that scrolls — nothing about the page wraps it in a second one.
    expect(page.querySelector(".overflow-y-auto")).not.toBeNull();
    await click($('[aria-label="Back"]')!);
    await act(async () => { await flush(); await flush(); });
    expect(location.pathname).toBe("/agents");
  });

  test("the orchestrator page on a phone: edge-to-edge dividers, even 12px padding, a compact Send", async () => {
    await mount("/", true);
    await click([...$('[data-slot="bottom-bar"]')!.querySelectorAll("button")].find((b) => b.textContent === "Orchestrator")!);
    await act(async () => { await flush(); await flush(); });
    const page = $('[data-slot="orchestrator-page"]')!;
    const cls = (el: Element) => el.className.split(/\s+/);
    // Bleeds out of <main>'s padding, so the header's and composer's borders reach both edges, and
    // ends at the bottom bar's top — main's bottom padding (which holds the safe area) is cancelled,
    // not added to, and the bar's own max(…, safe-area) is the only inset left.
    expect(cls(page)).toContain("max-md:-mx-[max(1rem,env(safe-area-inset-left))]");
    expect(cls(page)).toContain("max-md:-mt-6");
    expect(cls(page)).toContain("max-md:-mb-[calc(5.5rem+env(safe-area-inset-bottom))]");
    expect(page.className).toContain("max(0.375rem,env(safe-area-inset-bottom))");
    // With the keyboard up it is pinned to the visible area instead (styles.css, data-keyboard-fill).
    expect(page.hasAttribute("data-keyboard-fill")).toBe(true);
    // Header, conversation and composer: the same 12px all round.
    const header = page.querySelector('[data-slot="orchestrator-page-header"]')!;
    expect(cls(header)).toEqual(expect.arrayContaining(["border-b", "max-md:p-3"]));
    expect(cls(page.querySelector('[data-slot="chat-composer-dock"]')!)).toEqual(expect.arrayContaining(["border-t", "max-md:p-3"]));
    expect(cls(page.querySelector(".overflow-y-auto")!)).toContain("p-3");
    // Send: a 28px filled chip in a transparent, still-44px touch target; desktop keeps the size-8 square.
    const send = page.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    expect(cls(send)).toEqual(expect.arrayContaining(["size-8", "max-md:bg-transparent", "pointer-coarse:max-md:min-w-11"]));
    expect(cls(send.querySelector("span")!)).toEqual(expect.arrayContaining(["max-md:size-7", "max-md:bg-primary"]));
  });

  test("on a touch screen Enter in the composer is a newline, not a send", async () => {
    await mount("/", true);
    act(() => { getDefaultStore().set(orchestratorOpenAtom, true); });
    await act(async () => { await flush(); await flush(); });
    const box = document.querySelector<HTMLTextAreaElement>('[data-slot="orchestrator-panel"] textarea')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(box, "line one");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { box.dispatchEvent(enter); await flush(); });
    expect(enter.defaultPrevented).toBe(false); // left to the textarea: a newline
    expect(apiFake.orchestratorMessages).toHaveLength(0);
  });

  test("truncated text opens on tap, and closes again", async () => {
    emulate(true);
    const off = expandTruncatedOnTap();
    const el = document.createElement("span");
    el.className = "truncate";
    Object.defineProperty(el, "scrollWidth", { value: 300 });
    Object.defineProperty(el, "clientWidth", { value: 100 });
    document.body.appendChild(el);
    el.click();
    expect(el.dataset.expanded).toBe("true");
    el.click();
    expect(el.dataset.expanded).toBeUndefined();
    off(); el.remove();
  });

  test("the visible viewport's height reaches CSS (the sheets size to it, above the keyboard)", () => {
    const vv = Object.assign(new EventTarget(), { height: 512.4, offsetTop: 40 });
    const fake = { visualViewport: vv, document } as unknown as Window;
    const off = trackVisualViewport(fake);
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("512px");
    vv.height = 300;
    vv.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("300px");
    expect(document.documentElement.style.getPropertyValue("--vv-top")).toBe("40px");
    off();
  });
  test("the keyboard is a visible area well short of the layout viewport, never a toolbar or a pinch zoom", () => {
    expect(keyboardOpen({ layoutHeight: 844, height: 844 })).toBe(false);
    expect(keyboardOpen({ layoutHeight: 844, height: 790 })).toBe(false); // Safari's bars collapsing
    expect(keyboardOpen({ layoutHeight: 844, height: 508 })).toBe(true); // iPhone keyboard (+ its bar)
    expect(keyboardOpen({ layoutHeight: 844, height: 400, scale: 2 })).toBe(false); // zoomed in, no keyboard
  });

  test("the keyboard opening marks <html> (bottom bar aside, chat pinned above it) and closing clears it", () => {
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    const fake = { visualViewport: vv, document, innerHeight: 844 } as unknown as Window;
    const root = document.documentElement;
    const off = trackVisualViewport(fake);
    expect(root.dataset.keyboard).toBeUndefined();
    Object.assign(vv, { height: 508, offsetTop: 120 });
    vv.dispatchEvent(new Event("resize"));
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--vvh")).toBe("508px");
    expect(root.style.getPropertyValue("--vv-top")).toBe("120px");
    Object.assign(vv, { height: 844, offsetTop: 0 });
    vv.dispatchEvent(new Event("resize"));
    expect(root.dataset.keyboard).toBeUndefined();
    vv.height = 508; vv.dispatchEvent(new Event("resize"));
    off();
    expect(root.dataset.keyboard).toBeUndefined(); // never left behind
  });

  test("the pinned chat follows the keyboard, not the focus: kept through a blur, let go (scroll restored) once it has closed", async () => {
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    const scrolls: number[] = [];
    const fake = { visualViewport: vv, document, innerHeight: 844, scrollX: 0, scrollY: 0, scrollTo: (_x: number, y: number) => { scrolls.push(y); fake.scrollY = y; } };
    const fill = document.createElement("div");
    fill.setAttribute("data-keyboard-fill", "");
    const box = document.createElement("textarea");
    const send = document.createElement("button");
    fill.append(box, send);
    const other = document.createElement("input");
    document.body.append(fill, other);
    const off = trackVisualViewport(fake as unknown as Window);
    const resize = (height: number) => { vv.height = height; vv.dispatchEvent(new Event("resize")); };

    box.focus(); // the tap: marked at once, so the pin lands with the keyboard's first resize
    expect(fill.hasAttribute("data-keyboard-owner")).toBe(true);
    fake.scrollY = 300; // iOS scrolls the page to reveal the field
    resize(508);
    expect(document.documentElement.dataset.keyboard).toBe("open");
    send.focus(); // a button taking focus is not a new field
    box.blur();
    expect(fill.hasAttribute("data-keyboard-owner")).toBe(true); // still pinned while the keyboard is up
    resize(844);
    expect(fill.hasAttribute("data-keyboard-owner")).toBe(false); // one move, when it has closed
    expect(scrolls).toEqual([0]); // and the page is back where it was

    box.focus(); resize(508);
    other.focus(); // a field outside any chat takes the keyboard: the chat lets go
    expect(fill.hasAttribute("data-keyboard-owner")).toBe(false);
    resize(844);

    // The keyboard reopening over a field that kept its focus (no focusin) still pins its chat.
    box.focus(); resize(508); resize(844);
    expect(document.activeElement).toBe(box);
    resize(508);
    expect(fill.hasAttribute("data-keyboard-owner")).toBe(true);
    off();
    expect(fill.hasAttribute("data-keyboard-owner")).toBe(false);
    fill.remove(); other.remove();
  });

  test("styles.css pins the keyboard's owner, never whatever holds the focus", async () => {
    const css = await Bun.file(new URL("../web/src/styles.css", import.meta.url)).text();
    expect(css).toContain("html[data-keyboard] [data-keyboard-fill][data-keyboard-owner] {");
    expect(css).not.toContain("[data-keyboard-fill]:focus-within");
  });

  test("tapping Send with the composer focused sends once and keeps the focus (and the keyboard) in the box", async () => {
    await mount("/", true);
    await click([...$('[data-slot="bottom-bar"]')!.querySelectorAll("button")].find((b) => b.textContent === "Orchestrator")!);
    await act(async () => { await flush(); await flush(); });
    const page = $('[data-slot="orchestrator-page"]')!;
    const box = page.querySelector("textarea")!;
    box.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "ship it");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    const send = page.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    send.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // the blur that closed the keyboard mid-tap never happens
    await click(send);
    await act(async () => { await flush(); await flush(); });
    expect(apiFake.orchestratorMessages).toHaveLength(1);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("");
  });

  test("desktop: a click on Send moves the focus as it always did", () => {
    const box = document.createElement("textarea");
    const send = document.createElement("button");
    document.body.append(box, send);
    box.focus();
    let prevented = 0;
    const tap = { preventDefault: () => { prevented++; }, currentTarget: send };
    keepComposerFocus(tap, false);
    expect(prevented).toBe(0);
    keepComposerFocus(tap, true);
    expect(prevented).toBe(1);
    send.focus(); // nothing to keep once a button holds the focus
    keepComposerFocus(tap, true);
    expect(prevented).toBe(1);
    box.remove(); send.remove();
  });
});

describe("gestures", () => {
  test("swipe thresholds: a quarter of the sheet (≤120px) or a flick closes; less springs back", () => {
    expect(swipeDecision({ dy: 130, ms: 800, height: 800 })).toBe("close");
    expect(swipeDecision({ dy: 100, ms: 800, height: 800 })).toBe("snap");
    expect(swipeDecision({ dy: 50, ms: 50, height: 800 })).toBe("close"); // a flick
    expect(swipeDecision({ dy: 30, ms: 10, height: 800 })).toBe("snap"); // too short to be one
    expect(swipeDecision({ dy: 50, ms: 900, height: 200 })).toBe("close"); // a short sheet's quarter
  });

  test("each drawer swipes toward the edge it comes from: bottom down, left left, right right", () => {
    expect(swipeOffset("bottom", 30, 90)).toBe(90);
    expect(swipeOffset("bottom", 0, -40)).toBe(0); // up: no further than its resting place
    expect(swipeOffset("left", -70, 10)).toBe(70);
    expect(swipeOffset("left", 70, 0)).toBe(0);
    expect(swipeOffset("right", 70, 10)).toBe(70);
    expect(swipeOffset("right", -70, 0)).toBe(0);
  });

  test("a body swipe arms only along the dismiss axis, toward the edge, with the content at its start", () => {
    expect(swipeArm({ edge: "bottom", dx: 2, dy: 5, atStart: true })).toBe("wait"); // a tap's wobble
    expect(swipeArm({ edge: "bottom", dx: 3, dy: 20, atStart: true })).toBe("drag");
    expect(swipeArm({ edge: "bottom", dx: 3, dy: 20, atStart: false })).toBe("scroll"); // scrolled down: the list scrolls
    expect(swipeArm({ edge: "bottom", dx: 3, dy: -20, atStart: true })).toBe("scroll"); // up is a scroll
    expect(swipeArm({ edge: "bottom", dx: 30, dy: 20, atStart: true })).toBe("scroll"); // mostly sideways
    expect(swipeArm({ edge: "left", dx: -30, dy: 5, atStart: true })).toBe("drag");
    expect(swipeArm({ edge: "left", dx: 30, dy: 5, atStart: true })).toBe("scroll");
    expect(swipeArm({ edge: "right", dx: 30, dy: 5, atStart: true })).toBe("drag");
    expect(swipeArm({ edge: "right", dx: 10, dy: 30, atStart: true })).toBe("scroll"); // mostly vertical: the chat scrolls
  });

  test("pull states: idle, pull, then release past the threshold; the indicator is damped and capped", () => {
    expect(pullState(5)).toEqual({ phase: "idle", offset: 0 });
    expect(pullState(60)).toEqual({ phase: "pull", offset: 30 });
    expect(pullState(PULL_REFRESH_PX * 2).phase).toBe("release");
    expect(pullState(1000).offset).toBe(96);
  });

  let clock = 0; // each event 400ms after the last: a deliberate drag, not a flick
  const pointer = (type: string, y: number, target: EventTarget = window) => {
    const e = new PointerEvent(type, { bubbles: true, button: 0, clientY: y });
    Object.defineProperty(e, "timeStamp", { value: (clock += 400) });
    target.dispatchEvent(e);
  };

  test("a bottom sheet closes on a swipe down its header, and stays on a short one", async () => {
    await mount("/agents", true);
    await click($('[data-slot="filters-button"]')!);
    const sheet = $<HTMLDialogElement>('dialog[data-slot="filter-sheet"]')!;
    const handle = sheet.querySelector<HTMLElement>("[data-swipe-handle]")!;
    await act(async () => { pointer("pointerdown", 100, handle); pointer("pointermove", 140); pointer("pointerup", 140); await flush(); });
    expect(sheet.open).toBe(true); // 40px, slowly enough: springs back
    expect(sheet.style.transform).toBe("");
    await act(async () => { pointer("pointerdown", 100, handle); pointer("pointermove", 200); expect(sheet.style.transform).toBe("translateY(100px)"); pointer("pointermove", 400); pointer("pointerup", 400); await flush(); });
    // It slides on down from where the finger let go, the backdrop fading, and only then closes.
    expect(sheet.hasAttribute("data-closing")).toBe(true);
    expect(sheet.style.transform).toBe("translateY(100%)");
    await act(async () => { await sleep(SHEET_CLOSE_MS + 30); });
    expect(sheet.open).toBe(false);
    expect(sheet.style.transform).toBe("");
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const touchOn = (target: Element, type: string, y?: number, x = 0) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "touches", { value: y === undefined ? [] : [{ clientX: x, clientY: y }] });
    Object.defineProperty(e, "timeStamp", { value: (clock += 400) });
    target.dispatchEvent(e);
    return e;
  };

  test("a stacked row never opens the menu from a long-press / contextmenu, and shows no selection or callout", async () => {
    await mount("/agents", true);
    const row = $('[data-branch="feat-phone"]')!;
    expect(row.className).toContain("select-none");
    expect(row.className).toContain("[-webkit-touch-callout:none]");
    expect(row.className).toContain("[&_a]:[-webkit-touch-callout:default]"); // links keep theirs
    expect(row.hasAttribute("aria-haspopup")).toBe(false); // only the ⋯ opens a menu
    let e!: MouseEvent;
    await act(async () => { e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 40 }); row.querySelector('[data-slot="row-instruction"], span')!.dispatchEvent(e); await flush(); await flush(); });
    expect(e.defaultPrevented).toBe(true); // nor the browser's own menu
    expect($('[role="menu"]')).toBeNull();
    expect($('[data-slot="row-context-menu"]')).toBeNull();
    expect($<HTMLDialogElement>('dialog[data-slot="actions-sheet"]')!.open).toBe(false);
  });

  test("the ⋯ opens the row's actions as a bottom sheet of large icon rows (with a haptic tick); an item runs and slides it shut", async () => {
    const buzz: number[] = [];
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (ms: number) => { buzz.push(ms); return true; } });
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });
    try {
      await mount("/agents", true);
      const row = $('[data-branch="feat-phone"]')!;
      const dots = row.querySelector<HTMLElement>('button[aria-label="Actions"]')!;
      expect(dots.getAttribute("aria-haspopup")).toBe("menu");
      await click(dots);
      const sheet = $<HTMLDialogElement>('dialog[data-slot="actions-sheet"]')!;
      expect(sheet.open).toBe(true);
      expect(sheet.hasAttribute("data-bottom-sheet")).toBe(true);
      expect(dots.getAttribute("aria-expanded")).toBe("true");
      expect(buzz).toEqual([10]);
      expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull(); // no dropdown
      const rows = [...sheet.querySelectorAll<HTMLElement>('[data-slot="sheet-item"]')];
      const labels = rows.map((r) => r.textContent?.trim());
      // The ⋯ menu's own items (submenus open in place as labelled groups), unchanged.
      for (const l of ["Open", "Copy branch", "Follow up…", "Rename…", "Copy worktree", "Discard"]) expect(labels).toContain(l);
      expect([...sheet.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label"))).toContain("Agent");
      for (const r of rows) {
        expect(r.className).toContain("min-h-12"); // a 48px touch row
        expect(r.querySelector("svg")).not.toBeNull(); // with its icon
      }
      await click(rows.find((r) => r.textContent?.trim() === "Copy branch")!);
      expect(copied).toEqual(["feat-phone"]);
      expect(location.pathname).toBe("/agents"); // a tap in the sheet is not a tap on the row
      expect(sheet.hasAttribute("data-closing")).toBe(true);
      await act(async () => { await sleep(SHEET_CLOSE_MS + 30); });
      expect(sheet.open).toBe(false);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).vibrate;
    }
  });

  test("a bottom sheet swipes shut from its body too — following the finger, springing back on a short drag, never while its content is scrolled", async () => {
    await mount("/agents", true);
    await click($('[data-branch="feat-phone"] button[aria-label="Actions"]')!);
    const sheet = $<HTMLDialogElement>('dialog[data-slot="actions-sheet"]')!;
    const body = sheet.querySelector<HTMLElement>('[data-slot="sheet-body"]')!;
    const item = body.querySelector('[data-slot="sheet-item"]')!; // the whole body is buttons: a swipe from one still counts
    // Short and slow: follows, then springs back.
    await act(async () => { touchOn(item, "touchstart", 100); touchOn(item, "touchmove", 140); await flush(); });
    expect(sheet.style.transform).toBe("translateY(32px)"); // past the 8px tap wobble
    await act(async () => { touchOn(item, "touchend"); await flush(); });
    expect(sheet.style.transform).toBe("");
    expect(sheet.open).toBe(true);
    // Scrolled down: the drag is the content's scroll, not the sheet's.
    Object.defineProperty(body, "scrollTop", { configurable: true, value: 50 });
    await act(async () => { touchOn(item, "touchstart", 100); const m = touchOn(item, "touchmove", 400); expect(m.defaultPrevented).toBe(false); touchOn(item, "touchend"); await flush(); });
    expect(sheet.style.transform).toBe("");
    expect(sheet.open).toBe(true);
    Object.defineProperty(body, "scrollTop", { configurable: true, value: 0 });
    // At the top, a long drag down closes it: the move is claimed (no scroll, no click) and it slides out.
    await act(async () => { touchOn(item, "touchstart", 100); const m = touchOn(item, "touchmove", 400); expect(m.defaultPrevented).toBe(true); touchOn(item, "touchend"); await flush(); });
    expect(sheet.hasAttribute("data-closing")).toBe(true);
    await act(async () => { await sleep(SHEET_CLOSE_MS + 30); });
    expect(sheet.open).toBe(false);
  });

  test("a sideways move on a bottom sheet's body is not a dismiss", async () => {
    await mount("/agents", true);
    await click($('[data-branch="feat-phone"] button[aria-label="Actions"]')!);
    const sheet = $<HTMLDialogElement>('dialog[data-slot="actions-sheet"]')!;
    const item = sheet.querySelector('[data-slot="sheet-body"] [data-slot="sheet-item"]')!;
    await act(async () => {
      touchOn(item, "touchstart", 100, 100);
      const m = touchOn(item, "touchmove", 130, 200); // 30 down, 100 across
      expect(m.defaultPrevented).toBe(false);
      touchOn(item, "touchmove", 400, 200);
      touchOn(item, "touchend"); await flush();
    });
    expect(sheet.style.transform).toBe("");
    expect(sheet.open).toBe(true);
    expect(sheet.hasAttribute("data-closing")).toBe(false);
  });

  test("Add New on a phone swipes down from its body as well as its header", async () => {
    await mount("/agents", true);
    await click($('[data-slot="bottom-bar"] button:nth-child(3)')!);
    const dialog = $<HTMLDialogElement>('dialog[data-slot="add-new-dialog"]')!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("header")!.getAttribute("data-swipe-handle")).toBe("bottom");
    const hint = dialog.querySelector("p")!;
    await act(async () => { touchOn(hint, "touchstart", 100); const m = touchOn(hint, "touchmove", 400); expect(m.defaultPrevented).toBe(true); touchOn(hint, "touchend"); await flush(); });
    expect(dialog.open).toBe(false);
  });

  test("the orchestrator's right-hand panel swipes right to close on a touch screen; a mouse gets no swipe", async () => {
    await mount("/agents", false, [COARSE_QUERY]); // a wide touch screen: the side panel, not the page
    act(() => { getDefaultStore().set(orchestratorOpenAtom, true); });
    await act(async () => { await flush(); });
    const panel = $('[data-slot="orchestrator-panel"]')!;
    const handle = panel.querySelector<HTMLElement>('[data-slot="orchestrator-handle"]')!;
    expect(handle.getAttribute("data-swipe-handle")).toBe("right");
    const px = (type: string, x: number, target: EventTarget = window) => {
      const e = new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 50 });
      Object.defineProperty(e, "timeStamp", { value: (clock += 400) });
      target.dispatchEvent(e);
    };
    // A short drag follows the finger, then springs back.
    await act(async () => { px("pointerdown", 100, handle); px("pointermove", 140); expect(panel.style.transform).toBe("translateX(40px)"); px("pointerup", 140); await flush(); });
    expect(getDefaultStore().get(orchestratorOpenAtom)).toBe(true);
    // Left is not toward its edge: it stays put.
    await act(async () => { px("pointerdown", 300, handle); px("pointermove", 100); expect(panel.style.transform).toBe(""); px("pointerup", 100); await flush(); });
    // A long drag right closes it; its own slide takes over from there.
    await act(async () => { px("pointerdown", 100, handle); px("pointermove", 400); px("pointerup", 400); await flush(); });
    expect(getDefaultStore().get(orchestratorOpenAtom)).toBe(false);
    expect(panel.style.transform).toBe("");
    expect(panel.getAttribute("data-state")).toBe("closed");
  });

  test("pull to refresh on the Agents list: the indicator follows the finger, and letting go past it refreshes", async () => {
    await mount("/agents", true);
    const list = $('section[aria-label="Agents"]')!;
    const touch = (type: string, y?: number, target: Element = list) => {
      const e = new Event(type, { bubbles: true });
      Object.defineProperty(e, "touches", { value: y === undefined ? [] : [{ clientY: y }] });
      target.dispatchEvent(e);
    };
    // A swipe on the Filters sheet (a dialog inside the list) is the sheet's, never a pull.
    const sheetHandle = list.querySelector('dialog[data-slot="filter-sheet"] [data-swipe-handle]')!;
    await act(async () => { touch("touchstart", 100, sheetHandle); touch("touchmove", 400, sheetHandle); await flush(); });
    expect($('[data-slot="pull-to-refresh"]')).toBeNull();
    await act(async () => { touch("touchend", undefined, sheetHandle); await flush(); });
    const before = store.clientPollCounts().agents;
    await act(async () => { touch("touchstart", 100); touch("touchmove", 160); await flush(); });
    expect($('[data-slot="pull-to-refresh"]')!.textContent).toBe("Pull to refresh");
    await act(async () => { touch("touchmove", 100 + PULL_REFRESH_PX * 2 + 10); await flush(); });
    expect($('[data-slot="pull-to-refresh"]')!.textContent).toBe("Release to refresh");
    await act(async () => { touch("touchend"); await flush(); await flush(); await flush(); });
    expect(store.clientPollCounts().agents).toBeGreaterThan(before);
    expect($('[data-slot="pull-to-refresh"]')).toBeNull(); // done: back to idle
  });
});

describe("home-screen shortcuts", () => {
  test("/?open=orchestrator opens the orchestrator once, and the parameter is dropped", async () => {
    await mount("/?open=orchestrator", true);
    // On a phone that's a navigation to the routed page, not the side panel.
    expect(location.pathname).toBe("/orchestrator");
    expect(getDefaultStore().get(orchestratorOpenAtom)).toBe(false);
    expect(location.search).toBe("");
  });
});

describe("the desktop layout is untouched", () => {
  test("columns and chips as before; the orchestrator is the right-hand side panel", async () => {
    await mount("/agents", false);
    expect($('[data-slot="workstream-list-header"]')).not.toBeNull();
    expect($('[data-branch="feat-phone"]')!.dataset.layout).toBeUndefined();
    expect($('[role="group"][aria-label="Quick filters"]')).not.toBeNull();
    expect($('[data-slot="filters-button"]')).toBeNull();
    act(() => { getDefaultStore().set(orchestratorOpenAtom, true); });
    await act(async () => { await flush(); await flush(); });
    expect($('[data-slot="orchestrator-panel"]')!.hasAttribute("data-sheet")).toBe(false);
    expect($('[data-slot="orchestrator-panel"]')!.className).toContain("fixed inset-y-0 right-0");
    expect(document.querySelectorAll('[data-slot="orchestrator-resize"]').length).toBe(1); // its left edge
    expect($('[data-slot="orchestrator-handle"]')!.hasAttribute("data-swipe-handle")).toBe(false); // a mouse: no swipe
    expect($('[data-slot="quick-ask-pill"]')).not.toBeNull(); // the desktop has the quick-ask pill…
  });

  test("autofocus is unchanged: opening the orchestrator from the top bar still focuses its composer", async () => {
    await mount("/", false);
    await click($('[data-slot="ask-orchestrator"]')!);
    await act(async () => { await flush(); await flush(); });
    expect(document.activeElement).toBe($('[data-slot="orchestrator-panel"] textarea'));
  });
});

describe("a newer build", () => {
  test("the banner appears when version.json names another build, and only then; it clears the status bar itself and reports its state up", async () => {
    const realFetch = globalThis.fetch;
    let served = "build-1";
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe("/version.json");
      return { json: async () => ({ build: served }) };
    }) as unknown as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    const staleChanges: boolean[] = [];
    await act(async () => { root = createRoot(container!); root.render(<UpdateBanner build="build-1" every={5} onStaleChange={(s) => staleChanges.push(s)} />); await flush(); });
    await act(async () => { await Bun.sleep(20); });
    expect(container.querySelector('[data-slot="update-banner"]')).toBeNull();
    expect(staleChanges).toEqual([false]); // told up front it isn't shown, so a header can keep its own inset
    served = "build-2";
    await act(async () => { await Bun.sleep(30); });
    const banner = container.querySelector<HTMLElement>('[data-slot="update-banner"]')!;
    expect(banner.textContent).toContain("Refresh");
    // It is now the topmost element on a narrow layout, so it — not the header below it — clears the notch.
    expect(banner.className).toContain("max-md:pt-[env(safe-area-inset-top)]");
    expect(staleChanges).toEqual([false, true]);
    globalThis.fetch = realFetch;
  });
});
