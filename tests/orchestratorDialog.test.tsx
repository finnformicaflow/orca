// The orchestrator's entry point in the UI: a floating launcher in the bottom-right corner that pops
// out a chat window (the same ChatPanel a card's terminal uses) over the orchestrator's own turns,
// with the composer sending to its route (never the branch follow-up launch). Rendered into a real DOM against the fake api.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { OrchestratorButton } from "@/components/Terminal";
import { WorkstreamCard } from "@/views/Board";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, clampFrame, resizeFrame } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
}
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
  localStorage.clear();
  delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
  document.documentElement.classList.remove("dark");
});

const panel = () => container!.querySelector<HTMLElement>('[data-slot="orchestrator-panel"]');
const launcher = () => container!.querySelector<HTMLButtonElement>('button[aria-label$="orchestrator"][aria-expanded]')!;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

test("the floating launcher pops out the orchestrator's conversation, and the composer sends to it", async () => {
  apiFake.turnsData.set("@orca::orchestrator", [
    { id: "run-1", provider: "claude", instruction: "ship the cache", prompt: "p", response: "Spawned r/add-cache.", finishedAt: 2 },
  ]);
  apiFake.orchestratorState = { ...apiFake.orchestratorState, model: "claude-opus-5-5", contextPct: 42 };
  await mount(<OrchestratorButton />);
  expect(panel()).toBeNull(); // closed: only the launcher, pinned bottom-right
  expect(container!.querySelector("dialog")).toBeNull(); // a popout, not a modal — the board stays usable
  expect(launcher().parentElement!.className).toContain("fixed right-4 bottom-4");
  // Inverted against the page in either theme: the foreground token is the fill.
  expect(launcher().className).toContain("bg-foreground text-background");

  await click(launcher());
  expect(launcher().getAttribute("aria-expanded")).toBe("true");
  expect(panel()!.textContent).toContain("ship the cache");
  expect(panel()!.textContent).toContain("Spawned r/add-cache.");
  // The terminal log fills the window: no padding around it and no frame of its own.
  const log = panel()!.querySelector<HTMLElement>(".bg-neutral-950")!;
  expect(log.parentElement!.parentElement!.className).toBe("min-h-0 flex-1");
  expect(log.className).not.toContain("border");
  expect(log.className).not.toContain("rounded");
  // The text box sits on the same terminal colour as the log (no seam), dark-scoped so its text
  // reads in a light theme too, and carries the orchestrator's model picker — Claude models only.
  const box = panel()!.querySelector("textarea")!.parentElement!;
  expect(box.className).toContain("bg-neutral-950");
  expect(box.className).not.toContain("bg-card");
  expect(box.parentElement!.parentElement!.className).toContain("dark text-foreground bg-neutral-950");
  const picker = panel()!.querySelector<HTMLElement>('[aria-label="Model"]')!;
  expect(picker.textContent).toBe("Claude · Opus 5.5");
  // Beside it, how full its context is: an icon button holding a small ring, with the percentage
  // in a popover on hover.
  const ring = panel()!.querySelector<HTMLButtonElement>('button[data-slot="context-ring"]')!;
  expect(ring.getAttribute("aria-label")).toBe("Context 42% full");
  expect(ring.querySelectorAll("circle")).toHaveLength(2);
  expect(ring.className).toContain("cursor-pointer");
  expect(ring.className).toContain("hover:bg-accent"); // a real button's hover state
  const card = () => document.body.querySelector('[data-slot="context-ring-card"]');
  expect(card()).toBeNull();
  await act(async () => { ring.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); await flush(); });
  expect(card()!.textContent).toBe("Context 42% fullA fresh session starts at 80%.Compact");
  // Its Compact button compacts the orchestrator's OWN session (its reserved repo/branch).
  await act(async () => { document.body.querySelector<HTMLButtonElement>('button[data-slot="context-compact"]')!.click(); await flush(); await flush(); });
  expect(apiFake.calls).toContain(`compact:${ORCHESTRATOR_REPO}:${ORCHESTRATOR_BRANCH}`);
  // It closes a moment after the pointer leaves (time to cross onto the card's button).
  await act(async () => { ring.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })); await new Promise((r) => setTimeout(r, 200)); });
  expect(card()).toBeNull();

  const textarea = panel()!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "what is running?");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush(); await flush();
  });
  expect(apiFake.orchestratorMessages).toEqual([{ text: "what is running?", attachments: [] }]);
  expect(apiFake.agentLaunches).toEqual([]); // not a branch follow-up

  // The launcher toggles, and Escape from inside the window closes it too.
  await click(launcher());
  expect(panel()).toBeNull();
  await click(launcher());
  await act(async () => { panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
  expect(panel()).toBeNull();
});

