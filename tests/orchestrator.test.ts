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
import * as orchestrator from "../server/orchestrator";
import * as preview from "../server/preview";
import * as verbs from "../server/verbs";
import { parseConfigDocument, type OrcaConfig } from "../server/config";
import type { AgentTurn } from "../shared/agent";
import {
  ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, WORKER_EVENT_MARKER, boardText, continuation, workerEvent,
} from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, worktrees: string, log: string, hold: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24,
});

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", "ORCA_FAKE_HOLD"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-orch-${n}-`))))) as [string, string, string, string];
  repo = await makeScratchRepo();
  hold = join(state, "hold");
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
printf '{"type":"result","subtype":"success","result":"## Outcome\\\\nDone.","is_error":false}'
`);
  await chmod(join(shim, "claude"), 0o755);
  pg = await freshSchema("orchestrator");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await rm(hold, { force: true });
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
const brief = { repo: "r", title: "Add cache", objective: "Add a response cache", output: "One commit", boundaries: "Only touch src/cache" };

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
  expect(wake!.prompt).toContain("claude-fable-5-1: ONLY work that has already defeated a cheaper model");
  expect(wake!.prompt).toContain("A message opening with `[new draft]` is the user's New-draft box");
});

test("O11: send --model moves a workstream to another model for this and later messages", async () => {
  await orchestrator.tool(cfg(), "spawn", { ...brief, model: "claude-haiku-4-5-20251001" });
  const branch = Object.keys(await db.enrichment("r"))[0]!;
  await settled(() => db.turns("r", branch), 1);
  expect((await launches())[0]).toContain("--model claude-haiku-4-5-20251001");

  await expect(orchestrator.tool(cfg(), "send", { repo: "r", branch, model: "gpt-9", _: ["again"] })).rejects.toThrow('unknown model "gpt-9"');
  await orchestrator.tool(cfg(), "send", { repo: "r", branch, model: "claude-opus-5", _: ["Harder", "than", "it", "looked"] });
  await settled(() => db.turns("r", branch), 2);
  expect((await launches())[1]).toContain("--model claude-opus-5");
  expect((await db.enrichment("r"))[branch]).toMatchObject({ preferredModel: "claude-opus-5", preferredProvider: "claude" });
  // The card's picker shows the move, and the next message keeps it.
  await orchestrator.tool(cfg(), "send", { repo: "r", branch, _: ["and again"] });
  await settled(() => db.turns("r", branch), 3);
  expect((await launches())[2]).toContain("--model claude-opus-5");
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

test("O2: a brief missing a part, an unknown repo, and a fifth concurrent worker are all refused", async () => {
  await expect(orchestrator.tool(cfg(), "spawn", { repo: "r", objective: "Do it" })).rejects.toThrow("--output is required; --boundaries is required");
  await expect(orchestrator.tool(cfg(), "spawn", { ...brief, repo: "nope" })).rejects.toThrow("--repo must be one of: r");
  await expect(orchestrator.tool(cfg(), "bogus")).rejects.toThrow('unknown command "bogus"');
  expect(await db.enrichment("r")).toEqual({});

  await writeFile(hold, ""); // workers stay running
  for (let i = 0; i < orchestrator.MAX_WORKERS; i++) await orchestrator.tool(cfg(), "spawn", brief);
  await expect(orchestrator.tool(cfg(), "spawn", brief)).rejects.toThrow(`${orchestrator.MAX_WORKERS} of your workers are already running`);
  expect(Object.keys(await db.enrichment("r"))).toHaveLength(orchestrator.MAX_WORKERS);
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
});

test("O4: the wake cap pauses self-waking; your next message resumes it with what was held", async () => {
  const finished = (branch: string, extra: Partial<agent.RunFinished> = {}): agent.RunFinished => ({
    key: "k", cwd: "k", runId: `run-${branch}`, status: "error", result: "boom", continued: false,
    options: { repo: "r", branch }, ...extra,
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
  // Nothing pinned → Sonnet, whatever the workers' default is: its own work is triage.
  expect((await orchestrator.status(cfg())).model).toBe(orchestrator.ORCHESTRATOR_DEFAULT_MODEL);
  expect((await orchestrator.status({ ...cfg(), agentModel: "claude-fable-5-1" })).model).toBe("claude-sonnet-5");
  await expect(orchestrator.setModel("gpt-5.5")).rejects.toThrow("runs on a Claude model");

  await orchestrator.message(cfg(), "hello");
  const [first] = await settled(orchTurns, 1);
  expect((await launches())[0]).toContain("--model claude-sonnet-5");

  await orchestrator.setModel("claude-opus-5");
  expect((await orchestrator.status(cfg())).model).toBe("claude-opus-5");
  await orchestrator.message(cfg(), "and again");
  await settled(orchTurns, 2);
  const argv = (await launches())[1]!;
  expect(argv).toContain("--model claude-opus-5");
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
  // real port; the bridge runs on Bun's, so the probe gets Bun's here.
  const browserFetch = globalThis.fetch;
  globalThis.fetch = Bun.fetch as typeof fetch;
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
    globalThis.fetch = browserFetch;
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

  expect(boardText([])).toBe("(no workstreams)");
  expect(boardText([{
    repo: "r", branch: "b", title: "Cache", agent: "done", check: false, orchestrated: true, worktreePath: "/wt/b",
    pr: { number: 7, isDraft: true, reviewStatus: "changes_requested", ciStatus: "failing", mergeable: "CONFLICTING" },
    last: "Added the\ncache.",
  }])).toBe('r/b "Cache" | PR #7 draft review:changes_requested ci:failing CONFLICTS | agent:done | check:FAILED | yours | /wt/b | last: Added the cache.');
});
