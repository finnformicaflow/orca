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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };
// The top-right copy affordance is a Radix dropdown — open it with a real PointerEvent (Radix opens
// menus on pointerdown, not click) so its items (portalled to document.body) render.
const openCopyMenu = async () => {
  const trigger = container!.querySelector<HTMLElement>('button[title="Copy…"]')!;
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await flush(); await flush(); });
};

let copied = "";
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } },
});

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(row: Row) {
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
  test("the card shows only the agent picker — no model or context-fill readout", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, agentProvider: "claude", agentMeta: { model: "Opus 4.8", contextPct: 12 } });
    const picker = container!.querySelector<HTMLElement>('[aria-label="Agent for this card"]');
    expect(picker?.textContent).toContain("Claude");
    expect(container!.textContent).not.toContain("Opus 4.8");
    expect(container!.textContent).not.toContain("ctx");
  });

  test("the agent picker names the run's provider, without a token/cost tooltip", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, agentProvider: "codex", agentMeta: { model: "Codex", inputTokens: 1234, outputTokens: 56, cacheReadTokens: 900 } });
    const picker = container!.querySelector<HTMLElement>('[aria-label="Agent for this card"]');
    expect(picker?.textContent).toContain("Codex");
    expect([...container!.querySelectorAll("[title]")].some((n) => n.getAttribute("title")?.includes("in / "))).toBe(false);
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

  test("a PR card's copy menu offers Copy PR link, which copies the PR url", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount(base);
    await openCopyMenu();
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"][title="Copy PR link"]')!;
    expect(item).not.toBeNull();
    await click(item);
    expect(copied).toBe("https://x/7");
  });

  test("a PR card's copy menu also offers Copy worktree name", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount(base);
    await openCopyMenu();
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"][title="Copy worktree name"]')!;
    expect(item).not.toBeNull();
    await click(item);
    expect(copied).toBe("enrich-cards-1");
  });

  test("a card's copy menu offers Copy CLI; a card with no agent run yet gets a fresh session", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount(base); // adopted PR: worktree but no agent has run here, so no conversation to continue
    await openCopyMenu();
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"][title="Copy CLI: resume this agent\'s session in a terminal"]')!;
    expect(item).not.toBeNull();
    await click(item);
    expect(copied).toBe(`cd "/wt/enrich-cards-1" && claude --permission-mode auto`); // fresh, NOT --continue
  });

  test("Copy CLI --resume's the persisted session id when there is one", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, sessionId: "abc-123" });
    await openCopyMenu();
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"][title="Copy CLI: resume this agent\'s session in a terminal"]')!;
    await click(item);
    expect(copied).toBe(`cd "/wt/enrich-cards-1" && claude --resume abc-123 --permission-mode auto`);
  });

  test("Copy CLI includes non-interactive Codex exec sessions when resuming", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, agentProvider: "codex", sessionId: "codex-123" });
    await openCopyMenu();
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"][title="Copy CLI: resume this agent\'s session in a terminal"]')!;
    await click(item);
    expect(copied).toBe(`cd "/wt/enrich-cards-1" && codex resume --include-non-interactive --dangerously-bypass-approvals-and-sandbox codex-123`);
  });

  test("a local card's copy menu has no Copy PR link option, only the worktree name", async () => {
    apiFake.summaryData = { files: [{}], commits: [{}], additions: 1, deletions: 0 };
    await mount({ ...base, lane: "LOCAL", prNumber: undefined, prUrl: undefined });
    await openCopyMenu();
    expect(document.body.querySelector('[role="menuitem"][title="Copy PR link"]')).toBeNull();
    expect(document.body.querySelector('[role="menuitem"][title="Copy worktree name"]')).not.toBeNull();
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
