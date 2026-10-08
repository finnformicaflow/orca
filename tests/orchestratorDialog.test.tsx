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
  expect(card()!.textContent).toBe("Context 42% fullA fresh session starts at 80%.");
  await act(async () => { ring.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })); await flush(); });
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
  expect(document.body.querySelector('[data-slot="context-ring-card"]')!.textContent).toBe("Context 85% fullThe next message starts a fresh session, carrying a summary of this one.");
});

test("the window is draggable by its header, resizable, smaller-typed, and remembers its frame", async () => {
  localStorage.setItem("orca.orchestrator.frame", JSON.stringify({ x: 40, y: 50, w: 500, h: 400 }));
  await mount(<OrchestratorButton />);
  await click(launcher());
  const p = panel()!;
  expect(p.className).toContain(" resize "); // the browser's own resize handle, bottom-right
  expect(p.className).toContain("[&_.text-xs]:text-[10px]"); // two steps smaller than a card's terminal
  expect(p.style.width).toBe("500px");
  expect(p.style.left).toBe("40px"); // a remembered spot is honoured…
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
});
