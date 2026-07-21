// The durable chat history (server/db.ts). Before this, an agent's response lived only in the
// in-memory `runs` map until a browser poll happened to collect it — so a bridge restart, a closed
// tab, or a follow-up landing faster than the 8s poll destroyed the turn permanently. These cases
// pin the properties that fix: written at launch, keyed by runId, and archived rather than deleted.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";

let dir: string;
let prevStateDir: string | undefined;

beforeEach(async () => {
  prevStateDir = process.env.ORCA_STATE_DIR;
  dir = await mkdtemp(join(tmpdir(), "orca-db-"));
  process.env.ORCA_STATE_DIR = dir;
  db.close(); // drop any handle held against a previous state dir
});
afterEach(async () => {
  db.close();
  if (prevStateDir === undefined) delete process.env.ORCA_STATE_DIR; else process.env.ORCA_STATE_DIR = prevStateDir;
  await rm(dir, { recursive: true, force: true });
});

const start = (runId: string, prompt: string, branch = "feat") =>
  db.startTurn({ repo: "r", branch, runId, provider: "claude", prompt, sessionId: `sess-${runId}`, startedAt: Date.now() });

test("a turn is durable from launch, before the run produces any output", () => {
  start("run-1", "add the thing");

  // The whole point: this row exists while the agent is still working. A bridge restart here used to
  // lose the run entirely; now it survives as an interrupted turn.
  const [turn] = db.turns("r", "feat");
  expect(turn?.prompt).toBe("add the thing");
  expect(turn?.response).toBe("");
  expect(turn?.finishedAt).toBeUndefined();
});

test("completing a run fills in its response and structured outcome", () => {
  start("run-1", "add the thing");
  db.finishTurn("run-1", {
    status: "done", response: "## Outcome\nAdded it.",
    structured: { outcome: "Added it.", verification: ["bun test"], decisions: [], remaining: [], commits: ["abc123 add"] },
    sessionId: "sess-final", finishedAt: Date.now(),
  });

  const [turn] = db.turns("r", "feat");
  expect(turn?.response).toBe("## Outcome\nAdded it.");
  expect(turn?.structured?.commits).toEqual(["abc123 add"]);
  expect(turn?.sessionId).toBe("sess-final"); // Codex/Cursor only reveal theirs mid-run
  expect(turn?.failed).toBeUndefined();
});

test("a failed run keeps its error as the turn's outcome", () => {
  start("run-1", "break it");
  db.finishTurn("run-1", { status: "error", response: "exit 1", finishedAt: Date.now() });

  const [turn] = db.turns("r", "feat");
  expect(turn?.failed).toBe(true);
  expect(turn?.response).toBe("exit 1");
});

test("a fast follow-up can't overwrite the previous turn", () => {
  // The old in-memory map was keyed by WORKTREE PATH, so a second launch replaced the first run's
  // completed record before the client's next poll ever saw it. Turns are keyed by runId instead.
  start("run-1", "first");
  db.finishTurn("run-1", { status: "done", response: "first done", finishedAt: Date.now() });
  start("run-2", "second");
  db.finishTurn("run-2", { status: "done", response: "second done", finishedAt: Date.now() });

  expect(db.turns("r", "feat").map((t) => t.response)).toEqual(["first done", "second done"]);
});

test("history survives the branch it was made on", () => {
  start("run-1", "shipped work");
  db.finishTurn("run-1", { status: "done", response: "done", finishedAt: Date.now() });

  db.archive("r", "feat"); // merged + reaped

  // Gone from the LIVE view (the board shouldn't show it)...
  expect(db.turns("r", "feat")).toEqual([]);
  // ...but retained, which is what makes chaining from a merged conversation possible at all.
  const rows = db.db().query("SELECT COUNT(*) AS n FROM turn").get() as { n: number };
  expect(rows.n).toBe(1);
});

test("a reused branch name starts a fresh conversation, not the dead one's", () => {
  start("run-1", "original work");
  db.archive("r", "feat");

  start("run-2", "unrelated later work");

  // The partial unique index lets the name be reused; the archived workstream keeps its own history.
  expect(db.turns("r", "feat").map((t) => t.prompt)).toEqual(["unrelated later work"]);
});

test("turns are scoped per repo, so same-named branches in different repos don't merge", () => {
  start("run-1", "in repo r");
  db.startTurn({ repo: "other", branch: "feat", runId: "run-2", provider: "codex", prompt: "in repo other", startedAt: Date.now() });

  expect(db.turns("r", "feat").map((t) => t.prompt)).toEqual(["in repo r"]);
  expect(db.turns("other", "feat").map((t) => t.prompt)).toEqual(["in repo other"]);
});

test("relaunching the same runId doesn't duplicate the turn", () => {
  start("run-1", "once");
  start("run-1", "once");
  expect(db.turns("r", "feat")).toHaveLength(1);
});

test("the database is owner-only — it holds prompts and responses in plaintext", () => {
  start("run-1", "something sensitive");
  expect(statSync(join(dir, "orca.db")).mode & 0o777).toBe(0o600);
});

test("reopening the state dir keeps the history (it is a file, not a cache)", () => {
  start("run-1", "persisted");
  db.finishTurn("run-1", { status: "done", response: "still here", finishedAt: Date.now() });

  db.close(); // simulate a bridge restart

  expect(db.turns("r", "feat").map((t) => t.response)).toEqual(["still here"]);
});

// End-to-end through the real launcher, with a fake `claude` on PATH — the run records its own turn,
// with no browser involved at any point. That is the whole fix: durability no longer depends on a
// poll arriving before something goes wrong.
test("a real agent run records its own turn, with no client polling it", async () => {
  const shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
  await writeFile(join(shim, "claude"), `#!/bin/sh\nprintf '{"result":"## Outcome\\\\nShipped it.","is_error":false}'\n`);
  await chmod(join(shim, "claude"), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${shim}:${realPath}`;
  try {
    const receipt = agent.runAgent(dir, "do the work", { repo: "r", branch: "feat", provider: "claude" });
    expect(receipt.status).toBe("running");
    // The turn is already on disk while the process is still running.
    expect(db.turns("r", "feat")[0]?.prompt).toBe("do the work");

    while (agent.status(dir).status === "running") await new Promise((r) => setTimeout(r, 25));

    const [turn] = db.turns("r", "feat");
    expect(turn?.response).toContain("Shipped it.");
    expect(turn?.structured?.outcome).toBe("Shipped it.");
    expect(turn?.finishedAt).toBeGreaterThan(0);
  } finally {
    process.env.PATH = realPath;
    agent.stop(dir);
    await rm(shim, { recursive: true, force: true });
  }
});