test("a paused orchestrator says so, and an orchestrated card is marked", async () => {
  apiFake.orchestratorState = { ...apiFake.orchestratorState, paused: true, contextPct: 85 };
  await mount(<><OrchestratorButton /><WorkstreamCard row={{ repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", orchestrated: true }} /></>);
  expect(container!.querySelector('[aria-label="Orchestrated"]')).toBeTruthy();
  await click(launcher());
  expect(panel()!.textContent).toContain("Orchestrator · paused until you reply");
  const ring = panel()!.querySelector<HTMLElement>('[data-slot="context-ring"]')!;
  expect(ring.className).toContain("text-amber-400");
  await click(ring); // click (touch, keyboard) opens it too
  expect(document.body.querySelector('[data-slot="context-ring-card"]')!.textContent).toBe("Context 85% fullThe next message starts a fresh session, carrying a summary of this one.Compact");
});

test("the window is draggable by its header, resizable, smaller-typed, and remembers its frame", async () => {
  localStorage.setItem("orca.orchestrator.frame", JSON.stringify({ x: 40, y: 50, w: 500, h: 400 }));
  await mount(<OrchestratorButton />);
  await click(launcher());
  const p = panel()!;
  expect(p.querySelectorAll('[data-slot="orchestrator-resize"]')).toHaveLength(8); // every edge and corner
  expect(p.className).toContain("[&_.text-xs]:text-[10px]"); // smaller than a card's terminal…
  expect(p.className).toContain("[&_.prose]:text-[10.5px]"); // …including the markdown replies, which size themselves
  expect(p.style.width).toBe("500px");
  expect(p.style.left).toBe("40px"); // a remembered spot is honoured…
  expect(p.classList.contains("fixed")).toBe(true); // …as a FIXED position: with `relative` also present it became an off-screen offset
  expect(p.classList.contains("relative")).toBe(false);
  const handle = p.querySelector<HTMLElement>('[data-slot="orchestrator-handle"]')!;
  expect(handle.className).toContain("cursor-move");
  // …and a drag by the header moves it.
  await act(async () => {
    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 60, clientY: 60 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, clientY: 110 }));
    window.dispatchEvent(new PointerEvent("pointerup", {}));
    await flush();
  });
  // (happy-dom lays nothing out, so the panel's rect is at 0,0: the grab offset is 60, and the pointer at 160 puts it at 100.)
  expect(p.style.left).toBe("100px");
  expect(JSON.parse(localStorage.getItem("orca.orchestrator.frame")!)).toMatchObject({ x: 100 });
  // Resizing from the right edge widens. (happy-dom puts the panel at x=0, so the LEFT edge can't
  // grow it: it stops at the viewport — resizeFrame's own test covers the left edge moving the origin.)
  const resize = async (h: string, dx: number) => act(async () => {
    p.querySelector<HTMLElement>(`[data-handle="${h}"]`)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: dx, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointerup", {}));
    await flush();
  });
  await resize("w", -50);
  expect(p.style.width).toBe("500px");
  await resize("e", 50);
  expect(p.style.width).toBe("550px");
  expect(JSON.parse(localStorage.getItem("orca.orchestrator.frame")!)).toMatchObject({ w: 550 });
});

