// The orchestrator (server/orchestrator.ts): one conversation that delegates to worker agents through
// the `orca` command, is woken when they finish, keeps its own notes, and can be reset at any time
// because nothing it needs lives only in its context. Same harness as verifyGate.test.ts — a real
// git scratch repo, a fake `claude` on PATH, real Postgres — plus the fake `gh` for the board's PRs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as git from "../server/git";
import * as ledger from "../server/ledger";
import * as transcript from "../server/transcript";
import * as orchestrator from "../server/orchestrator";
import * as preview from "../server/preview";
import * as verbs from "../server/verbs";
import { parseConfigDocument, type OrcaConfig } from "../server/config";
import type { AgentTurn } from "../shared/agent";
import {
  ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, WORKER_EVENT_MARKER, boardText, continuation, isWorkerProblem, onlyCleanReports, sessionHint, wakeExitReason,
  wakeStoppedLine, workerEvent,
} from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, worktrees: string, log: string, hold: string, holdWorkers: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24,
});

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", "ORCA_FAKE_HOLD", "ORCA_FAKE_HOLD_WORKERS"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-orch-${n}-`))))) as [string, string, string, string];
  repo = await makeScratchRepo();
  hold = join(state, "hold");
  holdWorkers = join(state, "hold-workers"); // holds workers but lets the orchestrator answer
  process.env.ORCA_FAKE_HOLD_WORKERS = holdWorkers;
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  process.env.ORCA_FAKE_HOLD = hold;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  await setPrListFixture([]);
  // A fake claude: records its argv (one file per launch), waits while the hold file exists, answers.
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s' "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
while [ -f "$ORCA_FAKE_HOLD" ]; do sleep 0.02; done
case "$PWD" in */orchestrator) ;; *) while [ -f "$ORCA_FAKE_HOLD_WORKERS" ]; do sleep 0.02; done ;; esac
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("orchestrator");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await rm(hold, { force: true });
  await rm(holdWorkers, { force: true });
  for (let i = 0; i < 200 && (await anyRunning()); i++) await new Promise((r) => setTimeout(r, 25));
  agent.onRunFinished(undefined);
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [state, shim, repo, worktrees, log]) await rm(d, { recursive: true, force: true });
});

const wire = () => agent.onRunFinished((run) => orchestrator.onRunFinished(cfg(), run));
const orchTurns = () => db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
const anyRunning = async () => agent.isRunning(orchestrator.dir())
  || (existsSync(repo) ? (await git.listWorktrees(repo, worktrees)).some((w) => agent.isRunning(w.worktreePath)) : false);
/** Every fake-claude launch's argv, oldest first. */
const launches = async () => Promise.all((await readdir(log)).sort().map((f) => readFile(join(log, f), "utf8")));
/** Wait until `read()` yields `n` finished turns and nothing is running. */
async function settled(read: () => Promise<AgentTurn[]>, n: number): Promise<AgentTurn[]> {
  for (let i = 0; i < 400; i++) {
    const turns = await read();
    if (turns.length >= n && turns.every((t) => t.finishedAt) && !(await anyRunning())) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled at ${n} turn(s)`);
}
/** Replace the fake claude: `body` runs after the argv is logged. `$ORCA_FAKE_HOLD.once` is free for
 *  a body that must behave differently on its first launch. */
const fakeClaude = (body: string) => writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s' "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
${body}
`);
const OK = `printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'`;
const firstLaunch = (body: string) => `if [ ! -f "$ORCA_FAKE_HOLD.once" ]; then touch "$ORCA_FAKE_HOLD.once"
${body}
fi
while [ -f "$ORCA_FAKE_HOLD" ]; do sleep 0.02; done
case "$PWD" in */orchestrator) ;; *) while [ -f "$ORCA_FAKE_HOLD_WORKERS" ]; do sleep 0.02; done ;; esac
${OK}`;
const orchBlob = async () => (await db.enrichment(ORCHESTRATOR_REPO))[ORCHESTRATOR_BRANCH] ?? {};
const orchQueue = () => db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
const brief = { repo: "r", title: "Add cache", model: "claude-sonnet-5", objective: "Add a response cache", output: "One commit", boundaries: "Only touch src/cache" };

test("O1: spawn creates a briefed workstream, and the worker finishing wakes the orchestrator", async () => {
  wire();
  const out = await orchestrator.tool(cfg(), "spawn", brief);
  expect(out).toContain('Spawned r/orca/add-cache-');
  const [[branch, card]] = Object.entries(await db.enrichment("r")) as [[string, db.Fields]];
  expect(card).toMatchObject({ orchestrated: true, title: "Add cache", agentProvider: "claude" });
  expect(card.prompt).toContain("## Expected output\nOne commit");
  expect(card.prompt).toContain("## Boundaries\nOnly touch src/cache");

  // The worker ran in its own worktree; its going idle is what woke the orchestrator.
  const [wake] = await settled(orchTurns, 1);
  expect(wake!.instruction).toStartWith(`${WORKER_EVENT_MARKER} r/${branch} "Add cache" — done`);
  expect(wake!.instruction).toContain("Outcome: Done.");
  expect(wake!.instruction).toContain(`orca read --run ${(await db.turns("r", branch))[0]!.id}`);
  // A first wake carries the role, its notes, and a board that shows the workstream as its own.
  expect(wake!.prompt).toContain("You are Orca's orchestrator");
  expect(wake!.prompt).toContain("## Your notes\n(empty)");
  expect(wake!.prompt).toMatch(new RegExp(`r/${branch} "Add cache" \\| no PR \\| agent:done \\| yours`));
  // It may run `orca` and read files — never bypassPermissions.
  const argv = (await launches()).find((a) => a.includes("You are Orca's orchestrator"))!;
  expect(argv).toContain("--allowedTools Bash(orca *),Read,Grep,Glob");
  expect(argv).toContain("--permission-mode default");
  expect(wake!.prompt).toContain("## Access\nOnly the `orca` command and reading files.");
  // It is told how to choose a worker's model, and what a New-draft message is.
  expect(wake!.prompt).toContain("## Models\n`spawn` requires --model.");
  expect(wake!.prompt).toContain("claude-fable-5-1: ONLY work that has already defeated Opus");
  expect(wake!.prompt).toContain("A message opening with `[new draft]` is the user's New-draft box");
});

test("O11: send --model moves a workstream to another model for this and later messages", async () => {
  await orchestrator.tool(cfg(), "spawn", { ...brief, model: "claude-haiku-4-5-20251001" });
  const branch = Object.keys(await db.enrichment("r"))[0]!;
  await settled(() => db.turns("r", branch), 1);
  expect((await launches())[0]).toContain("--model claude-haiku-4-5-20251001");

  await expect(orchestrator.tool(cfg(), "send", { repo: "r", branch, model: "gpt-9", _: ["again"] })).rejects.toThrow('unknown model "gpt-9"');
  await orchestrator.tool(cfg(), "send", { repo: "r", branch, model: "claude-opus-5-5", _: ["Harder", "than", "it", "looked"] });
  await settled(() => db.turns("r", branch), 2);
  expect((await launches())[1]).toContain("--model claude-opus-5-5");
  expect((await db.enrichment("r"))[branch]).toMatchObject({ preferredModel: "claude-opus-5-5", preferredProvider: "claude" });
  // The card's picker shows the move, and the next message keeps it.
  await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["and again"] });
  await settled(() => db.turns("r", branch), 3);
  expect((await launches())[2]).toContain("--model claude-opus-5-5");
});

