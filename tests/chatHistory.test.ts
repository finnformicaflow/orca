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
import * as transcript from "../server/transcript";
import * as bus from "../server/bus";
import type { BusEvent } from "../server/bus";

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

// The agent's THOUGHT PROCESS, not just its conclusion. Before this the steps were a 12-entry
// in-memory ring of one-line strings, discarded when the process exited — so the chat could never
// answer "how did it get here", and a bridge restart lost even the live view. Now each step is
// persisted as it streams, so it outlives the run that produced it.
test("a run's steps are persisted as they stream and readable after it finishes", async () => {
  const shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
  // A realistic stream-json run: thinks, calls a tool, sees the result, answers.
  const events = [
    { type: "system", subtype: "init", session_id: "c-1" },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "the lease is stale" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "2 pass 0 fail" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Tests pass." }] } },
    { type: "result", subtype: "success", is_error: false, result: "## Outcome\nShipped it.", session_id: "c-1" },
  ].map((e) => JSON.stringify(e)).join("\n");
  await writeFile(join(shim, "claude"), `#!/bin/sh\ncat <<'JSONL'\n${events}\nJSONL\n`);
  await chmod(join(shim, "claude"), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${shim}:${realPath}`;
  try {
    const receipt = agent.runAgent(dir, "fix the tests", { repo: "r", branch: "feat", provider: "claude" });
    while (agent.status(dir).status === "running") await new Promise((r) => setTimeout(r, 25));

    // Readable AFTER the run — the in-memory trail could not do this.
    const steps = agent.runSteps(receipt.runId);
    expect(steps.map((s) => s.kind)).toEqual(["thinking", "tool", "tool", "text"]);
    expect(steps[0]?.text).toBe("the lease is stale");
    expect(steps[1]).toMatchObject({ name: "Bash", text: "Running: bun test", detail: "bun test" });
    expect(steps[2]?.output).toBe("2 pass 0 fail"); // the tool RESULT, which used to be dropped
    expect(steps[3]?.text).toBe("Tests pass.");

    // And it's on disk under the state dir, not in the worktree — so it can never reach a diff/PR.
    expect(transcript.transcriptPath(receipt.runId).startsWith(dir)).toBe(true);
    expect(transcript.read(receipt.runId, 2).map((s) => s.kind)).toEqual(["tool", "text"]); // tail

    // The durable turn still carries the final outcome; steps are the reasoning behind it.
    expect(db.turns("r", "feat")[0]?.structured?.outcome).toBe("Shipped it.");
  } finally {
    process.env.PATH = realPath;
    agent.stop(dir);
    await rm(shim, { recursive: true, force: true });
  }
});

test("one runaway tool result can't dominate a transcript, and a missing one is not an error", () => {
  // Bounding is per-field so a `cat` of a lockfile costs a clipped step, never the whole file.
  const big = transcript.boundStep({ at: 1, kind: "tool", name: "Bash", output: "x".repeat(500_000) });
  expect(big.output!.length).toBeLessThan(40_000);
  expect(big.output).toContain("truncated");
  // Advisory, like the lease and ledger: no transcript degrades to "no steps", never a throw.
  expect(transcript.read("no-such-run")).toEqual([]);
});

// The live feed. Steps are PUSHED as they're recorded (in-process bus → SSE), replacing a 4s poll
// that both lagged the agent and refetched the whole conversation each tick.
test("recorded steps are pushed to subscribers, scoped to the branch that owns the run", () => {
  db.startTurn({ repo: "r", branch: "feat", runId: "run-a", provider: "claude", prompt: "a", startedAt: Date.now() });
  db.startTurn({ repo: "r", branch: "other", runId: "run-b", provider: "claude", prompt: "b", startedAt: Date.now() });

  const seen: BusEvent[] = [];
  const off = bus.subscribe((e) => seen.push(e));
  try {
    transcript.append("run-a", [{ at: 1, kind: "text", text: "hello" }]);
    // The owner lookup is what lets a stream filter the global bus down to its own conversation.
    expect(db.turnOwner("run-a")).toEqual({ repo: "r", branch: "feat" });
    expect(db.turnOwner("run-b")?.branch).toBe("other");
    expect(db.turnOwner("nope")).toBeUndefined();

    const steps = seen.filter((e) => e.kind === "step");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ runId: "run-a" });

    // Finishing publishes too, so an open chat replaces "working…" with the outcome immediately.
    db.finishTurn("run-a", { status: "done", response: "done", finishedAt: Date.now() });
    expect(seen.filter((e) => e.kind === "turn").map((e) => e.runId)).toContain("run-a");
  } finally {
    off();
  }
  expect(bus.subscriberCount()).toBe(0); // no leaked stream after unsubscribe
});

test("a throwing subscriber (a closed stream) never breaks the run that published", () => {
  db.startTurn({ repo: "r", branch: "feat", runId: "run-c", provider: "claude", prompt: "c", startedAt: Date.now() });
  const off = bus.subscribe(() => { throw new Error("socket closed"); });
  try {
    expect(() => transcript.append("run-c", [{ at: 1, kind: "text", text: "still recorded" }])).not.toThrow();
    expect(transcript.read("run-c")[0]?.text).toBe("still recorded"); // and the write still landed
  } finally {
    off();
  }
});

// A bridge killed mid-run writes the turn at launch and never reaches its exit handler, so the turn
// renders "▋ working…" forever. A long-lived (deployed) bridge accretes these, which is exactly
// where a permanently-working card misleads most.
test("turns orphaned by a dead bridge are closed at startup; genuinely live ones are left alone", () => {
  start("run-dead", "interrupted");
  start("run-live", "still going");
  start("run-done", "finished");
  db.finishTurn("run-done", { status: "done", response: "ok", finishedAt: Date.now() });

  // The lease is the authority on what's still running — it deliberately survives shutdown.
  const closed = db.reconcileRunning(new Set(["run-live"]));
  expect(closed).toBe(1);

  const byPrompt = Object.fromEntries(db.turns("r", "feat").map((t) => [t.prompt, t]));
  expect(byPrompt.interrupted?.finishedAt).toBeGreaterThan(0);
  expect(byPrompt.interrupted?.failed).toBe(true);
  expect(byPrompt.interrupted?.response).toContain("bridge stopped");
  expect(byPrompt["still going"]?.finishedAt).toBeUndefined(); // untouched — its process is alive
  expect(byPrompt.finished?.response).toBe("ok"); // already-closed turns aren't rewritten

  expect(db.reconcileRunning(new Set(["run-live"]))).toBe(0); // idempotent
});

// Stop is not Discard: the process dies, everything else survives. The turn must record that
// distinction, because a stopped run's session id is what lets the next message resume and redirect
// it instead of starting the conversation over.
test("a run stopped from the chat is recorded as stopped, keeps its work, and stays resumable", async () => {
  const shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
  // Emits a step, then hangs — so there is real recorded work when the stop lands.
  const event = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Refactoring…" }] } });
  await writeFile(join(shim, "claude"), `#!/bin/sh\necho '${event}'\nsleep 30\n`);
  await chmod(join(shim, "claude"), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${shim}:${realPath}`;
  try {
    const receipt = agent.runAgent(dir, "refactor everything", { repo: "r", branch: "feat", provider: "claude" });
    while (!agent.runSteps(receipt.runId).length) await new Promise((r) => setTimeout(r, 25));

    expect(agent.stop(dir)).toBe(receipt.runId); // reports what it interrupted
    // Wait for the exit handler to write, rather than guessing at a sleep.
    for (let i = 0; i < 200 && !db.turns("r", "feat")[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));

    const [turn] = db.turns("r", "feat");
    expect(turn?.stopped).toBe(true);
    expect(turn?.failed).toBeUndefined(); // NOT an error — you did this on purpose
    expect(turn?.sessionId).toBeTruthy(); // resumable, so a follow-up redirects the same session
    expect(turn?.finishedAt).toBeGreaterThan(0); // and it doesn't linger as "working…"
    // The work it recorded before you stopped it is kept, not discarded.
    expect(agent.runSteps(receipt.runId).map((s) => s.text)).toContain("Refactoring…");
  } finally {
    process.env.PATH = realPath;
    agent.stop(dir);
    await rm(shim, { recursive: true, force: true });
  }
});
