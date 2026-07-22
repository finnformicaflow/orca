// Local-agent status, open PRs, and merged history poll as three independent streams (store.ts).
// Each keeps its own {ok} and `live` is the merge of the three streams' LATEST GOOD values, so one
// stream's transient failure never reads as "those branches are gone" and never drops what another
// stream retained. Driven against the real store.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";

beforeAll(() => store.configReady); // config repo is "r"
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(() => apiFake.reset());

test("a branch that exists only as an open PR still lands on the board", async () => {
  apiFake.prsData = [{ branch: "haspr", number: 7, title: "Has PR", url: "u", isDraft: false }]; // agents stream is empty
  apiFake.enrichmentData.set("r::haspr", { prompt: "still open" });

  await store.refresh();

  expect(store.enrichmentFor("r", "haspr").prompt).toBe("still open");
});

test("a failed PR poll doesn't drop the PRs the last good poll retained", async () => {
  apiFake.prsData = [{ branch: "haspr", number: 7, title: "Has PR", url: "u", isDraft: false }];
  await store.refresh();

  apiFake.prsError = "network blip";
  await store.refresh(); // agents + merged settle cleanly, PRs fail

  // `live` still carries the retained PR slice, so the board doesn't blink the row out of existence.
  expect(store.enrichmentFor("r", "haspr")).toBeDefined();
});

test("agents and PR streams poll independently of merged history", async () => {
  const before = store.clientPollCounts();
  await store.pollAgents();
  const afterAgents = store.clientPollCounts();
  expect(afterAgents.agents).toBe(before.agents + 1);
  expect(afterAgents.prs).toBe(before.prs); // pollAgents does not drag the PR or merged streams along

  await store.pollPrs();
  expect(store.clientPollCounts().prs).toBe(afterAgents.prs + 1);
  expect(store.clientPollCounts().merged).toBe(afterAgents.merged);
});
