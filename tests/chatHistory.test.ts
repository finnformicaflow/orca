// The durable chat history (server/db.ts). Before this, an agent's response lived only in the
// in-memory `runs` map until a browser poll happened to collect it — so a bridge restart, a closed
// tab, or a follow-up landing faster than the 8s poll destroyed the turn permanently. These cases
// pin the properties that fix: written at launch, keyed by runId, and archived rather than deleted.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as transcript from "../server/transcript";
import { backfillRun, projectDir, readSession } from "../server/backfill";
import { freshSchema, type TestDb } from "./pg";

let dir: string;
let prevStateDir: string | undefined;
let prevDbUrl: string | undefined;
let prevClaudeDir: string | undefined;
let pg: TestDb;

// A real Postgres in an isolated schema — the same engine the app runs on. The state dir still holds
// the transcripts, leases and ledger, so both get a clean slate per test.
beforeEach(async () => {
  prevStateDir = process.env.ORCA_STATE_DIR;
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  dir = await mkdtemp(join(tmpdir(), "orca-db-"));
  process.env.ORCA_STATE_DIR = dir;
  pg = await freshSchema("chathistory");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close(); // drop any pool held against a previous database
});
afterEach(async () => {
  await agent.flushHistory(); // never close the pool under an in-flight fire-and-forget write
  await db.close();
  await pg.drop();
  if (prevStateDir === undefined) delete process.env.ORCA_STATE_DIR; else process.env.ORCA_STATE_DIR = prevStateDir;
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
  await rm(dir, { recursive: true, force: true });
});

