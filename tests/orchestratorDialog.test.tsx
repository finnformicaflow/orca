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
  apiFake.orchestratorState = { ...apiFake.orchestratorState, model: "claude-opus-5", contextPct: 42 };
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
  const picker = panel()!.querySelector<HTMLElement>('[aria-label="Orchestrator model"]')!;
  expect(picker.textContent).toBe("Claude · Opus 5");
  // Beside it, how full its context is: a small ring, with the percentage on hover.
  const ring = panel()!.querySelector<HTMLElement>('[data-slot="context-ring"]')!;
  expect(ring.title).toBe("Context 42% full — resets onto its notes at 80%");
  expect(ring.querySelectorAll("circle")).toHaveLength(2);

  const textarea = panel()!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "what is running?");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
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
  expect(ring.title).toBe("Context 85% full — the next message starts a fresh session from its notes");
  expect(ring.className).toContain("text-amber-400");
});
