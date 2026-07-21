// E2E for the header "Running previews" menu (PreviewControl.PreviewManagerMenu): a count badge on
// the trigger, a popover listing each live local preview labelled by its session title, and Open /
// Stop controls per preview. Driven against the fake api (tests/apiFake.ts) into a real DOM.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { PreviewManagerMenu } from "@/views/PreviewControl";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));
const svc = (port: number) => ({ name: "web", port, url: `http://localhost:${port}`, open: true, running: true, ready: true, startedAt: 1 });

let root: Root | undefined;
let container: HTMLElement | undefined;
// The menu polls api.previews on mount, so set apiFake.previewsData *before* mounting.
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<PreviewManagerMenu />); await flush(); await flush(); });
}
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
// Popover content is portaled to <body>, not inside `container`.
const trigger = () => container!.querySelector("[aria-label='Running previews']")!;
const inBody = (sel: string) => [...document.body.querySelectorAll(sel)];
const button = (label: string) => inBody("button").find((b) => b.textContent?.includes(label));

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  document.querySelectorAll("[data-radix-popper-content-wrapper]").forEach((n) => n.remove());
  root = container = undefined;
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); });
});

test("PM1 no previews: no badge, and the menu says so", async () => {
  await mount();
  expect(trigger().textContent).toBe(""); // just the icon, no count badge
  await click(trigger());
  expect(button("No previews running")).toBeFalsy(); // it's a div, not a button
  expect([...document.body.querySelectorAll("div")].some((d) => d.textContent === "No previews running.")).toBeTruthy();
});

test("PM2 badge counts running previews and lists each by its session title, with Open + Stop", async () => {
  // A worktree + enrichment title so the store has a row whose worktreePath keys the preview. Setting
  // localStorage alone won't touch the store's in-memory map — a storage event reloads it (as another
  // Orca tab's write would), see store.ts.
  apiFake.worktrees.set("dark-mode", { branch: "dark-mode", worktreePath: "/wt/dark-mode" });
  apiFake.enrichmentData.set("r::dark-mode", { title: "Add dark mode" }); // titles come from the bridge now
  const storageEvent = new Event("storage") as Event & { key?: string };
  storageEvent.key = "orca.enrichment";
  await act(async () => { window.dispatchEvent(storageEvent); await store.refresh(); });

  apiFake.previewsData = [{ key: "/wt/dark-mode", svcs: [svc(5173)] }, { key: "/wt/other", svcs: [svc(5174)] }];
  await mount();
  expect(trigger().querySelector("[aria-label='2 running previews']")).toBeTruthy();

  await click(trigger());
  const labels = inBody("div").map((d) => d.textContent);
  expect(labels).toContain("Add dark mode"); // labelled by the session title, not the raw path
  expect(labels).toContain("other");         // adopted/base worktree with no card → last path segment
  expect(button("Open")).toBeTruthy();       // ready → Open link (shared PreviewLiveControl)
});

test("PM4 unreachable endpoint: a distinct 'API unavailable' hint, no badge, not the empty state", async () => {
  apiFake.previewsError = "404"; // e.g. a self-preview whose bridge predates the /api/previews route
  await mount();
  expect(trigger().textContent).toBe(""); // count badge stays hidden while errored

  await click(trigger());
  const divs = [...document.body.querySelectorAll("div")].map((d) => d.textContent);
  expect(divs.some((t) => t === "Previews API unavailable — run the bridge on this branch.")).toBeTruthy();
  expect(divs.some((t) => t === "No previews running.")).toBeFalsy(); // distinct from the genuine empty state
});

test("PM3 Stop tears the preview down and drops it from the list", async () => {
  apiFake.previewsData = [{ key: "/wt/solo", svcs: [svc(5173)] }];
  await mount();
  await click(trigger());
  expect(trigger().querySelector("[aria-label='1 running previews']")).toBeTruthy();

  const stop = inBody("button").find((b) => b.getAttribute("title") === "Stop preview")!;
  await click(stop);

  expect(apiFake.calls).toContain("previewStop:/wt/solo"); // reaped via the same stop endpoint
  expect(trigger().querySelector("[aria-label='1 running previews']")).toBeFalsy(); // badge gone
});