/** Wait for a fire-and-forget history write to land (see recordTurn in agent.ts). */
const settled = async (branch = "feat") => {
  for (let i = 0; i < 200; i++) {
    if ((await db.turns("r", branch))[0]?.finishedAt) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const start = (runId: string, prompt: string, branch = "feat") =>
  db.startTurn({ repo: "r", branch, runId, provider: "claude", prompt, sessionId: `sess-${runId}`, startedAt: Date.now() });

test("a turn is durable from launch, before the run produces any output", async () => {
  await start("run-1", "add the thing");

  // The whole point: this row exists while the agent is still working. A bridge restart here used to
  // lose the run entirely; now it survives as an interrupted turn.
  const [turn] = await db.turns("r", "feat");
  expect(turn?.prompt).toBe("add the thing");
  expect(turn?.response).toBe("");
  expect(turn?.finishedAt).toBeUndefined();
});

test("completing a run fills in its response and structured outcome", async () => {
  await start("run-1", "add the thing");
  await db.finishTurn("run-1", {
    status: "done", response: "## Outcome\nAdded it.",
    structured: { outcome: "Added it.", verification: ["bun test"], decisions: [], remaining: [], commits: ["abc123 add"] },
    sessionId: "sess-final", finishedAt: Date.now(),
  });

  const [turn] = await db.turns("r", "feat");
  expect(turn?.response).toBe("## Outcome\nAdded it.");
  expect(turn?.structured?.commits).toEqual(["abc123 add"]);
  expect(turn?.sessionId).toBe("sess-final"); // Codex/Cursor only reveal theirs mid-run
  expect(turn?.failed).toBeUndefined();
});

test("a failed run keeps its error as the turn's outcome", async () => {
  await start("run-1", "break it");
  await db.finishTurn("run-1", { status: "error", response: "exit 1", finishedAt: Date.now() });

  const [turn] = await db.turns("r", "feat");
  expect(turn?.failed).toBe(true);
  expect(turn?.response).toBe("exit 1");
});

test("a fast follow-up can't overwrite the previous turn", async () => {
  // The old in-memory map was keyed by WORKTREE PATH, so a second launch replaced the first run's
  // completed record before the client's next poll ever saw it. Turns are keyed by runId instead.
  await start("run-1", "first");
  await db.finishTurn("run-1", { status: "done", response: "first done", finishedAt: Date.now() });
  await start("run-2", "second");
  await db.finishTurn("run-2", { status: "done", response: "second done", finishedAt: Date.now() });

  expect((await db.turns("r", "feat")).map((t) => t.response)).toEqual(["first done", "second done"]);
});

test("history survives the branch it was made on", async () => {
  await start("run-1", "shipped work");
  await db.finishTurn("run-1", { status: "done", response: "done", finishedAt: Date.now() });

  await db.archive("r", "feat"); // merged + reaped

  // Gone from the LIVE view (the board shouldn't show it)...
  expect(await db.turns("r", "feat")).toEqual([]);
  // ...but retained, which is what makes chaining from a merged conversation possible at all.
  const rows = await (await db.open())`SELECT COUNT(*)::int AS n FROM turn`;
  expect(rows[0].n).toBe(1);
});

test("a reused branch name starts a fresh conversation, not the dead one's", async () => {
  await start("run-1", "original work");
  await db.archive("r", "feat");

  await start("run-2", "unrelated later work");

  // The partial unique index lets the name be reused; the archived workstream keeps its own history.
  expect((await db.turns("r", "feat")).map((t) => t.prompt)).toEqual(["unrelated later work"]);
});

test("turns are scoped per repo, so same-named branches in different repos don't merge", async () => {
  await start("run-1", "in repo r");
  await db.startTurn({ repo: "other", branch: "feat", runId: "run-2", provider: "codex", prompt: "in repo other", startedAt: Date.now() });

  expect((await db.turns("r", "feat")).map((t) => t.prompt)).toEqual(["in repo r"]);
  expect((await db.turns("other", "feat")).map((t) => t.prompt)).toEqual(["in repo other"]);
});

test("relaunching the same runId doesn't duplicate the turn", async () => {
  await start("run-1", "once");
  await start("run-1", "once");
  expect(await db.turns("r", "feat")).toHaveLength(1);
});

// (Removed: the database used to be a 0600 file in the state dir, and this asserted that mode.
// With Postgres the equivalent protection is network + role scoping, which is deployment
// configuration rather than something this suite can meaningfully assert. What IS still testable —
// that prompts and responses never leave the state dir for a worktree — is covered by the
// transcript-path case below.)

test("reopening the state dir keeps the history (it is a file, not a cache)", async () => {
  await start("run-1", "persisted");
  await db.finishTurn("run-1", { status: "done", response: "still here", finishedAt: Date.now() });

  db.close(); // simulate a bridge restart

  expect((await db.turns("r", "feat")).map((t) => t.response)).toEqual(["still here"]);
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
    const receipt = await agent.runAgent(dir, "do the work", { repo: "r", branch: "feat", provider: "claude" });
    expect(receipt.status).toBe("running");
    // The turn is already on disk while the process is still running.
    expect((await db.turns("r", "feat"))[0]?.prompt).toBe("do the work");

    while (agent.status(dir).status === "running") await new Promise((r) => setTimeout(r, 25));
    await settled(); // the finish write is fire-and-forget; the run must never wait on the database

    const [turn] = await db.turns("r", "feat");
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
    const receipt = await agent.runAgent(dir, "fix the tests", { repo: "r", branch: "feat", provider: "claude" });
    while (agent.status(dir).status === "running") await new Promise((r) => setTimeout(r, 25));

    // Readable AFTER the run — the in-memory trail could not do this.
    const steps = await agent.runSteps(receipt.runId);
    expect(steps.map((s) => s.kind)).toEqual(["thinking", "tool", "tool", "text"]);
    expect(steps[0]?.text).toBe("the lease is stale");
    expect(steps[1]).toMatchObject({ name: "Bash", text: "Running: bun test", detail: "bun test" });
    expect(steps[2]?.output).toBe("2 pass 0 fail"); // the tool RESULT, which used to be dropped
    expect(steps[3]?.text).toBe("Tests pass.");

    expect((await transcript.read(receipt.runId, 2)).map((s) => s.kind)).toEqual(["tool", "text"]); // tail

    // The durable turn still carries the final outcome; steps are the reasoning behind it.
    expect((await db.turns("r", "feat"))[0]?.structured?.outcome).toBe("Shipped it.");
  } finally {
    process.env.PATH = realPath;
    agent.stop(dir);
    await rm(shim, { recursive: true, force: true });
  }
});

test("one runaway tool result can't dominate a transcript, and a missing one is not an error", async () => {
  // Bounding is per-field so a `cat` of a lockfile costs a clipped step, never the whole file.
  const big = transcript.boundStep({ at: 1, kind: "tool", name: "Bash", output: "x".repeat(500_000) });
  expect(big.output!.length).toBeLessThan(40_000);
  expect(big.output).toContain("truncated");
  // Advisory, like the lease and ledger: no transcript degrades to "no steps", never a throw.
  expect(await transcript.read("no-such-run")).toEqual([]);
});

// The chat's live tail. Steps are read back by sequence number, so a client polls with the cursor it
// already holds and gets only what's new — the same query whether the run is on this machine or
// another one, which is the whole reason the in-process bus and its SSE stream were removed.
test("steps are readable by cursor, so a tail returns only what is new", async () => {
  await start("run-a", "a");
  await transcript.append("run-a", [{ at: 1, kind: "text", text: "one" }, { at: 2, kind: "text", text: "two" }]);

  const all = await transcript.numbered("run-a");
  expect(all.map((r) => r.step.text)).toEqual(["one", "two"]);
  expect(all.map((r) => r.seq)).toEqual([1, 2]); // dense, so a cursor is just "how far I've read"

  await transcript.append("run-a", [{ at: 3, kind: "text", text: "three" }]);
  expect((await transcript.numbered("run-a", { afterSeq: 2 })).map((r) => r.step.text)).toEqual(["three"]);
  expect(await transcript.numbered("run-a", { afterSeq: 3 })).toEqual([]); // caught up → nothing to send
  expect((await transcript.read("run-a", 1)).map((s) => s.text)).toEqual(["three"]); // tail
});

test("a retried write cannot duplicate a step", async () => {
  // The unique (run_id, seq) index is what makes ingestion idempotent — it matters more once a step
  // can be written by a process that might retry.
  await start("run-b", "b");
  await db.appendSteps("run-b", 1, [{ at: 1, kind: "text", text: "once" } as never]);
  await db.appendSteps("run-b", 1, [{ at: 1, kind: "text", text: "once" } as never]); // same seq again
  expect((await transcript.numbered("run-b")).length).toBe(1);
});

// A bridge killed mid-run writes the turn at launch and never reaches its exit handler, so the turn
// renders "▋ working…" forever. A long-lived (deployed) bridge accretes these, which is exactly
// where a permanently-working card misleads most.
test("turns orphaned by a dead bridge are closed at startup; genuinely live ones are left alone", async () => {
  await start("run-dead", "interrupted");
  await start("run-live", "still going");
  await start("run-done", "finished");
  await db.finishTurn("run-done", { status: "done", response: "ok", finishedAt: Date.now() });

  // The lease is the authority on what's still running — it deliberately survives shutdown.
  const { closed } = await db.reconcileRunning(new Set(["run-live"]));
  expect(closed).toBe(1);

  const byPrompt = Object.fromEntries((await db.turns("r", "feat")).map((t) => [t.prompt, t]));
  expect(byPrompt.interrupted?.finishedAt).toBeGreaterThan(0);
  expect(byPrompt.interrupted?.failed).toBe(true);
  expect(byPrompt.interrupted?.response).toContain("bridge stopped");
  expect(byPrompt["still going"]?.finishedAt).toBeUndefined(); // untouched — its process is alive
  expect(byPrompt.finished?.response).toBe("ok"); // already-closed turns aren't rewritten

  expect((await db.reconcileRunning(new Set(["run-live"]))).closed).toBe(0); // idempotent
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
    const receipt = await agent.runAgent(dir, "refactor everything", { repo: "r", branch: "feat", provider: "claude" });
    while (!(await agent.runSteps(receipt.runId)).length) await new Promise((r) => setTimeout(r, 25));

    expect(agent.stop(dir)).toBe(receipt.runId); // reports what it interrupted
    // Wait for the exit handler to write, rather than guessing at a sleep.
    for (let i = 0; i < 200 && !(await db.turns("r", "feat"))[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));

    const [turn] = await db.turns("r", "feat");
    expect(turn?.stopped).toBe(true);
    expect(turn?.failed).toBeUndefined(); // NOT an error — you did this on purpose
    expect(turn?.sessionId).toBeTruthy(); // resumable, so a follow-up redirects the same session
    expect(turn?.finishedAt).toBeGreaterThan(0); // and it doesn't linger as "working…"
    // The work it recorded before you stopped it is kept, not discarded.
    expect((await agent.runSteps(receipt.runId)).map((s) => s.text)).toContain("Refactoring…");
  } finally {
    process.env.PATH = realPath;
    agent.stop(dir);
    await rm(shim, { recursive: true, force: true });
  }
});

