// Renaming a card. Cards auto-title from the prompt at creation, but that can come out broken (an
// adopted PR whose title is just its branch slug, or a failed AI summary). Rename lets the AI
// re-name it — editable — and persists: a PR row edits the GitHub PR title (its title IS the card's),
// a local row records the name in enrichment. These pin the store contract behind the Rename dialog.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";

const row = (extra: Partial<store.Row> = {}): store.Row =>
  ({ repo: "r", hasRemote: true, branch: "feat", title: "feat", prompt: "add a cache layer", lane: "LOCAL", ...extra });

beforeAll(() => store.configReady); // config repo is "r"
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(() => apiFake.reset());

test("Suggest asks the pinned provider to name the card from its prompt (or PR number)", async () => {
  apiFake.suggestTitleReply = "Cache Layer";
  const title = await store.suggestTitle(row({ agentProvider: "codex", prNumber: 42 }));

  expect(title).toBe("Cache Layer");
  expect(apiFake.suggestTitleCalls).toHaveLength(1);
  expect(apiFake.suggestTitleCalls[0]).toMatchObject({ provider: "codex", prompt: "add a cache layer", pr: 42 });
});

test("a promptless local card sends its branch + worktree so the server can still name it", async () => {
  // The "no context to name from" bug: an adopted local with no Orca prompt and no PR. Suggest must
  // still pass the branch + worktree path, from which the server names it (commit subjects / branch).
  await store.suggestTitle(row({ prompt: "", worktreePath: "/wt/feat" }));

  expect(apiFake.suggestTitleCalls[0]).toMatchObject({ branch: "feat", worktreePath: "/wt/feat" });
});

test("renaming a PR edits the GitHub PR title and records it in enrichment", async () => {
  await store.rename(row({ prNumber: 42 }), "Excel-like Cell Selection");

  expect(apiFake.renames).toHaveLength(1);
  expect(apiFake.renames[0]).toEqual({ branch: "feat", title: "Excel-like Cell Selection", pr: 42 });
  // Recorded locally too — shown for pre-PR locals, and a durable record for the PR.
  expect(apiFake.enrichmentData.get("r::feat")?.title).toBe("Excel-like Cell Selection");
});

test("renaming a pre-PR local carries no PR number (nothing to edit on GitHub)", async () => {
  await store.rename(row(), "Fresh Name");

  expect(apiFake.renames[0]).toEqual({ branch: "feat", title: "Fresh Name", pr: undefined });
  expect(apiFake.enrichmentData.get("r::feat")?.title).toBe("Fresh Name");
});