test("clampFrame keeps a window wholly inside the viewport; resizeFrame stops each edge at it", () => {
  // Dragged past any edge: slid back in, size kept.
  expect(clampFrame({ x: -30, y: 900, w: 400, h: 300 }, 1000, 800)).toEqual({ x: 0, y: 500, w: 400, h: 300 });
  expect(clampFrame({ x: 950, y: -5, w: 400, h: 300 }, 1000, 800)).toEqual({ x: 600, y: 0, w: 400, h: 300 });
  // Bigger than the viewport: shrunk to fit, then placed at the origin.
  expect(clampFrame({ x: 100, y: 100, w: 1400, h: 900 }, 1000, 800)).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
  // Unplaced (anchored to the corner): only its size is fitted.
  expect(clampFrame({ w: 1400, h: 300 }, 1000, 800)).toEqual({ w: 1000, h: 300 });
  const s = { x: 100, y: 100, w: 400, h: 300 };
  expect(resizeFrame(s, "e", 900, 0, 1000, 800)).toEqual({ x: 100, y: 100, w: 900, h: 300 }); // right edge stops at the viewport
  expect(resizeFrame(s, "nw", -500, -500, 1000, 800)).toEqual({ x: 0, y: 0, w: 500, h: 400 }); // top-left too, far edges fixed
  expect(resizeFrame(s, "se", -500, -500, 1000, 800)).toEqual({ x: 100, y: 100, w: 320, h: 240 }); // never below the minimum
});

test("the window can't be dragged off-screen, a browser resize pulls it back in, and an off-screen saved spot is fixed", async () => {
  // Remembered from a bigger screen: partly off this one (happy-dom's viewport is 1024×768).
  localStorage.setItem("orca.orchestrator.frame", JSON.stringify({ x: 900, y: 700, w: 500, h: 400 }));
  await mount(<OrchestratorButton />);
  await click(launcher());
  const p = panel()!;
  expect([p.style.left, p.style.top]).toEqual(["524px", "368px"]);
  expect(JSON.parse(localStorage.getItem("orca.orchestrator.frame")!)).toEqual({ x: 524, y: 368, w: 500, h: 400 }); // fixed for good
  const handle = p.querySelector<HTMLElement>('[data-slot="orchestrator-handle"]')!;
  await act(async () => {
    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: -5000, clientY: -5000 }));
    window.dispatchEvent(new PointerEvent("pointerup", {}));
    await flush();
  });
  expect([p.style.left, p.style.top]).toEqual(["0px", "0px"]);
  await act(async () => {
    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5000, clientY: 5000 }));
    window.dispatchEvent(new PointerEvent("pointerup", {}));
    await flush();
  });
  expect([p.style.left, p.style.top]).toEqual(["524px", "368px"]);
  // The browser window shrinks: the chat window follows it in.
  const [w0, h0] = [window.innerWidth, window.innerHeight];
  try {
    await act(async () => {
      Object.assign(window, { innerWidth: 800, innerHeight: 600 });
      window.dispatchEvent(new Event("resize"));
      await flush();
    });
    expect([p.style.left, p.style.top]).toEqual(["300px", "200px"]);
    expect(JSON.parse(localStorage.getItem("orca.orchestrator.frame")!)).toMatchObject({ x: 300, y: 200 });
  } finally { Object.assign(window, { innerWidth: w0, innerHeight: h0 }); }
});

test("Pop out is hidden without the Document Picture-in-Picture API", async () => {
  await mount(<OrchestratorButton />);
  await click(launcher());
  expect(panel()!.querySelector('[aria-label="Pop out"]')).toBeNull();
});

