// Address review must close the loop on GitHub — reply to and resolve each thread the agent handled
// — not just push a commit (the reported gap: comments came through but nothing responded/resolved).
// A followed run additionally engages the wider PR conversation. Pure prompt assertions.
import { describe, expect, test } from "bun:test";
import { addressReviewPrompt } from "@/workstream";
import type { ReviewThreadEvidence } from "../server/gh";

const threads: ReviewThreadEvidence[] = [
  { id: "PRRT_abc", path: "src/a.ts", line: 12, author: "alice", body: "Handle the null case", resolved: false },
  { id: "PRRT_def", body: "Rename this", resolved: false },
];

describe("address review closes the loop on GitHub", () => {
  test("instructs the agent to reply to AND resolve each handled thread, with the exact gh calls", () => {
    const p = addressReviewPrompt({ prNumber: 7, branch: "feat" }, [], threads);
    expect(p).toContain("addPullRequestReviewThreadReply"); // reply
    expect(p).toContain("resolveReviewThread");             // resolve
    expect(p).toContain("THREAD_ID");                        // told where the id comes from
    expect(p).toContain("Thread PRRT_abc");                  // the real thread ids are supplied
    expect(p).toContain("Thread PRRT_def");
    // A thread it can't handle must be answered, not silently resolved.
    expect(p).toContain("could NOT address");
    expect(p).toContain("never resolve a thread you didn't handle");
  });

  test("a followed run also engages the wider conversation; a manual run does not", () => {
    const followed = addressReviewPrompt({ prNumber: 7, branch: "feat" }, [], threads, true);
    expect(followed).toContain("actively followed");
    expect(followed).toContain("gh pr view 7 --comments");
    expect(followed).toContain("reply to any open question");

    const manual = addressReviewPrompt({ prNumber: 7, branch: "feat" }, [], threads, false);
    expect(manual).not.toContain("actively followed");
    // …but the reply+resolve instruction is unconditional.
    expect(manual).toContain("resolveReviewThread");
  });

  test("with no collected threads it still tells the agent to reply+resolve after reading comments", () => {
    const p = addressReviewPrompt({ prNumber: 7, branch: "feat" });
    expect(p).toContain("gh pr view 7 --comments");
    expect(p).toContain("resolveReviewThread");
  });
});
