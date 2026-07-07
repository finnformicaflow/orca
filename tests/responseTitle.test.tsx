// E2E for "response text as title": once a headless run finishes, the workstream card adopts the
// agent's own response text as its title (Claude's summary of what it did beats the pre-run prompt
// guess). Driven against the preloaded fake `api` (tests/apiFake.ts) — a done agent carrying an
// agentResult is fed through the store's refresh, and we assert the assembled row's title.
// See store.refresh() + titleFromResult (workstream.ts).
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { titleFromResult } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady);

function Rows() {
  const rows = store.useWorkstreams();
  return <ul>{rows.map((r) => <li key={r.repo + r.branch} data-branch={r.branch}>{r.title}</li>)}</ul>;
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

beforeEach(() => localStorage.clear()); // no stale enrichment titles leaking between tests

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("response text as title", () => {
  test("a finished run's response text becomes the card title", async () => {
    const result = "Added a copy-link icon next to the PR link on board cards.\n\nAlso covered it with a test.";
    apiFake.agentsData = [{ branch: "feat-x", worktreePath: "/wt/feat-x", agentStatus: "done", agentResult: result }];
    mount();
    await act(async () => { await store.refresh(); });
    const row = items().find((li) => li.getAttribute("data-branch") === "feat-x")!;
    expect(row.textContent).toBe(titleFromResult(result));
    expect(row.textContent).toBe("Added a copy-link icon next to the PR link on board cards"); // first line, period stripped
  });

  test("a leading 'Task Name:' style label is stripped — visible width is scarce", async () => {
    const result = "Task Name: Investigate Missing Source ID Column\n\nHere's what I found…";
    apiFake.agentsData = [{ branch: "feat-z", worktreePath: "/wt/feat-z", agentStatus: "done", agentResult: result }];
    mount();
    await act(async () => { await store.refresh(); });
    const row = items().find((li) => li.getAttribute("data-branch") === "feat-z")!;
    expect(row.textContent).toBe("Investigate Missing Source ID Column"); // no "Task Name:" prefix
  });

  test("a running run keeps its provisional (branch) title — no result yet", async () => {
    apiFake.agentsData = [{ branch: "feat-y", worktreePath: "/wt/feat-y", agentStatus: "running" }];
    mount();
    await act(async () => { await store.refresh(); });
    const row = items().find((li) => li.getAttribute("data-branch") === "feat-y")!;
    expect(row.textContent).toBe("feat-y"); // falls back to the branch (no enriched title, no PR)
  });
});
