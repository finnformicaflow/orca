// E2E for optimistic draft creation: submitting a new session must paint a Local card AND expose
// Undo the instant you hit send — before the server derives a title, cuts a branch, and makes the
// worktree (a couple of seconds of Haiku + git). Once the real worktree lands the optimistic
// stand-in is replaced by it; Undo tears the draft down whether the worktree exists yet or not.
// Driven against a preloaded fake `api` (tests/apiFake.ts, no network) so we can hold createWorktree
// pending and observe the pre-response state, rendered into a real DOM. See createWorkstream/undoDraft.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { OptimisticDraft } from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg populated from the fake config before the first render

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