// Found by running a second instance locally: it printed "closed 1 turn(s) left running by a previous
// bridge" while the FIRST instance was still working. Leases are per-instance state, so another
// machine's live runs hold no lease here — reconciliation has to be scoped or it kills a working
// board from a machine that has nothing to do with it.
test("startup reconciliation never closes another instance's live runs", async () => {
  const prev = process.env.ORCA_INSTANCE;
  try {
    process.env.ORCA_INSTANCE = "laptop";
    await start("run-laptop", "running on the laptop");

    // The cloud instance starts up. It holds no lease for the laptop's run, and must leave it alone.
    process.env.ORCA_INSTANCE = "cloud";
    await start("run-cloud", "running on the cloud");
    expect((await db.reconcileRunning(new Set(["run-cloud"]))).closed).toBe(0);

    const byPrompt = Object.fromEntries((await db.turns("r", "feat")).map((t) => [t.prompt, t]));
    expect(byPrompt["running on the laptop"]?.finishedAt).toBeUndefined(); // untouched
    expect(byPrompt["running on the cloud"]?.finishedAt).toBeUndefined();

    // It still closes its OWN orphan — the case reconciliation exists for.
    await start("run-cloud-dead", "died with the cloud bridge");
    expect((await db.reconcileRunning(new Set(["run-cloud"]))).closed).toBe(1);
    const after = Object.fromEntries((await db.turns("r", "feat")).map((t) => [t.prompt, t]));
    expect(after["died with the cloud bridge"]?.failed).toBe(true);
    expect(after["running on the laptop"]?.finishedAt).toBeUndefined(); // still untouched
  } finally {
    if (prev === undefined) delete process.env.ORCA_INSTANCE; else process.env.ORCA_INSTANCE = prev;
  }
});

