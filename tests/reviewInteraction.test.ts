// Address review must reliably interact with EVERY outstanding thread. The agent decides and executes,
// but the harness gives it a live enumerate-and-verify loop so it can't work from a stale/partial
// snapshot: list open threads, respond to each (reply + resolve, even "not relevant"), then re-list
// and confirm none remain. Pure prompt assertions.
import { describe, expect, test } from "bun:test";
import { addressReviewPrompt } from "@/workstream";
import type { ReviewThreadEvidence } from "../server/gh";

const threads: ReviewThreadEvidence[] = [
  { id: "PRRT_abc", path: "src/a.ts", line: 12, author: "alice", body: "Handle the null case", resolved: false },
  { id: "PRRT_def", body: "Rename this", resolved: false },
];

describe("address review reliably clears every thread", () => {
  test("gives the agent a live list command it can re-run to find outstanding threads", () => {
    const p = addressReviewPrompt({ prNumber: 7, branch: "feat" }, [], threads);
    expect(p).toContain("reviewThreads(first:100)");            // enumerate the live threads
    expect(p).toContain("select(.isResolved|not)");             // only the open ones
    expect(p).toContain("-F p=7");                              // scoped to this PR
    expect(p).toContain("re-run the list command and confirm it prints nothing"); // verify loop
    expect(p).toContain("not just the snapshot");               // don't trust the static list
  });

  test("the agent executes reply and resolve itself, for every thread including not-relevant ones", () => {
    const p = addressReviewPrompt({ prNumber: 7, branch: "feat" }, [], threads);
    expect(p).toContain("addPullRequestReviewThreadReply"); // it replies
    expect(p).toContain("resolveReviewThread");             // it resolves
    expect(p).toContain("Respond to EVERY thread");
    expect(p).toContain("NOT relevant");                    // reply + resolve even these
    expect(p).toContain("Thread PRRT_abc");                 // the snapshot ids are still provided as a head start
  });

  test("a followed run also engages the wider conversation; a manual run does not", () => {
    const followed = addressReviewPrompt({ prNumber: 7, branch: "feat" }, [], threads, true);
    expect(followed).toContain("actively followed");
    expect(followed).toContain("gh pr view 7 --comments");

    const manual = addressReviewPrompt({ prNumber: 7, branch: "feat" }, [], threads, false);
    expect(manual).not.toContain("actively followed");
    expect(manual).toContain("resolveReviewThread"); // reply+resolve is unconditional
  });

  test("with no snapshot it still hands the agent the live list + verify loop", () => {
    const p = addressReviewPrompt({ prNumber: 7, branch: "feat" });
    expect(p).toContain("reviewThreads(first:100)");
    expect(p).toContain("confirm it prints nothing");
  });
});
