// Why a turn ended, recorded as a column (shared/agent.ts StopReason — Managed Agents' vocabulary):
// end_turn, budget_reached, interrupted, error. Driven through the real launcher with a fake `claude`
// on PATH and a real Postgres, the same harness as chatHistory.test.ts. Also pins two things that
// ride along: the per-repo cost cap reaches the CLI as --max-budget-usd, and Orca's own secrets
// never reach the agent's environment.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import { parseConfigDocument } from "../server/config";
import { freshSchema, type TestDb } from "./pg";

let dir: string;
let shim: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, PATH: process.env.PATH, SLACK_TOKEN: process.env.SLACK_TOKEN };
  dir = await mkdtemp(join(tmpdir(), "orca-stop-"));
  shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
  process.env.ORCA_STATE_DIR = dir;
  process.env.PATH = `${shim}:${prev.PATH}`;
  process.env.SLACK_TOKEN = "xoxp-secret"; // the bridge's, which the agent must not see
  pg = await freshSchema("stopreason");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
  await rm(shim, { recursive: true, force: true });
});

/** A fake claude whose stdout is `script`'s output. */
async function fakeClaude(script: string): Promise<void> {
  await writeFile(join(shim, "claude"), `#!/bin/sh\n${script}\n`);
  await chmod(join(shim, "claude"), 0o755);
}
async function run(branch: string, prompt = "go"): Promise<string> {
  const wt = join(dir, branch);
  await mkdir(wt, { recursive: true });
  await agent.runAgent(wt, prompt, { repo: "r", branch, provider: "claude", maxBudgetUsd: 5 });
  return wt;
}
async function finished(branch: string) {
  for (let i = 0; i < 400 && !(await db.turns("r", branch))[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
  return (await db.turns("r", branch))[0]!;
}

test("a normal finish is end_turn, the cost cap reaches the CLI, and Orca's secrets don't", async () => {
  // The fake reports its own argv and environment so the assertions read what the CLI would have.
  await fakeClaude(`printf '{"type":"result","subtype":"success","result":"budget=%s slack=[%s] db=[%s]","is_error":false}' "$(echo "$@" | grep -o -- '--max-budget-usd [0-9]*')" "$SLACK_TOKEN" "$ORCA_DATABASE_URL"`);
  await run("normal");
  const turn = await finished("normal");
  expect(turn.stopReason).toBe("end_turn");
  expect(turn.response).toContain("budget=--max-budget-usd 5");
  expect(turn.response).toContain("slack=[] db=[]");
});

test("hitting the cost cap records budget_reached rather than a bare error", async () => {
  await fakeClaude(`printf '{"type":"result","subtype":"error_max_budget_usd","result":"Budget of $5 reached","is_error":true}'; exit 1`);
  await run("capped");
  const turn = await finished("capped");
  expect(turn.stopReason).toBe("budget_reached");
  expect(turn.failed).toBe(true); // still not a success — the work stopped early
});

test("a run you stop is interrupted, not an error", async () => {
  await fakeClaude(`sleep 30`);
  const wt = await run("stopped");
  await new Promise((r) => setTimeout(r, 100));
  agent.stop(wt);
  const turn = await finished("stopped");
  expect(turn.stopReason).toBe("interrupted");
  expect(turn.stopped).toBe(true);
});

test("a crash is error", async () => {
  await fakeClaude(`echo boom >&2; exit 2`);
  await run("crashed");
  expect((await finished("crashed")).stopReason).toBe("error");
});

test("the per-repo cost cap is validated", () => {
  const doc = (agentMaxBudgetUsd: unknown) => ({
    repos: [{ name: "app", repoPath: "/a", worktreeRoot: "/a/.wt", baseBranch: "main", agentMaxBudgetUsd }],
    portRange: [30000, 40000], staleHours: 24,
  });
  expect(parseConfigDocument(doc(-1)).errors).toContain("repos[0].agentMaxBudgetUsd must be a positive number of dollars");
  expect(parseConfigDocument(doc("5")).errors).toContain("repos[0].agentMaxBudgetUsd must be a positive number of dollars");
  expect(parseConfigDocument(doc(2.5)).config?.repos[0]?.agentMaxBudgetUsd).toBe(2.5);
  expect(parseConfigDocument(doc(undefined)).errors).toEqual([]);
});
