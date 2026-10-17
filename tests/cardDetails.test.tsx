// E2E for the enriched swimlane card details: the worktree name (read-only context) + a coloured
// diffstat render on every lane EXCEPT Done, and the top-right copy menu offers the PR link (when
// there's a PR) + the worktree name + Copy CLI. Driven against the fake api (tests/apiFake.ts) — the card polls
// api.summary — rendered into a real DOM. See Board.WorkstreamCard.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { WorkstreamCard } from "@/views/Board";
import type { Row } from "@/store";
import { openTip } from "./tip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
// The top-right copy affordance is a Radix dropdown — open it with a real PointerEvent (Radix opens
// menus on pointerdown, not click) so its items (portalled to document.body) render.
const openCopyMenu = async () => {
  const trigger = container!.querySelector<HTMLElement>('[data-slot="copy-menu-trigger"]')!;
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); });
};
// Menu items carry no native title any more — find them by their own (visible) label text.
const menuItem = (label: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label) ?? null;

let copied = "";
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
});

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(row: Row) {
  // A second mount in one test unmounts the first: a root left mounted keeps shared polls (the
  // thread chips' /api/inbox/threads) subscribed into the next test file.
  act(() => root?.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<WorkstreamCard row={row} />); await flush(); await flush(); });
}

const base: Row = {
  repo: "r", hasRemote: true, branch: "enrich-cards-1", title: "Enrich cards",
  prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/enrich-cards-1", prNumber: 7, prUrl: "https://x/7",
  mergeable: "MERGEABLE",
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  copied = "";
  apiFake.reset();
});

describe("swimlane card details", () => {
  test("the card shows the model picker (provider · model of the NEXT run) — no context-fill readout", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, agentProvider: "claude", agentMeta: { model: "Opus 4.8", contextPct: 12 } });
    const picker = container!.querySelector<HTMLElement>('[aria-label="Model for this card"]');
    expect(picker?.textContent).toBe("Claude · Fable 5.1"); // nothing pinned, no repo default → Fable
    expect(openTip(picker!).textContent).toContain("last run: Opus 4.8");     // what actually answered lives in the tooltip
    expect(container!.textContent).not.toContain("Opus 4.8");
    expect(container!.textContent).not.toContain("ctx");
  });

  test("the picker shows the pinned model, without a token/cost tooltip", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, agentProvider: "codex", preferredModel: "gpt-5.5", agentMeta: { model: "Codex", inputTokens: 1234, outputTokens: 56, cacheReadTokens: 900 } });
    const picker = container!.querySelector<HTMLElement>('[aria-label="Model for this card"]');
    expect(picker?.textContent).toBe("Codex · GPT-5.5");
    const tipTrigger = picker?.closest('[data-slot="tip"]');
    expect(tipTrigger ? openTip(picker!).textContent?.includes("in / ") : false).toBe(false);
  });

  test("a non-local (In Review) card shows a coloured diffstat, but not the (redundant) branch name", async () => {
    apiFake.summaryData = { files: [{}, {}], commits: [{}], additions: 12, deletions: 3 };
    await mount(base);

    // The worktree/branch name is no longer rendered on the card (visual noise) — it's copy-only now.
    expect(container!.textContent).not.toContain("enrich-cards-1");

    // Green additions + red deletions and a file count.
    const add = container!.querySelector(".text-emerald-700");
    const del = container!.querySelector(".text-destructive");
    expect(add?.textContent).toBe("+12");
    expect(del?.textContent).toBe("−3");
    expect(container!.textContent).toContain("2 files");
  });

  test("the diffstat is measured against the PR's own target, not the repo's default branch", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, prBase: "orca/stack-parent" });
    expect(apiFake.calls).toContain("summary:/wt/enrich-cards-1:orca/stack-parent");
    // No PR (a Local card) → no base, so the server falls back to the repo's default branch.
    act(() => root?.unmount());
    apiFake.calls.length = 0;
    await mount({ ...base, lane: "LOCAL", prNumber: undefined, prBase: undefined });
    expect(apiFake.calls).toContain("summary:/wt/enrich-cards-1:");
  });

  test("a PR card's copy menu offers Copy PR link, which copies the PR url", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount(base);
    await openCopyMenu();
    const item = menuItem("Copy PR link")!;
    expect(item).not.toBeNull();
    await click(item);
    expect(copied).toBe("https://x/7");
  });

  test("a PR card's copy menu also offers Copy worktree name", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount(base);
    await openCopyMenu();
    const item = menuItem("Copy worktree name")!;
    expect(item).not.toBeNull();
    await click(item);
    expect(copied).toBe("enrich-cards-1");
  });

  test("a card's copy menu offers Copy CLI; a card with no agent run yet gets a fresh session", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount(base); // adopted PR: worktree but no agent has run here, so no conversation to continue
    await openCopyMenu();
    const item = menuItem("Copy CLI")!;
    expect(item).not.toBeNull();
    await click(item);
    expect(copied).toBe(`cd "/wt/enrich-cards-1" && claude --permission-mode auto`); // fresh, NOT --continue
  });

  test("Copy CLI --resume's the persisted session id when there is one", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, sessionId: "abc-123" });
    await openCopyMenu();
    const item = menuItem("Copy CLI")!;
    await click(item);
    expect(copied).toBe(`cd "/wt/enrich-cards-1" && claude --resume abc-123 --permission-mode auto`);
  });

  test("Copy CLI includes non-interactive Codex exec sessions when resuming", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, agentProvider: "codex", sessionId: "codex-123" });
    await openCopyMenu();
    const item = menuItem("Copy CLI")!;
    await click(item);
    expect(copied).toBe(`cd "/wt/enrich-cards-1" && codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox codex-123`);
  });

  test("a local card's copy menu has no Copy PR link option, only the worktree name", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, lane: "LOCAL", prNumber: undefined, prUrl: undefined });
    await openCopyMenu();
    expect(menuItem("Copy PR link")).toBeNull();
    expect(menuItem("Copy worktree name")).not.toBeNull();
  });

  test("a Done card shows no diffstat", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 5, deletions: 5 };
    await mount({ ...base, lane: "DONE", mergedAt: new Date().toISOString() });
    expect(container!.textContent).not.toContain("+5");
  });

  test("an errored card shows the error text on the card, not only on hover", async () => {
    // The Error badge alone surfaced the reason only via a title tooltip — a failed run looked like a
    // bare red badge. The message now renders on the card body.
    await mount({ ...base, lane: "LOCAL", agentStatus: "error", agentError: "error: unknown option '- gather children'" });
    expect(container!.textContent).toContain("unknown option '- gather children'");
  });

  test("a healthy card shows no error text", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, lane: "LOCAL", agentStatus: "done", agentError: undefined });
    expect(container!.textContent).not.toContain("error:");
  });
});

  test("Copy CLI is offered for a local worktree and withheld for one on another instance", async () => {
    // Kept deliberately while the chat takes over: it's the escape hatch to a real terminal. But the
    // command cds into a path on the machine that RUNS the repo, so for a session reported by another
    // instance it would hand you a directory that doesn't exist here.
    await mount({ ...base, sessionId: "claude-1" });
    await openCopyMenu();
    expect(menuItem("Copy CLI")).not.toBeNull();

    await mount({ ...base, sessionId: "claude-1", remote: true, instance: "cloud" });
    await openCopyMenu();
    expect(menuItem("Copy CLI")).toBeNull();
  });
