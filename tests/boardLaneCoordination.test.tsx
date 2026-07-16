// The board must never paint a PARTIAL view where its three live streams (worktrees, open PRs, merged
// PRs) disagree — that's what made cards flash through the wrong lane. Two reported symptoms, one cause
// (the streams used to notify independently):
//   1. On load, a PR branch's worktree arrives before its PR, so the card briefly showed as LOCAL.
//   2. On merge, the streams reflected different moments → MERGEABLE → IN_REVIEW → LOCAL → DONE.
// Both are the same fix — notify once per COORDINATED poll (store: refreshAndGc) — so this exercises it
// via the load path (the merge path is the identical refreshAndGc code): it records every lane a branch
// renders in and asserts it never lands on a wrong intermediate lane.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => store.configReady);
const flush = () => new Promise((r) => setTimeout(r, 0));

const pr = (over: Record<string, unknown>) => ({
  number: 7, title: "feat", branch: "feat-x", url: "u", state: "OPEN", isDraft: false,
  ciStatus: "none", reviewStatus: "approved", mergeable: "MERGEABLE", autoMergeEnabled: false, ...over,
});

// Records the lane of branch `feat-x` on every render, so we can inspect the whole transition history.
const seen: string[] = [];
function Recorder() {
  const rows = store.useWorkstreams();
  const row = rows.find((r) => r.branch === "feat-x");
  if (row && seen[seen.length - 1] !== row.lane) seen.push(row.lane);
  return <span data-lane={row?.lane ?? "none"} />;
}

let root: Root | undefined;
let container: HTMLElement | undefined;
function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(<Recorder />); });
}

afterEach(async () => {
  seen.length = 0;
  apiFake.releasePrs?.(); // unblock any stream a failed test left held, or the refresh below hangs
  apiFake.holdPrs = false;
  apiFake.reset();
  localStorage.clear();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

test("a PR branch whose worktree loads before its PR never flashes as LOCAL", async () => {
  apiFake.worktrees.set("feat-x", { branch: "feat-x", worktreePath: "/wt/feat-x" });
  apiFake.prsData = [pr({})];
  apiFake.holdPrs = true; // agents settles first; PRs are still in flight
  mount();

  await act(async () => { void store.refresh(); await flush(); });
  // With the worktree known but the PR held, the OLD code notified off the agents stream alone and
  // rendered LOCAL. The coordinator must not have painted anything yet.
  expect(seen).not.toContain("LOCAL");

  await act(async () => { apiFake.releasePrs!(); await flush(); });
  expect(seen).toEqual(["MERGEABLE"]); // one clean transition into the correct lane
});
