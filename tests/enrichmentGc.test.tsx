// Enrichment is garbage-collected on refresh: entries for branches that no longer exist (merged /
// closed / deleted — including outside Orca, the leaky case) are pruned, so the blob doesn't grow
// forever. Guarded so a transient poll failure can't wipe live enrichment, and a just-created
// draft (recent createdAt) isn't pruned before its worktree shows up. Driven against the real store.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";

const KEY = "orca.enrichment";
const read = () => JSON.parse(localStorage.getItem(KEY) ?? "{}");

beforeAll(() => store.configReady); // config repo is "r"
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(() => apiFake.reset());

test("prunes enrichment for a branch that's no longer live, keeps the live one", async () => {
  apiFake.worktrees.set("alive", { branch: "alive", worktreePath: "/wt/alive" }); // agents → [alive]
  localStorage.setItem(KEY, JSON.stringify({
    "r::alive": { prompt: "keep me" },
    "r::gone": { prompt: "merged last week", followUps: ["do x"] },
  }));

  await store.refresh();

  expect(read()["r::alive"]).toBeDefined();
  expect(read()["r::gone"]).toBeUndefined(); // GC'd — not in worktrees/prs/merged
});

test("a transient poll failure does NOT prune (guards against wiping live enrichment)", async () => {
  apiFake.worktrees.set("alive", { branch: "alive", worktreePath: "/wt/alive" });
  apiFake.prsError = "network blip"; // repo poll is now partial → ok=false
  localStorage.setItem(KEY, JSON.stringify({ "r::gone": { prompt: "still here" } }));

  await store.refresh();

  expect(read()["r::gone"]).toBeDefined(); // untouched despite not being "live" — the poll failed
});

test("a freshly-created draft (recent createdAt) is kept even before its worktree appears", async () => {
  localStorage.setItem(KEY, JSON.stringify({ "r::brand-new": { prompt: "just made", createdAt: new Date().toISOString() } }));

  await store.refresh(); // clean poll, "brand-new" not in live yet

  expect(read()["r::brand-new"]).toBeDefined(); // within the grace window
});