test("O10: orchestratorShell trades the orca-only rule for a full shell, and is off unless set", async () => {
  expect((await orchestrator.status(cfg())).shell).toBe(false);
  expect((await orchestrator.status({ ...cfg(), orchestratorShell: true })).shell).toBe(true);
  await orchestrator.message({ ...cfg(), orchestratorShell: true }, "install node 24.21.0");
  const [turn] = await settled(orchTurns, 1);
  const argv = (await launches())[0]!;
  expect(argv).toContain("--permission-mode bypassPermissions");
  expect(argv).not.toContain("--allowedTools");
  expect(turn!.prompt).toContain("## Access\nFull shell on this machine.");

  // Said on EVERY wake, so turning it back off reaches a session that is being resumed.
  await orchestrator.message(cfg(), "and now?");
  const turns = await settled(orchTurns, 2);
  expect((await launches())[1]).toContain("--allowedTools Bash(orca *),Read,Grep,Glob");
  expect(turns[1]!.prompt).not.toContain("You are Orca's orchestrator"); // resumed
  expect(turns[1]!.prompt).toContain("## Access\nOnly the `orca` command and reading files.");

  const doc = (orchestratorShell: unknown) => ({ repos: [{ name: "app", repoPath: "/a", worktreeRoot: "/a/.wt", baseBranch: "main" }], orchestratorShell });
  expect(parseConfigDocument(doc("yes")).errors).toContain("orchestratorShell must be true or false");
  expect(parseConfigDocument(doc(true)).config?.orchestratorShell).toBe(true);
  expect(parseConfigDocument(doc(undefined)).config?.orchestratorShell).toBeUndefined();
});

test("O17: a clean finish waits for the batch (or the user); a failure wakes it at once", async () => {
  wire();
  const finished = (branch: string, status: "done" | "error", check?: boolean): agent.RunFinished => ({
    key: `/wt/${branch}`, cwd: `/wt/${branch}`, runId: `run-${branch}`, status, result: status === "done" ? "## Outcome\nDone." : "boom", continued: false,
    options: { repo: "r", branch }, exit: { code: 0, timedOut: false, budgetReached: false, stderr: "" },
    check: check === undefined ? undefined : { command: "bun run check", ok: check, exitCode: check ? 0 : 1, output: "", durationMs: 1 },
  });
  // (not `settled`: a worker is deliberately still running here — wait on the orchestrator alone)
  const orchSettled = async (n: number) => {
    for (let i = 0; i < 400; i++) {
      const turns = await orchTurns();
      if (turns.length >= n && turns.every((t) => t.finishedAt) && !agent.isRunning(orchestrator.dir())) return turns;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`orchestrator never settled at ${n}`);
  };
  for (const b of ["a", "b", "c"]) await db.patchEnrichment("r", b, { orchestrated: true, title: b.toUpperCase() });
  await writeFile(holdWorkers, "");
  await orchestrator.tool(cfg(), "spawn", brief); // one worker genuinely running
  // A clean finish while another worker runs: a report on the queue, no wake.
  await orchestrator.onRunFinished(cfg(), finished("a", "done"));
  expect(await orchTurns()).toEqual([]);
  expect((await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).map((m) => m.instruction.split("\n")[0])).toEqual(['[worker finished] r/a "A" — done']);
  // A failed check is an exception: woken now, and the held report rides along.
  await orchestrator.onRunFinished(cfg(), finished("b", "done", false));
  const [wake] = await orchSettled(1);
  expect(wake!.instruction).toContain('[worker finished] r/a "A" — done');
  expect(wake!.instruction).toContain('[worker finished] r/b "B" — done\nOrca\'s check `bun run check` FAILED');
  // Another clean finish while the spawned worker still runs: held again…
  await orchestrator.onRunFinished(cfg(), finished("c", "done"));
  expect(await orchTurns()).toHaveLength(1);
  // …until the last running worker finishes, which delivers both in ONE wake.
  await rm(holdWorkers);
  const turns = await settled(orchTurns, 2);
  expect(turns[1]!.instruction!.split("\n\n").map((p) => p.split("\n")[0])).toEqual([
    '[worker finished] r/c "C" — done',
    expect.stringMatching(/^\[worker finished\] r\/orca\/add-cache-\w+ "Add cache" — done$/),
  ]);
});

