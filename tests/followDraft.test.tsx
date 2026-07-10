// A follow-up prompt is recorded in the durable enrichment blob the instant it's SENT (store.followUp
// writes lastFollowUp before the upload/adopt/launch), so it survives any downstream failure — a
// failed worktree adopt, a claude launch error, or the headless run erroring after a clean spawn.
// It's kept under the same repo::branch key as the original prompt until the branch is
// merged/discarded (deleteEnrich wipes the whole entry). Driven against the real store + apiFake.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import type { Row } from "@/store";

const KEY = "orca.enrichment";
const row: Row = {
  repo: "branch-demo", hasRemote: true, branch: "feat", title: "Feat", prompt: "orig task",
  lane: "IN_REVIEW", worktreePath: "/wt/feat", prNumber: 7, prUrl: "https://x/7",
};

beforeEach(() => localStorage.clear());
afterEach(() => apiFake.reset());

test("followUp records the sent prompt in enrichment even when the launch fails", async () => {
  localStorage.setItem(KEY, JSON.stringify({ "branch-demo::feat": { prompt: "orig task" } }));
  apiFake.claudeError = "launch boom"; // simulate the send failing after it's been recorded

  await store.followUp(row, "my important follow-up I don't want to lose").catch(() => {});

  const blob = JSON.parse(localStorage.getItem(KEY)!);
  expect(blob["branch-demo::feat"].lastFollowUp).toBe("my important follow-up I don't want to lose");
  expect(blob["branch-demo::feat"].prompt).toBe("orig task"); // merged, not clobbered
});

test("a successful follow-up is still kept (it's the branch's last-sent record, not a transient draft)", async () => {
  await store.followUp(row, "make the button blue").catch(() => {});
  const blob = JSON.parse(localStorage.getItem(KEY)!);
  expect(blob["branch-demo::feat"].lastFollowUp).toBe("make the button blue");
});
