// The verification gate (server/check.ts): after a run that COMMITTED, Orca runs the repo's own
// check command in the worktree and records the result on the turn — deterministic evidence, not
// the agent's word. With autofix on, one failure queues one fix follow-up carrying the output, and
// a fix that fails again stops there. Real git scratch repo, a fake `claude` that commits, real
// Postgres — the same harness as chatHistory.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import { parseConfigDocument } from "../server/config";
import { AUTOFIX_MARKER, autofixInstruction, isAutofix } from "../shared/agent";
import { makeScratchRepo } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string;
let shim: string;
let repo: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  prev = { ORCA_STATE_DIR: process.env.ORCA_STATE_DIR, ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, PATH: process.env.PATH };
  state = await mkdtemp(join(tmpdir(), "orca-gate-"));
  shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
  repo = await makeScratchRepo();
  process.env.ORCA_STATE_DIR = state;
  process.env.PATH = `${shim}:${prev.PATH}`;
  pg = await freshSchema("verifygate");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  agent.onQueuedMessage(async () => {});
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo]) await rm(d, { recursive: true, force: true });
});

/** A fake claude: commits (or not), then reports. */
async function fakeClaude(commit: boolean): Promise<void> {
  const work = commit ? `git commit -q --allow-empty -m "agent work"` : "true";
  await writeFile(join(shim, "claude"), `#!/bin/sh\n${work}\nprintf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'\n`);
  await chmod(join(shim, "claude"), 0o755);
}
/** Wait until `n` turns exist and every finished one that committed has its check recorded. */
async function settled(n: number) {
  for (let i = 0; i < 400; i++) {
    const turns = await db.turns("r", "feat");
    if (turns.length >= n && turns.every((t) => t.finishedAt) && !agent.isRunning(repo)) {
      await new Promise((r) => setTimeout(r, 50)); // the check write lands just after the finish write
      return db.turns("r", "feat");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("runs never settled");
}

test("a run that committed is checked with the repo's command; the result lands on the turn", async () => {
  await fakeClaude(true);
  await agent.runAgent(repo, "do it", { repo: "r", branch: "feat", provider: "claude", instruction: "do it", check: { command: "echo all good", autofix: false } });
  const [turn] = await settled(1);
  expect(turn?.check).toMatchObject({ command: "echo all good", ok: true, exitCode: 0, output: "all good" });
  expect(agent.status(repo).check?.ok).toBe(true); // the card's badge reads the live run
});

test("a run that made no commit is not checked — there is nothing to verify", async () => {
  await fakeClaude(false);
  await agent.runAgent(repo, "just answer", { repo: "r", branch: "feat", provider: "claude", instruction: "just answer", check: { command: "exit 1", autofix: true } });
  const [turn] = await settled(1);
  expect(turn?.check).toBeUndefined();
  expect(await db.queuedMessages("r", "feat")).toEqual([]);
});

test("a failed check queues ONE fix follow-up with the output as evidence, never a loop", async () => {
  await fakeClaude(true);
  const launches: string[] = [];
  // The same relay index.ts installs: a queued message becomes the next run, with the same gate.
  agent.onQueuedMessage(async (m) => {
    launches.push(m.instruction);
    await agent.runAgent(m.worktreePath, m.instruction, { repo: "r", branch: "feat", provider: "claude", instruction: m.instruction, check: { command: "echo still broken >&2; exit 3", autofix: true } });
  });
  await agent.runAgent(repo, "ship it", { repo: "r", branch: "feat", provider: "claude", instruction: "ship it", check: { command: "echo still broken >&2; exit 3", autofix: true } });
  const turns = await settled(2);

  expect(turns).toHaveLength(2);
  expect(turns[0]?.check).toMatchObject({ ok: false, exitCode: 3, output: "still broken" });
  // The fix attempt is an ordinary follow-up whose instruction carries the evidence…
  expect(launches).toHaveLength(1);
  expect(turns[1]?.instruction?.startsWith(AUTOFIX_MARKER)).toBe(true);
  expect(turns[1]?.instruction).toContain("still broken");
  // …and its own failure does NOT queue a third run.
  expect(turns[1]?.check?.ok).toBe(false);
  expect(await db.queuedMessages("r", "feat")).toEqual([]);
});

test("with autofix off, a failed check is recorded and nothing else happens", async () => {
  await fakeClaude(true);
  await agent.runAgent(repo, "ship it", { repo: "r", branch: "feat", provider: "claude", instruction: "ship it", check: { command: "exit 1", autofix: false } });
  const [turn] = await settled(1);
  expect(turn?.check?.ok).toBe(false);
  expect(await db.queuedMessages("r", "feat")).toEqual([]);
});

test("the autofix instruction is recognisable as its own loop guard, and checkCommand is validated", () => {
  const text = autofixInstruction({ command: "bun run check", ok: false, exitCode: 1, output: "1 fail", durationMs: 5 });
  expect(isAutofix(text)).toBe(true);
  expect(isAutofix("fix the tests please")).toBe(false);
  expect(isAutofix(undefined)).toBe(false);
  expect(text).toContain("`bun run check` exited 1");
  const doc = (checkCommand: unknown) => ({ repos: [{ name: "app", repoPath: "/a", worktreeRoot: "/a/.wt", baseBranch: "main", checkCommand }], portRange: [30000, 40000], staleHours: 24 });
  expect(parseConfigDocument(doc("  ")).errors).toContain("repos[0].checkCommand must be a shell command");
  expect(parseConfigDocument(doc("bun run check")).config?.repos[0]?.checkCommand).toBe("bun run check");
});