test("O18: clean reports that queued while it worked also wait for the batch; a problem among them does not", async () => {
  wire();
  const finished = (branch: string, status: "done" | "error"): agent.RunFinished => ({
    key: `/wt/${branch}`, cwd: `/wt/${branch}`, runId: `run-${branch}`, status, result: status === "done" ? "## Outcome\nDone." : "boom", continued: false,
    options: { repo: "r", branch }, exit: { code: 0, timedOut: false, budgetReached: false, stderr: "" },
  });
  const orchIdle = async () => { for (let i = 0; i < 400 && agent.isRunning(orchestrator.dir()); i++) await new Promise((r) => setTimeout(r, 25)); };
  for (const b of ["a", "b"]) await db.patchEnrichment("r", b, { orchestrated: true, title: b.toUpperCase() });
  await writeFile(holdWorkers, "");
  await orchestrator.tool(cfg(), "spawn", brief); // a worker that keeps running
  await writeFile(hold, "");
  await orchestrator.message(cfg(), "hello"); // the orchestrator is busy…
  await orchestrator.onRunFinished(cfg(), finished("a", "done")); // …so this report queues
  await rm(hold);
  await orchIdle();
  await new Promise((r) => setTimeout(r, 300));
  // Its exit drained nothing: a clean report waits while a worker still runs.
  expect(await orchTurns()).toHaveLength(1);
  expect(await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).toHaveLength(1);
  // Your next message delivers the held report with it; a problem that queues meanwhile is drained
  // on its own as soon as that wake ends, worker or no worker.
  await writeFile(hold, "");
  await orchestrator.message(cfg(), "status?");
  await orchestrator.onRunFinished(cfg(), finished("b", "error"));
  await rm(hold);
  await orchIdle();
  const turns = await (async () => { for (let i = 0; i < 400; i++) { const t = await orchTurns(); if (t.length >= 3 && t.every((x) => x.finishedAt)) return t; await new Promise((r) => setTimeout(r, 25)); } throw new Error("no third wake"); })();
  expect(turns[1]!.instruction!.split("\n\n").map((p) => p.split("\n")[0])).toEqual(['[worker finished] r/a "A" — done', "status?"]);
  expect(turns[2]!.instruction!.split("\n\n").map((p) => p.split("\n")[0])).toEqual(['[worker finished] r/b "B" — error']);
  await rm(holdWorkers);
});

test("O2: a brief missing a part and an unknown repo are refused; there is no cap on concurrent workers", async () => {
  await expect(orchestrator.tool(cfg(), "spawn", { repo: "r", objective: "Do it" })).rejects.toThrow("--output is required; --boundaries is required");
  await expect(orchestrator.tool(cfg(), "spawn", { ...brief, repo: "nope" })).rejects.toThrow("--repo must be one of: r");
  // No model → no spawn: the config default is the biggest model, and that is how every worker ended up on it.
  await expect(orchestrator.tool(cfg(), "spawn", { ...brief, model: undefined })).rejects.toThrow("--model is required (choose from the ladder): claude-haiku-4-5-20251001, claude-sonnet-5, claude-opus-5-5, claude-fable-5-1");
  await expect(orchestrator.tool(cfg(), "spawn", { ...brief, model: "gpt-9" })).rejects.toThrow('--model is required ("gpt-9" is not a model)');
  await expect(orchestrator.tool(cfg(), "bogus")).rejects.toThrow('unknown command "bogus"');
  expect(await db.enrichment("r")).toEqual({});

  await writeFile(hold, ""); // workers stay running
  for (let i = 0; i < 5; i++) await orchestrator.tool(cfg(), "spawn", brief);
  expect(Object.keys(await db.enrichment("r"))).toHaveLength(5); // (a cap of 4 once refused the fifth)
});

test("O3: messages that arrive mid-run are queued and drained as ONE resumed wake", async () => {
  wire();
  await writeFile(hold, "");
  expect(await orchestrator.message(cfg(), "first")).toEqual({ status: "running" });
  expect(await orchestrator.message(cfg(), "second")).toEqual({ status: "queued" });
  expect(await orchestrator.message(cfg(), "third")).toEqual({ status: "queued" });
  expect((await orchestrator.status(cfg())).running).toBe(true);
  await rm(hold);

  const turns = await settled(orchTurns, 2);
  expect(turns).toHaveLength(2); // not three
  expect(turns[1]!.instruction).toBe("second\n\nthird");
  expect(await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).toEqual([]);
  // Rung 1 of the ladder: the same session, so the role is not repeated — but notes and board are.
  expect((await launches())[1]).toContain(`--resume ${turns[0]!.sessionId}`);
  expect(turns[1]!.prompt).not.toContain("You are Orca's orchestrator");
  expect(turns[1]!.prompt).toContain("## Board\n(no workstreams)");
  expect(turns[1]!.prompt).toContain("## Models\n`spawn` requires --model."); // the model rule rides every wake, resumed or not
});

