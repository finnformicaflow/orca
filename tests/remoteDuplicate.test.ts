// A drifted hostname leaves a prior identity's worktree in the shared inventory, so /api/agents can
// return the SAME branch twice: the live local row and a stale remote one. The board must render the
// LOCAL row — the remote duplicate must not shadow it, or the card shows the remote's stale status
// and hides Copy CLI (its `cd` path is local). Driven through the store's real assembly, no network.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { apiFake } from "./apiFake";
import * as store from "@/store";

beforeAll(() => store.configReady);
const poll = () => act(async () => { await store.refresh(); });
afterEach(async () => { apiFake.reset(); localStorage.clear(); await store.refresh(); });

test("a live local worktree wins over a stale remote duplicate of the same branch", async () => {
  apiFake.prsData = [{ number: 5021, title: "Activity feed", branch: "feat-x", base: "master", url: "u", state: "OPEN", isDraft: false, autoMergeEnabled: false, ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", externalFeedback: 0 }];
  // Same branch from two instances: the live local one (running) and a stale remote one (done).
  apiFake.agentsData = [
    { branch: "feat-x", worktreePath: "/wt/feat-x", agentStatus: "running" },
    { branch: "feat-x", worktreePath: "/wt/feat-x", agentStatus: "done", remote: true, instance: "old-hostname" },
  ];
  await poll();
  const row = store.assembleRows().find((r) => r.branch === "feat-x")!;
  expect(row).toBeTruthy();
  expect(row.remote).toBeFalsy();            // NOT tagged remote → Copy CLI stays available
  expect(row.agentStatus).toBe("running");   // the live status, not the stale "done"
  expect(row.worktreePath).toBe("/wt/feat-x");
});

test("order-independent: the remote row first, local second, still yields the local row", async () => {
  apiFake.prsData = [{ number: 1, title: "t", branch: "feat-y", base: "master", url: "u", state: "OPEN", isDraft: false, autoMergeEnabled: false, ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", externalFeedback: 0 }];
  apiFake.agentsData = [
    { branch: "feat-y", worktreePath: "/wt/feat-y", agentStatus: "idle", remote: true, instance: "old" },
    { branch: "feat-y", worktreePath: "/wt/feat-y", agentStatus: "running" },
  ];
  await poll();
  const row = store.assembleRows().find((r) => r.branch === "feat-y")!;
  expect(row.remote).toBeFalsy();
  expect(row.agentStatus).toBe("running");
});

test("a genuinely remote-only branch stays remote (no local row to prefer)", async () => {
  apiFake.prsData = [{ number: 2, title: "t", branch: "feat-z", base: "master", url: "u", state: "OPEN", isDraft: false, autoMergeEnabled: false, ciStatus: "passing", reviewStatus: "review_required", mergeable: "MERGEABLE", externalFeedback: 0 }];
  apiFake.agentsData = [{ branch: "feat-z", worktreePath: "/wt/feat-z", agentStatus: "idle", remote: true, instance: "cloud" }];
  await poll();
  const row = store.assembleRows().find((r) => r.branch === "feat-z")!;
  expect(row.remote).toBe(true);
});
