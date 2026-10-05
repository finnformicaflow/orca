// The orchestrator's entry point in the UI: a header button opening the same conversation modal a
// card's terminal uses, over the orchestrator's own turns, with the composer sending to its route
// (never the branch follow-up launch). Rendered into a real DOM against the fake api.
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

test("the Orchestrator button opens its conversation, and the composer sends to the orchestrator", async () => {
  apiFake.turnsData.set("@orca::orchestrator", [
    { id: "run-1", provider: "claude", instruction: "ship the cache", prompt: "p", response: "Spawned r/add-cache.", finishedAt: 2 },
  ]);
  await mount(<OrchestratorButton />);
  const dialog = container!.querySelector("dialog")!;
  expect(dialog.open).toBe(false);

  const button = [...container!.querySelectorAll("button")].find((b) => /Orchestrator/.test(b.textContent ?? ""))!;
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("ship the cache");
  expect(dialog.textContent).toContain("Spawned r/add-cache.");

  const textarea = dialog.querySelector("textarea")!;
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
});

test("a paused orchestrator says so, and an orchestrated card is marked", async () => {
  apiFake.orchestratorState = { key: "/state/orchestrator", running: false, paused: true, notes: "" };
  await mount(<><OrchestratorButton /><WorkstreamCard row={{ repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", orchestrated: true }} /></>);
  expect(container!.querySelector('[aria-label="Orchestrated"]')).toBeTruthy();
  const button = [...container!.querySelectorAll("button")].find((b) => /^\s*Orchestrator/.test(b.textContent ?? ""))!;
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); });
  expect(container!.querySelector("dialog")!.textContent).toContain("Orchestrator · paused until you reply");
});