/** A stand-in for documentPictureInPicture: each window is a second document, closed via pagehide. */
function fakePip() {
  const requests: { width: number; height: number }[] = [];
  const windows: (EventTarget & { document: Document; innerWidth: number; innerHeight: number; close(): void })[] = [];
  (window as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = {
    requestWindow: async (size: { width: number; height: number }) => {
      requests.push(size);
      const w = Object.assign(new EventTarget(), {
        document: document.implementation.createHTMLDocument("pip"), innerWidth: size.width, innerHeight: size.height,
        setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
        close() { w.dispatchEvent(new Event("pagehide")); },
      });
      windows.push(w);
      return w;
    },
  };
  return { requests, win: (i: number) => windows[i]! };
}

test("Pop out moves the live chat into a Picture-in-Picture window and back (Return to tab, or closing it)", async () => {
  apiFake.turnsData.set("@orca::orchestrator", [
    { id: "run-1", provider: "claude", instruction: "ship the cache", prompt: "p", response: "Spawned r/add-cache.", finishedAt: 2 },
  ]);
  const style = document.createElement("style");
  style.textContent = ":root { --background: white; }";
  document.head.append(style);
  const pip = fakePip();
  try {
    await mount(<OrchestratorButton />);
    await click(launcher());
    // A draft typed in the tab survives the move: the same React tree, portalled, not a copy.
    const typed = panel()!.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(typed, "half a thought");
      typed.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    document.documentElement.classList.add("dark");
    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    expect(pip.requests).toEqual([{ width: 440, height: 640 }]); // first time: the window's own size
    const doc = pip.win(0).document;
    const inPip = () => doc.querySelector<HTMLElement>('[data-slot="orchestrator-panel"]');
    expect(panel()).toBeNull(); // gone from the tab…
    expect(inPip()!.textContent).toContain("Spawned r/add-cache."); // …and live in the PiP window
    expect(inPip()!.querySelector("textarea")!.value).toBe("half a thought");
    expect(doc.head.textContent).toContain("--background: white"); // the page's styles came along
    expect(inPip()!.querySelector('[data-slot="orchestrator-resize"]')).toBeNull(); // the OS window sizes it
    // The tab's theme (a class on <html>) is mirrored. (Only the copy on open is asserted: a later
    // toggle reaches it through a MutationObserver, and happy-dom holds observer callbacks by
    // WeakRef, so a GC mid-test can drop one — a test-environment flake, not a browser one.)
    expect(doc.documentElement.classList.contains("dark")).toBe(true);
    // Enter still sends from inside it.
    const textarea = inPip()!.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "from the pip");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush(); await flush(); });
    expect(apiFake.orchestratorMessages).toEqual([{ text: "from the pip", attachments: [] }]);
    // Escape there doesn't drop the always-on-top window.
    await act(async () => { inPip()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
    expect(inPip()).not.toBeNull();

    // Return to tab: back in the page, and the PiP size is remembered for next time.
    pip.win(0).innerWidth = 380; pip.win(0).innerHeight = 520;
    await click(inPip()!.querySelector('[aria-label="Return to tab"]')!);
    expect(inPip()).toBeNull();
    expect(panel()!.textContent).toContain("Spawned r/add-cache.");
    expect(JSON.parse(localStorage.getItem("orca.orchestrator.pip")!)).toEqual({ width: 380, height: 520 });

    // Pop out again (at the remembered size); closing the PiP window itself also brings it back.
    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    expect(pip.requests[1]).toEqual({ width: 380, height: 520 });
    expect(panel()).toBeNull();
    await act(async () => { pip.win(1).close(); await flush(); });
    expect(panel()!.textContent).toContain("Spawned r/add-cache.");

    // And the launcher closing the chat closes a popped-out window with it.
    await click(panel()!.querySelector('[aria-label="Pop out"]')!);
    let closed = false;
    pip.win(2).addEventListener("pagehide", () => { closed = true; });
    await click(launcher());
    expect(closed).toBe(true);
    expect(panel()).toBeNull();
  } finally { style.remove(); }
});