test("O4: the wake cap pauses self-waking; your next message resumes it with what was held", async () => {
  const finished = (branch: string, extra: Partial<agent.RunFinished> = {}): agent.RunFinished => ({
    key: "k", cwd: "k", runId: `run-${branch}`, status: "error", result: "boom", continued: false,
    options: { repo: "r", branch }, exit: { code: 1, timedOut: false, budgetReached: false, stderr: "" }, ...extra,
  });
  await db.patchEnrichment("r", "mine", { orchestrated: true, title: "Mine" });
  await db.patchEnrichment("r", "theirs", { title: "Made by hand" });

  // Not its workstream, or one that went straight into a queued follow-up: no wake at all.
  await orchestrator.onRunFinished(cfg(), finished("theirs"));
  await orchestrator.onRunFinished(cfg(), finished("mine", { continued: true }));
  expect(await orchTurns()).toEqual([]);
  expect(await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).toEqual([]);

  // At the cap, a worker event is HELD rather than waking it.
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakes: orchestrator.MAX_WAKES });
  await orchestrator.onRunFinished(cfg(), finished("mine"));
  expect(await orchTurns()).toEqual([]);
  expect((await orchestrator.status(cfg())).paused).toBe(true);
  expect(await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).toHaveLength(1);

  await orchestrator.message(cfg(), "carry on");
  const [turn] = await settled(orchTurns, 1);
  expect(turn!.instruction).toBe(`${WORKER_EVENT_MARKER} r/mine "Mine" — error\nResponse: boom\nFull turn: orca read --run run-mine\n\ncarry on`);
  expect((await orchestrator.status(cfg())).paused).toBe(false);
});

test("O5: notes ride every wake, and a session at 80% context is reset onto them", async () => {
  wire();
  expect(await orchestrator.tool(cfg(), "notes")).toBe("(empty)");
  expect(await orchestrator.tool(cfg(), "notes", { _: ["set", "Plan: ship the cache.", "User prefers small PRs."] })).toBe("Notes saved.");
  expect(await orchestrator.tool(cfg(), "notes")).toBe("Plan: ship the cache. User prefers small PRs.");
  await expect(orchestrator.tool(cfg(), "notes", { _: ["set", "x".repeat(20_001)] })).rejects.toThrow("limited to 20000 characters");

  await orchestrator.message(cfg(), "what is the plan?");
  const [first] = await settled(orchTurns, 1);
  expect(first!.prompt).toContain("## Your notes\nPlan: ship the cache. User prefers small PRs.");

  // The run reported a nearly full context: the next wake must NOT resume it.
  expect((await orchestrator.status(cfg())).contextPct).toBeUndefined(); // nothing has reported yet
  await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { contextPct: 85 });
  expect((await orchestrator.status(cfg())).contextPct).toBe(85); // what the composer's ring shows
  await orchestrator.message(cfg(), "and now?");
  const turns = await settled(orchTurns, 2);
  const argv = (await launches())[1]!;
  expect(argv).not.toContain("--resume");
  expect(turns[1]!.sessionId).not.toBe(first!.sessionId);
  // Rung 3: the portable transcript of its own conversation, plus the role, notes and board again.
  expect(argv).toContain("what is the plan?");
  expect(argv).toContain("You are Orca's orchestrator");
  expect(argv).toContain("Plan: ship the cache.");
});

test("O9: its model can be changed mid-conversation — Claude only, and the session carries over", async () => {
  wire();
  // Nothing pinned → Opus, whatever the workers' default is.
  expect((await orchestrator.status(cfg())).model).toBe(orchestrator.ORCHESTRATOR_DEFAULT_MODEL);
  expect((await orchestrator.status({ ...cfg(), agentModel: "claude-fable-5-1" })).model).toBe("claude-opus-5-5");
  await expect(orchestrator.setModel("gpt-5.5")).rejects.toThrow("runs on a Claude model");

  await orchestrator.message(cfg(), "hello");
  const [first] = await settled(orchTurns, 1);
  expect((await launches())[0]).toContain("--model claude-opus-5-5");

  await orchestrator.setModel("claude-sonnet-5");
  expect((await orchestrator.status(cfg())).model).toBe("claude-sonnet-5");
  await orchestrator.message(cfg(), "and again");
  await settled(orchTurns, 2);
  const argv = (await launches())[1]!;
  expect(argv).toContain("--model claude-sonnet-5");
  expect(argv).toContain(`--resume ${first!.sessionId}`); // rung 1 survives a model change
});

