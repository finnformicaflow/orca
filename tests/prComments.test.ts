// gh.conversationComments: the PR conversation items (issue comments + review summaries) newer than
// a point in time, from everyone but the PR's author — because Orca runs the agent AS the author, its
// own replies must never be re-surfaced. Deliberately no other filtering: bots and humans alike are
// surfaced, and what needs a response is the agent's decision. Real adapter via the gh PATH shim.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { conversationComments } from "../server/gh";
import { installFakeGh, makeScratchRepo, restorePath, setViewFixture } from "./helpers";

let repo: string;
beforeAll(async () => { await installFakeGh(); repo = await makeScratchRepo(); });
afterAll(() => restorePath());

const fixture = {
  author: { login: "me" },
  comments: [
    { id: "IC_1", author: { login: "eddy-ai-flow" }, body: "## Eddy QA Report\nCoverage incomplete", createdAt: "2026-09-11T15:06:00Z", url: "https://x/1" },
    { id: "IC_2", author: { login: "me" }, body: "my own reply", createdAt: "2026-09-11T15:28:00Z", url: "https://x/2" },
    { id: "IC_3", author: { login: "alice" }, body: "Can this handle the empty case?", createdAt: "2026-09-11T15:40:00Z", url: "https://x/3" },
    { id: "IC_4", author: { login: "bob" }, body: "   ", createdAt: "2026-09-11T15:41:00Z", url: "https://x/4" },
  ],
  reviews: [
    { id: "PRR_1", author: { login: "eddy-ai-flow" }, body: "", submittedAt: "2026-09-11T15:34:00Z", state: "COMMENTED" },
    { id: "PRR_2", author: { login: "eddy-ai-flow" }, body: "Combined automated review completed. Found 2 findings", submittedAt: "2026-09-11T15:35:00Z", state: "COMMENTED", url: "https://x/r2" },
    { id: "PRR_3", author: { login: "claudiosc8" }, body: "", submittedAt: "2026-09-11T15:38:00Z", state: "APPROVED" },
  ],
};

test("surfaces everyone else's comments and review summaries, oldest first, never the author's own", async () => {
  await setViewFixture(fixture);
  const items = await conversationComments(repo, 5021);
  expect(items.map((c) => c.id)).toEqual(["IC_1", "PRR_2", "IC_3"]); // chronological; me/blank/empty-body dropped
  expect(items.find((c) => c.id === "PRR_2")?.kind).toBe("review");
  expect(items.find((c) => c.id === "IC_1")?.author).toBe("eddy-ai-flow"); // a bot is surfaced, not judged
  expect(items.find((c) => c.id === "IC_3")?.url).toBe("https://x/3");
});

test("`since` returns only what was posted after the last hand-over", async () => {
  await setViewFixture(fixture);
  const items = await conversationComments(repo, 5021, "2026-09-11T15:35:00Z");
  expect(items.map((c) => c.id)).toEqual(["IC_3"]); // PRR_2 is at exactly 15:35 → already seen
});