// The composer has always invited an instruction mid-run ("The agent is working — queue the next
// instruction…") and then answered with a 409, so the message was simply lost. Queued instead, and
// sent when the run finishes.
test("an instruction typed mid-run is queued, claimed once, and cancellable", async () => {
  const queued = await db.queueMessage({
    repo: "r", branch: "feat", worktreePath: "/wt/feat",
    instruction: "also update the docs", attachments: ["/tmp/a.png"], provider: "claude",
  });
  expect(queued.id).toBeGreaterThan(0);
  await db.queueMessage({ repo: "r", branch: "feat", worktreePath: "/wt/feat", instruction: "and the changelog", attachments: [] });

  // Visible while pending, so a queued instruction isn't silently in limbo.
  expect((await db.queuedMessages("r", "feat")).map((m) => m.instruction))
    .toEqual(["also update the docs", "and the changelog"]);
  expect((await db.queuedMessages("r", "other"))).toEqual([]); // scoped to its branch

  // Claiming marks it dispatched in the same statement, so a restart racing itself — or a second
  // instance — cannot send the same message twice.
  const first = await db.claimQueuedMessage("r", "feat");
  expect(first?.instruction).toBe("also update the docs");
  expect(first?.attachments).toEqual(["/tmp/a.png"]); // attachments survive the wait
  expect((await db.queuedMessages("r", "feat")).map((m) => m.instruction)).toEqual(["and the changelog"]);

  const second = await db.claimQueuedMessage("r", "feat");
  expect(second?.instruction).toBe("and the changelog");
  expect(await db.claimQueuedMessage("r", "feat")).toBeUndefined(); // drained

  // Changed your mind before it went.
  const third = await db.queueMessage({ repo: "r", branch: "feat", worktreePath: "/wt/feat", instruction: "never mind", attachments: [] });
  await db.cancelQueuedMessage(third.id);
  expect(await db.queuedMessages("r", "feat")).toEqual([]);
});

// A run whose bridge died mid-flight kept working — the agent outlives the bridge by design — but
// the reader transcribing it and the handler recording its outcome both died with the process. The
// provider kept everything, and turn.raw_ref holds the session id, so the turn can be reconstructed
// rather than written off as an error.
test("an interrupted run is recovered from the provider's session file, not written off", async () => {
  process.env.CLAUDE_CONFIG_DIR = dir; // look for sessions in this test's sandbox, not ~/.claude
  const sessionDir = projectDir("/wt/feat");
  await mkdir(sessionDir, { recursive: true });
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  // The same event shapes the live stream emits, so the same mapping applies.
  await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "2 pass" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "## Outcome\nFixed the tests." }] } },
  ].map((e) => JSON.stringify(e)).join("\n"));

  expect(readSession(join(sessionDir, `${sessionId}.jsonl`)).steps.map((s) => s.kind))
    .toEqual(["tool", "tool", "text"]);
  expect(readSession(join(sessionDir, `${sessionId}.jsonl`)).response).toContain("Fixed the tests.");

  // Nothing was recorded live — the bridge died before reading any of it.
  await db.startTurn({ repo: "r", branch: "feat", runId: "run-int", provider: "claude", prompt: "fix the tests", sessionId, startedAt: Date.now() });
  expect(await transcript.read("run-int")).toEqual([]);

  const found = await backfillRun("run-int", sessionId, "/wt/feat");
  expect(found?.steps).toBe(3);
  expect(found?.outcome?.outcome).toBe("Fixed the tests."); // the answer, recovered
  expect((await transcript.read("run-int")).length).toBe(3); // and its reasoning

  // Re-running adds nothing: the session is authoritative and we already have all of it.
  expect(await backfillRun("run-int", sessionId, "/wt/feat")).toMatchObject({ steps: 0 });

  // A run with no session, or an unknown one, is simply not recoverable — never fabricated.
  expect(await backfillRun("run-int", undefined)).toBeUndefined();
  expect(await backfillRun("run-int", "11111111-2222-3333-4444-555555555555", "/wt/feat")).toBeUndefined();
});

