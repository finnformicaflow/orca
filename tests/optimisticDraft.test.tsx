// E2E for optimistic draft creation: submitting a new session must paint a Local card AND expose
// Undo the instant you hit send — before the server derives a title, cuts a branch, and makes the
// worktree (a couple of seconds of Haiku + git). Once the real worktree lands the optimistic
// stand-in is replaced by it; Undo tears the draft down whether the worktree exists yet or not.
// Driven against a preloaded fake `api` (tests/apiFake.ts, no network) so we can hold createWorktree
// pending and observe the pre-response state, rendered into a real DOM. See createWorkstream/undoDraft.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import { AUTO_MODEL } from "../shared/models";
import * as store from "@/store";
import type { OptimisticDraft } from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg populated from the fake config before the first render
// The store is one module for the whole `bun test` process, and file order is not stable across
// platforms: start from an empty board rather than whatever the previous file left in `live`.
beforeEach(async () => { apiFake.reset(); await act(async () => { await store.refresh(); }); });

const flush = () => new Promise((r) => setTimeout(r, 0));

function Rows() {
  const rows = store.useWorkstreams();
  return (
    <ul>
      {rows.map((r) => <li key={r.repo + r.branch} data-lane={r.lane} data-branch={r.branch}>{r.title}</li>)}
    </ul>
  );
}

let root: Root | undefined;
let container: HTMLElement | undefined;
function mount(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(<Rows />); });
  return container;
}
const items = () => [...container!.querySelectorAll("li")];

afterEach(async () => {
  // Drain any still-pending create so the store's optimistic list empties, then reset the fake
  // backend and re-sync live state to empty before the next test.
  if (apiFake.pending) { const p = apiFake.pending; apiFake.pending = null; await act(async () => { p({ branch: "drain", worktreePath: "/x", title: "x" }); await flush(); await flush(); }); }
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("optimistic draft creation", () => {
  test("paints a Local card immediately, before the worktree is created", () => {
    mount();
    act(() => { store.createWorkstream("r", "Add a fancy widget"); });
    // createWorktree is still pending (server hasn't responded) — yet the card is already on the board.
    expect(apiFake.pending).not.toBeNull();
    expect(items()).toHaveLength(1);
    expect(items()[0]!.textContent).toBe("Add a fancy widget"); // titleFromPrompt fallback, shown instantly
    expect(items()[0]!.getAttribute("data-lane")).toBe("LOCAL");
  });

  test("hands off to the real worktree row once the server responds (and launches the agent)", async () => {
    mount();
    act(() => { store.createWorkstream("r", "Add a fancy widget"); });
    await act(async () => { apiFake.pending!({ branch: "add-widget-1", worktreePath: "/wt/add-widget-1", title: "Add widget" }); await flush(); await flush(); });
    expect(items()).toHaveLength(1); // no duplicate — the stand-in gave way to the real row
    expect(items()[0]!.getAttribute("data-branch")).toBe("add-widget-1");
    expect(apiFake.calls).toContain("runAgent");
  });

  test("launches a newly-created worktree on the selected model, which picks the provider", async () => {
    mount();
    act(() => { store.createWorkstream("r", "Add a fancy widget", [], "gpt-5.5"); });
    await act(async () => { apiFake.pending!({ branch: "codex-widget", worktreePath: "/wt/codex-widget", title: "Add widget" }); await flush(); await flush(); });
    expect(apiFake.titleProviders.at(-1)).toBe("codex");
    expect(apiFake.agentLaunches.at(-1)?.provider).toBe("codex");
    expect(apiFake.agentLaunches.at(-1)?.model).toBe("gpt-5.5");
  });

  test("Undo removes the card at once and discards the worktree even if it lands afterwards", async () => {
    mount();
    let draft: OptimisticDraft;
    act(() => { draft = store.createWorkstream("r", "Oops wrong repo"); });
    expect(items()).toHaveLength(1);
    await act(async () => { await store.undoDraft(draft!); });
    expect(items()).toHaveLength(0); // gone immediately, before the server ever responds
    // Server finally responds — createWorkstream must tear the just-made worktree back down.
    await act(async () => { apiFake.pending!({ branch: "oops-1", worktreePath: "/wt/oops-1", title: "Oops" }); await flush(); await flush(); });
    expect(apiFake.calls).toContain("discard:oops-1");
    expect(items()).toHaveLength(0); // stayed gone
    expect(apiFake.calls).not.toContain("runAgent"); // cancelled — the agent was never launched
  });
});

describe("a New draft left to the orchestrator (Auto)", () => {
  test("paints the card at once, sends the prompt to the orchestrator instead of launching, and adopts the branch it spawns", async () => {
    store.spawnPoll.ms = 10;
    mount();
    const created: string[] = [];
    act(() => { store.createWorkstream("r", "Add a fancy widget", [], AUTO_MODEL, { onCreated: (b) => created.push(b) }); });
    expect(items().map((li) => li.textContent)).toEqual(["Add a fancy widget"]); // the optimistic card
    await act(async () => { await flush(); await flush(); });
    expect(apiFake.orchestratorMessages).toEqual([{ text: "[new draft] repo: r\n\nAdd a fancy widget", attachments: [] }]);
    expect(apiFake.calls).not.toContain("runAgent"); // nothing launched directly: the orchestrator decides the brief and the model
    expect(apiFake.pending).toBeNull(); // and no worktree was made here

    // The orchestrator spawns; the poll shows a branch this repo didn't have, and the card hands over to it.
    apiFake.worktrees.set("orca/fancy-widget-ab12", { branch: "orca/fancy-widget-ab12", worktreePath: "/wt/orca/fancy-widget-ab12" });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); await flush(); });
    expect(created).toEqual(["orca/fancy-widget-ab12"]);
    expect(items().map((li) => li.dataset.branch)).toEqual(["orca/fancy-widget-ab12"]); // one card, the real one
  });

  test("Undo before the orchestrator has spawned discards what it then makes", async () => {
    store.spawnPoll.ms = 10;
    mount();
    let draft!: store.OptimisticDraft;
    act(() => { draft = store.createWorkstream("r", "Oops wrong repo", [], AUTO_MODEL); });
    await act(async () => { await flush(); });
    await act(async () => { await store.undoDraft(draft); });
    expect(items()).toHaveLength(0);
    apiFake.worktrees.set("orca/oops-1234", { branch: "orca/oops-1234", worktreePath: "/wt/orca/oops-1234" });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); await flush(); await flush(); });
    // The branch the orchestrator then spawns is torn down, like a direct draft undone mid-create.
    expect(apiFake.calls.filter((c) => c.startsWith("discard:"))).toEqual(["discard:orca/oops-1234"]);
    expect(items()).toHaveLength(0);
  });

  test("a New chat never goes through the orchestrator: Auto falls back to the repo's model", async () => {
    mount();
    act(() => { store.createWorkstream("r", "Thinking out loud", [], AUTO_MODEL, { chat: true }); });
    await act(async () => { await flush(); await flush(); });
    expect(apiFake.orchestratorMessages).toEqual([]);
    expect(apiFake.pending).not.toBeNull(); // the worktree is being made directly
  });
});