test("O6: past conversations are listed, searched and read — archived ones included", async () => {
  await db.startTurn({ repo: "r", branch: "old-fix", runId: "run-old", provider: "claude", instruction: "Fix the flaky websocket reconnect", prompt: "p", startedAt: 1_700_000_000_000 });
  await db.finishTurn("run-old", { status: "done", response: "Root cause was a missing backoff; added jitter.", finishedAt: 1_700_000_100_000 });
  await db.patchEnrichment("r", "old-fix", { title: "Websocket fix" });
  await db.archive("r", "old-fix"); // merged and reaped — exactly the kind worth finding later

  const listed = await orchestrator.tool(cfg(), "chats");
  expect(listed).toMatch(/^#\d+ r\/old-fix "Websocket fix" \[archived\] — 1 turn, last 2023-11-14 22:13$/);
  const id = listed.match(/^#(\d+)/)![1]!;

  const found = await orchestrator.tool(cfg(), "chats", { _: ["websocket", "backoff"] });
  expect(found).toContain(`#${id} r/old-fix [archived] — run run-old`);
  expect(found).toContain("❯ Fix the flaky websocket reconnect");
  expect(await orchestrator.tool(cfg(), "chats", { _: ["kubernetes"] })).toBe('No past turn matches "kubernetes".');

  expect(await orchestrator.tool(cfg(), "read", { chat: id })).toContain("→ Root cause was a missing backoff; added jitter.");
  expect(await orchestrator.tool(cfg(), "read", { run: "run-old" })).toContain("run run-old — done");
  await expect(orchestrator.tool(cfg(), "read", { run: "nope" })).rejects.toThrow("no turn with run id nope");
});

test("O7: send continues a workstream on its native session, queues behind a live run, and adopts it", async () => {
  await orchestrator.tool(cfg(), "spawn", brief);
  const branch = Object.keys(await db.enrichment("r"))[0]!;
  const [first] = await settled(() => db.turns("r", branch), 1);
  await db.patchEnrichment("r", branch, { orchestrated: null }); // as if you had made it by hand

  await writeFile(hold, "");
  expect(await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["Also", "handle", "the", "empty", "case"] })).toContain(`Sent to r/${branch}`);
  expect(await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["And add a test"] })).toContain("Queued behind the run in flight");
  expect((await db.queuedMessages("r", branch)).map((m) => m.instruction)).toEqual(["And add a test"]);
  expect((await db.enrichment("r"))[branch]!.orchestrated).toBe(true);
  await rm(hold);

  const turns = await settled(() => db.turns("r", branch), 2);
  expect(turns[1]!.instruction).toBe("Also handle the empty case");
  expect((await launches())[1]).toContain(`--resume ${first!.sessionId}`);
  await expect(orchestrator.tool(cfg(), "send", { repo: "r", branch })).rejects.toThrow("the message is required");
  await expect(orchestrator.tool(cfg(), "address", { repo: "r", branch })).rejects.toThrow(`r/${branch} has no open PR to address`);
});

test("O11: preview starts a workstream's preview on the board's path, and --status reports state + the log tail", async () => {
  const withService = (command: string): OrcaConfig => {
    const c = cfg();
    c.repos[0] = { ...c.repos[0]!, features: { previews: true }, previewServices: [{ name: "backend", command }] };
    return c;
  };
  const failing = withService("echo '[orca] preview DB setup failed: no snapshot'; exit 1");
  const { branch, worktreePath } = await verbs.newWorktree(failing.repos[0]!, "demo");
  const at = { repo: "r", branch };
  // The preloaded happy-dom swaps `fetch` for a browser one that CORS-blocks the readiness probe of a
  // real port, and `AbortSignal` for one Bun's fetch refuses; the bridge runs on Bun's, so the probe
  // gets Bun's here.
  const browser = { fetch: globalThis.fetch, AbortSignal: globalThis.AbortSignal };
  Object.assign(globalThis, native);
  try {
    await expect(orchestrator.tool(cfg(), "preview", at)).rejects.toThrow("Previews are not enabled for r");
    await expect(orchestrator.tool(failing, "preview", { repo: "r" })).rejects.toThrow("--branch is required");
    expect(await orchestrator.tool(failing, "preview", { ...at, status: "" })).toContain(`No preview for r/${branch}`);

    // A boot that dies: the state says failed and the log says why.
    expect(await orchestrator.tool(failing, "preview", at)).toContain(`Starting the preview for r/${branch}: backend http://localhost:`);
    let status = "";
    for (let i = 0; i < 200 && !status.includes(": failed"); i++, await Bun.sleep(25)) status = await orchestrator.tool(failing, "preview", { ...at, status: "" });
    expect(status).toContain(`Preview r/${branch}: failed`);
    expect(status).toContain("--- backend log (tail) ---\n[orca] preview DB setup failed: no snapshot");

    // A restart that comes up: running, with the URL — and the log is there for a live service too.
    const serving = withService(`echo booted; exec "${process.execPath}" -e 'Bun.serve({port:{port},fetch:()=>new Response("ok")})'`);
    await orchestrator.tool(serving, "preview", at);
    for (let i = 0; i < 200 && !status.includes(": running"); i++, await Bun.sleep(25)) status = await orchestrator.tool(serving, "preview", { ...at, status: "" });
    const [svc] = await preview.status(worktreePath); // keyed by the worktree path, as the board's is
    expect(status).toContain(`Preview r/${branch}: running\n  backend: running http://localhost:${svc!.port}`);
    expect(status).toContain("--- backend log (tail) ---\nbooted");
  } finally {
    Object.assign(globalThis, browser);
    preview.stop(worktreePath);
  }
});

