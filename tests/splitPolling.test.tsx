// Local-agent status, open PRs, and merged history poll as three independent streams (store.ts).
// The invariant that most easily breaks under a split: GC must judge a branch against the MERGED view
// of all streams' latest values, not just the one stream that happened to poll — else a fast
// agents-only refresh drops a branch that only exists as an open PR. Driven against the real store.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { apiFake } from "./apiFake";
import * as store from "@/store";

const KEY = "orca.enrichment";
const read = () => JSON.parse(localStorage.getItem(KEY) ?? "{}");

beforeAll(() => store.configReady); // config repo is "r"
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(() => apiFake.reset());

test("keeps enrichment for a branch that exists only as an open PR (not as a worktree)", async () => {
  apiFake.prsData = [{ branch: "haspr", number: 7, title: "Has PR", url: "u", isDraft: false }]; // agents stream is empty
  localStorage.setItem(KEY, JSON.stringify({ "r::haspr": { prompt: "keep, still open" } }));

  await store.refresh();

  // GC saw an empty agents slice but the retained PR slice still lists haspr → kept, not pruned.
  expect(read()["r::haspr"]).toBeDefined();
});

test("prunes a branch once it's absent from every stream's latest view", async () => {
  localStorage.setItem(KEY, JSON.stringify({ "r::orphan": { prompt: "no worktree, no PR" } }));

  await store.refresh(); // agents [], prs [], merged []

  expect(read()["r::orphan"]).toBeUndefined();
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
