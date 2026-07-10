// Follow-up prompts are recorded in the durable enrichment blob the instant they're SENT
// (store.followUp appends to followUps before the upload/adopt/launch), so they survive any
// downstream failure and can be recalled with ↑ in the composer. Kept under the branch's
// repo::branch key until it's merged/discarded, then wiped (deleteEnrich / GC). Driven against the
// real store + apiFake.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { Row } from "@/store";
import { stepHistory } from "@/components/ChatComposer";

const KEY = "orca.enrichment";
const row: Row = {
  repo: "branch-demo", hasRemote: true, branch: "feat", title: "Feat", prompt: "orig task",
  lane: "IN_REVIEW", worktreePath: "/wt/feat", prNumber: 7, prUrl: "https://x/7",
};
const enrich = () => JSON.parse(localStorage.getItem(KEY)!)["branch-demo::feat"];

beforeEach(() => localStorage.clear());
afterEach(() => apiFake.reset());

test("followUp records the sent prompt even when the launch fails, and appends a history", async () => {
  localStorage.setItem(KEY, JSON.stringify({ "branch-demo::feat": { prompt: "orig task" } }));
  apiFake.claudeError = "launch boom"; // send fails after it's recorded

  await store.followUp(row, "first ask").catch(() => {});
  await store.followUp(row, "second ask").catch(() => {});
  await store.followUp(row, "second ask").catch(() => {}); // consecutive dupe (resend) — not re-appended

  expect(enrich().followUps).toEqual(["first ask", "second ask"]);
  expect(enrich().prompt).toBe("orig task"); // merged, not clobbered
});

test("merge clears the branch's enrichment (Done cards render from gh data, not enrichment)", async () => {
  localStorage.setItem(KEY, JSON.stringify({ "branch-demo::feat": { prompt: "orig task", followUps: ["x"] } }));
  await store.merge(row).catch(() => {});
  expect(JSON.parse(localStorage.getItem(KEY)!)["branch-demo::feat"]).toBeUndefined();
});

test("stepHistory walks oldest↕newest and falls off the newest end to an empty box", () => {
  // 3 entries, indices 0..2 (2 = newest)
  expect(stepHistory(null, "up", 3)).toBe(2); // first ↑ → newest
  expect(stepHistory(2, "up", 3)).toBe(1);
  expect(stepHistory(1, "up", 3)).toBe(0);
  expect(stepHistory(0, "up", 3)).toBe(0); // clamps at oldest
  expect(stepHistory(1, "down", 3)).toBe(2);
  expect(stepHistory(2, "down", 3)).toBeNull(); // past newest → empty box
  expect(stepHistory(null, "down", 3)).toBeNull();
  expect(stepHistory(null, "up", 0)).toBeNull(); // no history → nothing
});