test("O12: the orca command reads a flag followed by another flag as a switch", async () => {
  let got: unknown;
  // node:http, not Bun.serve: happy-dom's preloaded `Response` is not one Bun.serve accepts.
  const bridge = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => { got = JSON.parse(body); res.end('{"text":"ok"}'); });
  });
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
  try {
    const run = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/orca"), "preview", "--status", "--repo", "r", "--branch", "b", "word"], {
      env: { ...process.env, ORCA_URL: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}` }, stdout: "pipe",
    });
    expect((await new Response(run.stdout).text()).trim()).toBe("ok");
    expect(got).toEqual({ verb: "preview", args: { status: "", repo: "r", branch: "b", _: ["word"] } });
  } finally {
    bridge.close();
  }
});

test("O8: the ladder decision and the orchestrator's views are pure", () => {
  const turn = (over: Partial<AgentTurn> = {}): AgentTurn => ({ id: "t", provider: "claude", prompt: "p", response: "ok", sessionId: "s1", ...over });
  const base = { provider: "claude" as const, from: "claude" as const, sessionId: "s1", transcript: [turn()] };
  expect(continuation(base)).toEqual({ resume: "s1" });
  expect(continuation({ ...base, contextPct: 79 })).toEqual({ resume: "s1" });
  // 80% full → reset on the same provider; a different provider → handoff; both carry the transcript.
  expect(continuation({ ...base, contextPct: 80 })).toEqual({ history: base.transcript, handoffFrom: "claude" });
  expect(continuation({ ...base, provider: "codex" })).toEqual({ history: base.transcript, handoffFrom: "claude" });
  // A session the provider cannot find is never resumed again; an ordinary failure still is.
  const missing = [turn({ failed: true, response: "No conversation found with session ID s1" })];
  expect(continuation({ ...base, transcript: missing })).toEqual({ history: missing, handoffFrom: "claude" });
  expect(continuation({ ...base, transcript: [turn({ failed: true, response: "tests failed" })] }).resume).toBe("s1");
  // Nothing has run: a plain first launch, not a handoff over nothing.
  expect(continuation({ provider: "claude", transcript: [] })).toEqual({ history: [], handoffFrom: undefined });

  expect(workerEvent({
    repo: "r", branch: "b", runId: "run-1", status: "done",
    outcome: { outcome: "Added the cache.", remaining: ["docs"], decisions: [], verification: ["ran tests"], commits: ["abc1234 add cache"] },
    check: { command: "bun run check", ok: false, exitCode: 1, output: "1 fail", durationMs: 5 },
  })).toBe([
    "[worker finished] r/b — done",
    "Orca's check `bun run check` FAILED (exit 1):\n1 fail",
    "Outcome: Added the cache.", "Remaining:", "- docs", "Commits:", "- abc1234 add cache",
    "Full turn: orca read --run run-1",
  ].join("\n"));

  // What counts as a problem is read off the report itself, so a queued one can be judged later.
  const clean = workerEvent({ repo: "r", branch: "b", runId: "x", status: "done", response: "ok" });
  const failedRun = workerEvent({ repo: "r", branch: "b", runId: "x", status: "error", response: "boom" });
  const failedCheck = workerEvent({ repo: "r", branch: "b", runId: "x", status: "done", response: "ok", check: { command: "bun run check", ok: false, exitCode: 1, output: "x", durationMs: 1 } });
  const passedCheck = workerEvent({ repo: "r", branch: "b", runId: "x", status: "done", response: "ok", check: { command: "bun run check", ok: true, exitCode: 0, output: "", durationMs: 1 } });
  expect([clean, failedRun, failedCheck, passedCheck].map(isWorkerProblem)).toEqual([false, true, true, false]);
  expect(onlyCleanReports([clean, passedCheck])).toBe(true);
  expect(onlyCleanReports([clean, failedRun])).toBe(false);
  expect(onlyCleanReports([clean, "what is running?"])).toBe(false);
  expect(onlyCleanReports([])).toBe(false);

  expect(boardText([])).toBe("(no workstreams)");
  expect(boardText([{
    repo: "r", branch: "b", title: "Cache", agent: "done", check: false, orchestrated: true, worktreePath: "/wt/b",
    pr: { number: 7, isDraft: true, reviewStatus: "changes_requested", ciStatus: "failing", mergeable: "CONFLICTING" },
    last: "Added the\ncache.",
  }])).toBe('r/b "Cache" | PR #7 draft review:changes_requested ci:failing CONFLICTS | agent:done | check:FAILED | yours | /wt/b | last: Added the cache.');
});

test("O13: a wake that hits its budget cap says so, and its message is retried by a wake told why", async () => {
  wire();
  ledger.clear(); // the module loaded whatever the state dir held at import
  // One tool call, then the CLI's own budget result — the subtype is how the cap is told apart.
  await fakeClaude(firstLaunch(`cat <<'JSON'
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"orca board"}}]}}
{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":13.02}
JSON
exit 1`));
  await orchestrator.message({ ...cfg(), orchestratorWakeBudgetUsd: 25 }, "ship the cache"); // a cap only when configured
  const [dead, retry] = await settled(orchTurns, 2);
  expect(dead).toMatchObject({ failed: true, stopReason: "budget_reached" });
  expect(dead!.response).toBe(`Wake stopped: hit the 25 USD budget cap after 1 tool call ($13.02 spent).\nRe-queued what it was handling; the next wake is told why and finishes the reply.`);
  // The retry is the same message on the same session, told what happened to the wake before it.
  expect(retry!.instruction).toBe("ship the cache");
  expect(retry).toMatchObject({ failed: undefined, response: "## Outcome\nDone." });
  expect(retry!.prompt).toContain(`## Previous wake was cut off\nYour previous wake hit the 25 USD budget cap before it finished its turn`);
  expect(retry!.prompt).toContain("check the board before you spawn or send");
  const [first, second] = await launches();
  expect(first).toContain(`--max-budget-usd 25 `);
  expect(second).toContain(`--resume ${dead!.sessionId}`);
  // It ended normally, so nothing is left to retry or to tell the next wake.
  const b = await orchBlob();
  expect([b.handling, b.died, b.cutOff]).toEqual([undefined, undefined, undefined]);
  expect(await orchQueue()).toEqual([]);
  await orchestrator.message(cfg(), "thanks");
  expect((await settled(orchTurns, 3))[2]!.prompt).not.toContain("Previous wake was cut off");

  // Spend per wake: in the ledger (with the reason no longer collapsed), and on the popout with a hint.
  expect(ledger.all().find((e) => e.action === "orchestrate" && e.status === "error")).toMatchObject({ errorKind: "budget", costUsd: 13.02 });
  expect(await orchestrator.status({ ...cfg(), orchestratorWakeBudgetUsd: 25 })).toMatchObject({ lastWakeUsd: 13.02, hint: expect.stringContaining("a fresh session would be much cheaper") });

  // The cap is config; no cap at all unless set.
  await orchestrator.message({ ...cfg(), orchestratorWakeBudgetUsd: 9 }, "again");
  await settled(orchTurns, 4);
  expect((await launches()).at(-1)).toContain("--max-budget-usd 9 ");
  await orchestrator.message(cfg(), "and unbounded");
  await settled(orchTurns, 5);
  expect((await launches()).at(-1)).not.toContain("--max-budget-usd");
  const doc = (orchestratorWakeBudgetUsd: unknown) => ({ repos: [{ name: "app", repoPath: "/a", worktreeRoot: "/a/.wt", baseBranch: "main" }], orchestratorWakeBudgetUsd });
  expect(parseConfigDocument(doc(0)).errors).toContain("orchestratorWakeBudgetUsd must be a positive number of dollars");
  expect(parseConfigDocument(doc(8)).config?.orchestratorWakeBudgetUsd).toBe(8);
});