// Not hypothetical: a live run once recorded 226 steps with no turn to hang them on, because the
// start write was lost to a bridge reload and `recordTurn` swallows failures by design. The exit
// handler knows everything about the run, so it can write the turn from scratch rather than
// updating nothing and leaving the conversation invisible.
test("a turn whose start write was lost is rescued when the run finishes", async () => {
  const runId = "run-lost-start";
  // Steps land regardless — they only need a run id.
  await transcript.append(runId, [{ at: 1, kind: "text", text: "did the work" }]);
  expect((await db.turns("r", "feat")).length).toBe(0); // …and there is no turn for them

  await db.finishTurn(runId, {
    status: "done", response: "## Outcome\nShipped it.", finishedAt: Date.now(),
    structured: { outcome: "Shipped it.", verification: [], decisions: [], remaining: [], commits: [] },
    identity: { repo: "r", branch: "feat", provider: "claude", prompt: "do the work", startedAt: 1 },
  });

  const [turn] = await db.turns("r", "feat");
  expect(turn?.prompt).toBe("do the work");           // recovered, not lost
  expect(turn?.structured?.outcome).toBe("Shipped it.");
  expect(turn?.id).toBe(runId);                        // and keyed to its steps
  expect((await transcript.read(runId)).map((s) => s.text)).toEqual(["did the work"]);

  // The normal path is untouched: an existing turn is updated, never duplicated.
  await start("run-normal", "already recorded");
  await db.finishTurn("run-normal", {
    status: "done", response: "fine", finishedAt: Date.now(),
    identity: { repo: "r", branch: "feat", provider: "claude", prompt: "should not overwrite", startedAt: 1 },
  });
  const normal = (await db.turns("r", "feat")).find((t) => t.id === "run-normal");
  expect(normal?.prompt).toBe("already recorded"); // the identity is a fallback, not an overwrite
  expect((await db.turns("r", "feat")).length).toBe(2);
});

// The failure that lost a real conversation. Creating a card writes its enrichment and launches an
// agent at the same moment, so two callers reach workstreamId together, both find nothing, and both
// insert — one then violated `workstream_live`. Because a history write must never break a run, it
// was swallowed: the agent worked, its steps were recorded, and the chat had no turn to hang them on.
test("concurrent writers to the same branch agree on one workstream", async () => {
  const [a, b, c] = await Promise.all([
    db.workstreamId("r", "feat"),
    db.workstreamId("r", "feat"),
    db.workstreamId("r", "feat"),
  ]);
  expect(a).toBe(b);
  expect(b).toBe(c);
  const sql = await db.open();
  expect((await sql`SELECT COUNT(*)::int AS n FROM workstream WHERE branch = ${"feat"}`)[0].n).toBe(1);
});

test("a card created and launched at once records both its enrichment and its turn", async () => {
  // The real shape of it: patchEnrichment and startTurn race on a brand-new branch.
  await Promise.all([
    db.patchEnrichment("r", "fresh", { title: "Fresh card", prompt: "do the thing" }),
    db.startTurn({ repo: "r", branch: "fresh", runId: "run-fresh", provider: "claude", prompt: "do the thing", startedAt: Date.now() }),
  ]);
  expect((await db.enrichment("r")).fresh?.title).toBe("Fresh card"); // enrichment survived
  expect((await db.turns("r", "fresh")).map((t) => t.id)).toEqual(["run-fresh"]); // and so did the turn
});

test("an archived branch can be reused, since only live workstreams are unique", async () => {
  // The conflict target names the partial index's predicate, so this must still work.
  await db.startTurn({ repo: "r", branch: "reused", runId: "run-old", provider: "claude", prompt: "old", startedAt: 1 });
  await db.archive("r", "reused");
  await db.startTurn({ repo: "r", branch: "reused", runId: "run-new", provider: "claude", prompt: "new", startedAt: 2 });
  expect((await db.turns("r", "reused")).map((t) => t.id)).toEqual(["run-new"]); // the live one only
});
