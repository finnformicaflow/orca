// Enrichment lives in the bridge's SQLite store, not localStorage. The store keeps a synchronous
// in-memory MIRROR of it: reads stay sync (they happen during render), writes go through the server
// and re-hydrate on the next poll.
//
// This file replaces the old enrichment-GC suite. That GC existed to bound a 5MB localStorage bucket
// by PRUNING entries for branches that no longer existed — which is now precisely the wrong
// behaviour: a merged branch's conversation is exactly what a future chat-chain would reference.
// Retention is the contract these cases pin instead.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";

const KEY = "orca.enrichment";
const stored = (branch: string) => apiFake.enrichmentData.get(`r::${branch}`);
const row = (branch: string, extra: Partial<store.Row> = {}): store.Row =>
  ({ repo: "r", hasRemote: false, branch, title: branch, prompt: "", lane: "LOCAL", ...extra });

beforeAll(() => store.configReady); // config repo is "r"
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(() => apiFake.reset());

test("enrichment for a branch that's no longer live is RETAINED, not pruned", async () => {
  apiFake.worktrees.set("alive", { branch: "alive", worktreePath: "/wt/alive" }); // agents → [alive]
  apiFake.enrichmentData.set("r::alive", { prompt: "keep me" });
  apiFake.enrichmentData.set("r::gone", { prompt: "merged last week", followUps: ["do x"] });

  await store.refresh();

  // The old GC deleted "gone" here. The server archives finished workstreams instead, so nothing is
  // destroyed — and a stray entry renders nothing, since rows are built from live PRs + worktrees.
  expect(stored("alive")).toBeDefined();
  expect(stored("gone")).toBeDefined();
});

test("a transient poll failure leaves the mirror alone", async () => {
  apiFake.worktrees.set("alive", { branch: "alive", worktreePath: "/wt/alive" });
  apiFake.enrichmentData.set("r::alive", { prompt: "still here" });
  await store.refresh();

  apiFake.prsError = "network blip";
  await store.refresh();

  expect(store.enrichmentFor("r", "alive").prompt).toBe("still here");
});

test("a write reaches the server, and the mirror updates without waiting for it", async () => {
  apiFake.worktrees.set("feat", { branch: "feat", worktreePath: "/wt/feat" });
  await store.refresh();

  store.toggleFollow(row("feat"));

  // Mirror is optimistic — readable before any round-trip resolves, so the UI never lags a click.
  expect(store.enrichmentFor("r", "feat").following).toBe(true);
  await Promise.resolve();
  expect(stored("feat")).toMatchObject({ following: true });
});

test("clearing a field travels as null, since JSON.stringify drops undefined keys", async () => {
  apiFake.worktrees.set("feat", { branch: "feat", worktreePath: "/wt/feat" });
  apiFake.enrichmentData.set("r::feat", { following: true, followSig: "ci:failing" });
  await store.refresh();

  // Turning follow OFF clears followSig so re-enabling addresses current state.
  store.toggleFollow(row("feat", { following: true }));
  await Promise.resolve();

  expect(stored("feat")).toEqual({ following: false }); // followSig deleted, not left behind as undefined
});

test("a browser's pre-DB localStorage is handed to the bridge once, transcripts included", async () => {
  // Simulates upgrading an existing install: the only copy of this history is in the browser.
  localStorage.setItem(KEY, JSON.stringify({
    "r::feat": {
      prompt: "the original task", title: "Original",
      transcript: [{ id: "run-1", provider: "claude", prompt: "do it", response: "did it" }],
    },
  }));

  await store.migrateLocalEnrichment();

  expect(stored("feat")).toMatchObject({ prompt: "the original task", title: "Original" });
  // Transcript stays in the blob too — the resume guard and cross-provider handoff read it, so
  // stripping it would break a card that's mid-flight at upgrade time. Also surfaced as a turn.
  expect((stored("feat") as { transcript?: unknown[] }).transcript).toHaveLength(1);
  expect(apiFake.turnsData.get("r::feat")).toHaveLength(1); // and shows in the Chat tab
  expect(localStorage.getItem(KEY)).toBeNull(); // dropped only after the server confirmed
});

test("a card stuck on a dead session survives migration — the guard still starts fresh", async () => {
  // The upgrade worry made concrete: a card mid-flight on a session the provider can't find. Its
  // failed transcript must survive the localStorage→DB migration, or the guard goes blind and the
  // next follow-up resumes the dead session and errors — the exact regression to avoid.
  const dead = "23c3e70d-dead";
  localStorage.setItem(KEY, JSON.stringify({
    "r::feat": {
      prompt: "task", agentProvider: "claude", sessionId: dead,
      transcript: [{ id: "t1", provider: "claude", sessionId: dead, prompt: "go", response: "No conversation found with session ID: 23c3e70d-dead", failed: true }],
    },
  }));
  await store.migrateLocalEnrichment();
  await store.refresh(); // hydrate the mirror from the "DB"

  apiFake.worktrees.set("feat", { branch: "feat", worktreePath: "/wt/feat" });
  await store.followUp({ repo: "r", hasRemote: false, branch: "feat", title: "t", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", agentProvider: "claude", sessionId: dead } as store.Row, "retry", [], { provider: "claude" });

  const launch = apiFake.agentLaunches.at(-1)!;
  expect(launch.resume).toBeUndefined();     // NOT resuming the dead session that survived migration
  expect(launch.handoffFrom).toBe("claude"); // fresh, seeded from the migrated transcript
});

test("migration keeps the local blob if the handover fails, so the only copy isn't lost", async () => {
  localStorage.setItem(KEY, JSON.stringify({ "r::feat": { prompt: "precious" } }));
  apiFake.importError = "bridge down";

  await store.migrateLocalEnrichment();

  expect(localStorage.getItem(KEY)).not.toBeNull();
});

test("migration doesn't overwrite what the DB already owns", async () => {
  apiFake.enrichmentData.set("r::feat", { prompt: "the DB's version" });
  localStorage.setItem(KEY, JSON.stringify({ "r::feat": { prompt: "a stale browser's version" } }));

  await store.migrateLocalEnrichment();

  expect(stored("feat")).toEqual({ prompt: "the DB's version" });
});

test("a poll landing mid-write doesn't revert the mirror to the server's older copy", async () => {
  // The regression: hydration replaces the mirror from the server, and a poll that started before a
  // write returns data predating it. `runFollowers` records followSig BEFORE firing precisely so a
  // steady blocker acts once — silently losing it re-fires the same action on the next poll.
  apiFake.worktrees.set("feat", { branch: "feat", worktreePath: "/wt/feat" });
  apiFake.enrichmentData.set("r::feat", { prompt: "task" });
  await store.refresh();

  apiFake.holdEnrichmentWrites = true;
  store.toggleFollow(row("feat"));          // mirror says following; the POST is stuck in flight
  await store.refresh();                    // hydrates from a server that hasn't seen the write

  expect(store.enrichmentFor("r", "feat").following).toBe(true);

  apiFake.releaseEnrichmentWrites?.();
  await Promise.resolve();
  expect(stored("feat")).toMatchObject({ following: true });
});