test("O14: a message whose wake dies twice is not queued a third time", async () => {
  wire();
  await fakeClaude(`echo "boom: not logged in" >&2; exit 3`);
  await orchestrator.message(cfg(), "do the thing");
  const [first, second] = await settled(orchTurns, 2);
  expect(first!.response).toBe("Wake stopped: exited with code 3: boom: not logged in after 0 tool calls.\nRe-queued what it was handling; the next wake is told why and finishes the reply.");
  expect(second!.instruction).toBe("do the thing");
  expect(second!.response).toBe("Wake stopped: exited with code 3: boom: not logged in after 0 tool calls.\nNot retried again: the wake handling this has now died twice. Send it again to retry.");
  await new Promise((r) => setTimeout(r, 200));
  expect(await orchTurns()).toHaveLength(2);
  expect(await orchQueue()).toEqual([]);
  // Sending it again is a new message: it gets its own two attempts.
  await orchestrator.message(cfg(), "do the thing");
  expect((await settled(orchTurns, 4))[3]!.response).toContain("Not retried again");
});

test("O15: a timed-out wake and one that ends on the CLI's placeholder are retried; one you stop is not", async () => {
  wire();
  ledger.clear(); // the module loaded whatever the state dir held at import
  const slow = { ...cfg(), agentTimeoutMinutes: 0.02 };
  await writeFile(hold, "");
  await orchestrator.message(slow, "think hard");
  for (let i = 0; i < 400 && !(await orchTurns())[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
  await rm(hold, { force: true }); // the retry answers
  const [dead, retry] = await settled(orchTurns, 2);
  expect(dead!.response).toStartWith("Wake stopped: timed out at 0.02 minutes after 0 tool calls.\nRe-queued");
  expect(retry!.prompt).toContain("Your previous wake timed out at 0.02 minutes");
  expect(ledger.all().find((e) => e.action === "orchestrate" && e.status === "error")!.errorKind).toBe("timeout");

  // Exit 0 with the CLI's "No response requested." is still no reply to the user.
  await fakeClaude(firstLaunch(`printf '{"type":"result","subtype":"success","result":"No response requested.","is_error":false}'; exit 0`));
  await orchestrator.message(cfg(), "and the docs?");
  const turns = await settled(orchTurns, 4);
  expect(turns[2]).toMatchObject({ failed: true, response: expect.stringContaining("Wake stopped: ended without a reply after 0 tool calls.") });
  expect(turns[3]).toMatchObject({ instruction: "and the docs?", response: "## Outcome\nDone." });

  // Stop is your decision, not a death: nothing is re-queued.
  await writeFile(hold, "");
  await orchestrator.message(cfg(), "never mind");
  agent.stop(orchestrator.dir());
  await rm(hold, { force: true });
  const stopped = (await settled(orchTurns, 5))[4]!;
  expect(stopped.stopped).toBe(true);
  expect(await orchQueue()).toEqual([]);
});

test("O16: a wake in flight when the bridge restarted is re-queued at startup — unless it finished on its own", async () => {
  wire();
  const inFlight = async (runId: string, instance = db.instanceName()) => {
    await db.startTurn({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, runId, provider: "claude", instruction: "finish the plan", prompt: "p", startedAt: Date.now() });
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { handling: { runId, instance, messages: ["finish the plan"] } });
  };
  // Another instance's wake is not ours to judge.
  await inFlight("run-a", "elsewhere");
  await orchestrator.recover(cfg(), () => db.reconcileRunning(new Set()));
  expect((await orchTurns())[0]!.finishedAt).toBeUndefined();

  // It outlived the bridge and finished (reconcile recovered its answer): nothing to retry.
  await inFlight("run-a");
  await transcript.append("run-a", [{ at: 1, kind: "tool", id: "t", name: "Bash" }, { at: 2, kind: "text", text: "All done." }]);
  await orchestrator.recover(cfg(), () => db.finishTurn("run-a", { status: "done", response: "All done.", finishedAt: Date.now() }));
  expect((await orchBlob()).handling).toBeUndefined();
  expect(await orchTurns()).toHaveLength(1);

  // It died with the bridge: the turn says so, and the message is handled by a new wake.
  await inFlight("run-b");
  await orchestrator.recover(cfg(), () => db.reconcileRunning(new Set()));
  const turns = await settled(orchTurns, 3);
  expect(turns[1]!.response).toStartWith("Wake stopped: was cut off by an Orca restart after 0 tool calls.\nRe-queued");
  expect(turns[2]!.instruction).toBe("finish the plan");
  expect(turns[2]!.prompt).toContain("Your previous wake was cut off by an Orca restart");
});

test("O17: the exit line and the large-session hint are pure", () => {
  expect(wakeExitReason({ kind: "timeout", minutes: 45 })).toBe("timed out at 45 minutes");
  expect(wakeStoppedLine({ reason: "hit the 5 USD budget cap", toolCalls: 2, retried: 0, dropped: 0 })).toBe("Wake stopped: hit the 5 USD budget cap after 2 tool calls.");
  // Hint once a wake costs half its cap, or the context is half full; never below both.
  expect(sessionHint({ budgetUsd: 5 })).toBeUndefined();
  expect(sessionHint({ lastWakeUsd: 40 })).toBeUndefined(); // no cap configured → spend alone is not a hint
  expect(sessionHint({ budgetUsd: 5, lastWakeUsd: 2.4, contextPct: 49 })).toBeUndefined();
  expect(sessionHint({ budgetUsd: 5, lastWakeUsd: 2.5 })).toContain("fresh session");
  expect(sessionHint({ budgetUsd: 10, lastWakeUsd: 2.5, contextPct: 50 })).toContain("fresh session");
});

test("O18: archive removes an idle workstream's worktree and card, keeping its transcript readable", async () => {
  await orchestrator.tool(cfg(), "spawn", brief);
  const branch = Object.keys(await db.enrichment("r"))[0]!;
  await settled(() => db.turns("r", branch), 1);
  const convBefore = (await db.conversations()).find((c) => c.branch === branch)!;

  expect(await orchestrator.tool(cfg(), "archive", { repo: "r", branch })).toContain(`Archived r/${branch}`);

  expect(await db.enrichment("r")).toEqual({}); // dropped from the board
  expect(await git.listWorktrees(repo, worktrees)).toEqual([]); // worktree reaped
  const convAfter = (await db.conversations()).find((c) => c.branch === branch);
  expect(convAfter).toMatchObject({ archived: true }); // nothing deleted — archived
  expect(await db.conversationTurns(convAfter!.id)).toHaveLength(1); // transcript stays readable
  expect(convAfter!.id).toBe(convBefore.id);
  expect(await orchestrator.tool(cfg(), "chats", { _: [] })).toContain("[archived]");
});

test("O19: archive stops a running worker first and drops anything queued for it", async () => {
  await orchestrator.tool(cfg(), "spawn", brief);
  const branch = Object.keys(await db.enrichment("r"))[0]!;
  await settled(() => db.turns("r", branch), 1);
  const worktreePath = (await git.listWorktrees(repo, worktrees)).find((w) => w.branch === branch)!.worktreePath;

  await writeFile(hold, ""); // the next run blocks until released
  expect(await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["keep", "going"] })).toContain(`Sent to r/${branch}`);
  expect(agent.isRunning(worktreePath)).toBe(true);
  expect(await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["and", "then", "this"] })).toContain("Queued behind the run in flight");
  expect((await db.queuedMessages("r", branch)).map((m) => m.instruction)).toEqual(["and then this"]);

  expect(await orchestrator.tool(cfg(), "archive", { repo: "r", branch })).toContain(`Archived r/${branch}`);

  expect(agent.isRunning(worktreePath)).toBe(false); // the running agent was stopped, not left to finish
  expect(await db.queuedMessages("r", branch)).toEqual([]); // nothing left to resurrect it
  expect(existsSync(worktreePath)).toBe(false);
});

test("O20: archive refuses a branch this orchestrator isn't responsible for", async () => {
  const { branch } = await verbs.newWorktree(cfg().repos[0]!, "manual"); // as if the user made it by hand
  await db.patchEnrichment("r", branch, { title: "Manual" }); // no orchestrated flag
  await expect(orchestrator.tool(cfg(), "archive", { repo: "r", branch })).rejects.toThrow("is not an orchestrated workstream");
  expect(await db.enrichment("r")).toHaveProperty(branch); // left untouched
  await expect(orchestrator.tool(cfg(), "archive", { repo: "r" })).rejects.toThrow("--branch is required");
});
