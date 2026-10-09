// The context ring's Compact button: `/compact` in a conversation's own Claude session, for a card's
// worker and for the orchestrator. Same harness as orchestrator.test.ts — a real git scratch repo, a
// fake `claude` on PATH that answers `/compact` the way the real CLI's stream-json does, real Postgres.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as agent from "../server/agent";
import * as git from "../server/git";
import * as orchestrator from "../server/orchestrator";
import * as verbs from "../server/verbs";
import type { OrcaConfig } from "../server/config";
import type { AgentTurn } from "../shared/agent";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, setPrListFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let state: string, shim: string, repo: string, worktrees: string, log: string, hold: string;
let pg: TestDb;
let prev: Record<string, string | undefined> = {};

const cfg = (): OrcaConfig => ({
  repos: [{ name: "r", repoPath: repo, worktreeRoot: worktrees, baseBranch: "main", previewServices: [], providers: ["claude"] }],
  portRange: [30000, 40000], staleHours: 24,
});

// The events the real CLI emits for `claude -p --resume <id> -- /compact` (captured from one): no
// model turn, so the result carries no usage; the count left in context is in compact_boundary.
const MODEL_USAGE = `"modelUsage":{"claude-haiku-4-5":{"outputTokens":5,"contextWindow":1000000},"claude-opus-5-5":{"outputTokens":900,"contextWindow":200000}}`;
const COMPACTED = [
  `{"type":"system","subtype":"status","status":"compacting","session_id":"S"}`,
  `{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"S"}`,
  `{"type":"system","subtype":"compact_boundary","session_id":"S","compact_metadata":{"trigger":"manual","pre_tokens":150000,"post_tokens":20000}}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"","num_turns":0,"session_id":"S","usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0,"iterations":[]},${MODEL_USAGE}}`,
];
const COMPACT_FAILED = [
  `{"type":"system","subtype":"status","status":"compacting","session_id":"S"}`,
  `{"type":"system","subtype":"status","status":null,"compact_result":"failed","compact_error":"Error during compaction: summarization produced empty response","session_id":"S"}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"Error during compaction: summarization produced empty response","num_turns":0,"session_id":"S","usage":{"iterations":[]},${MODEL_USAGE}}`,
];

beforeEach(async () => {
  prev = Object.fromEntries(["ORCA_STATE_DIR", "ORCA_DATABASE_URL", "PATH", "ORCA_FAKE_LOG", "ORCA_FAKE_HOLD"].map((k) => [k, process.env[k]]));
  [state, shim, worktrees, log] = await Promise.all(["state", "claude", "wt", "log"].map(async (n) => realpathSync(await mkdtemp(join(tmpdir(), `orca-compact-${n}-`))))) as [string, string, string, string];
  repo = await makeScratchRepo();
  hold = join(state, "hold");
  process.env.ORCA_STATE_DIR = state;
  process.env.ORCA_FAKE_LOG = log;
  process.env.ORCA_FAKE_HOLD = hold;
  process.env.PATH = `${shim}:${prev.PATH}`;
  await installFakeGh();
  await setPrListFixture([]);
  // A fake claude: records its argv, waits while the hold file exists, then answers `/compact` with
  // the compaction events and anything else with an ordinary turn at 72% of Opus's window.
  await writeFile(join(shim, "claude"), `#!/bin/sh
printf '%s' "$*" > "$ORCA_FAKE_LOG/$(date +%s%N)-$$"
while [ -f "$ORCA_FAKE_HOLD" ]; do sleep 0.02; done
case "$*" in
  *"-- /compact") cat "$ORCA_FAKE_HOLD.compact" ;;
  *) printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"## Outcome\\\\nDone.","usage":{"input_tokens":4000,"cache_read_input_tokens":140000,"cache_creation_input_tokens":0,"output_tokens":10},${MODEL_USAGE}}' ;;
esac
`);
  await chmod(join(shim, "claude"), 0o755);
  await answerCompact(COMPACTED);
  pg = await freshSchema("compact");
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

const answerCompact = (lines: string[]) => writeFile(`${hold}.compact`, lines.join("\n") + "\n");
const anyRunning = async () => agent.isRunning(orchestrator.dir())
  || (await git.listWorktrees(repo, worktrees).catch(() => [])).some((w) => agent.isRunning(w.worktreePath));
const launches = async () => Promise.all((await readdir(log)).sort().map((f) => readFile(join(log, f), "utf8")));
async function settled(read: () => Promise<AgentTurn[]>, n: number): Promise<AgentTurn[]> {
  for (let i = 0; i < 400; i++) {
    const turns = await read();
    if (turns.length >= n && turns.every((t) => t.finishedAt) && !(await anyRunning())) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never settled at ${n} turn(s)`);
}

test("C1: a worker's Compact runs /compact on a native resume of its own session, and the ring re-reads", async () => {
  await writeFile(hold, "");
  const { branch, worktreePath } = await verbs.createWorkstream(cfg(), cfg().repos[0]!, { prompt: "add a cache", model: "claude-opus-5-5" });
  // Mid-turn: refused, never queued — `/compact` only works as the whole prompt of its own run.
  await expect(verbs.compact(cfg(), cfg().repos[0]!, branch)).rejects.toBeInstanceOf(verbs.BusyError);
  await rm(hold);
  const turns = () => db.turns("r", branch);
  await settled(turns, 1);
  expect(agent.status(worktreePath).meta?.contextPct).toBe(72);
  const sessionId = (await db.enrichment("r"))[branch]!.sessionId as string;

  await verbs.compact(cfg(), cfg().repos[0]!, branch);
  const [, compacted] = await settled(turns, 2);
  const argv = (await launches()).at(-1)!;
  expect(argv).toContain(`--resume ${sessionId}`); // the same session, not a fresh one or a handoff
  expect(argv).toEndWith("-- /compact"); // bare: no chat scaffolding around the command
  expect(argv).toContain("--model claude-opus-5-5");
  expect(compacted).toMatchObject({ instruction: "/compact", response: "Compacted: 150000 → 20000 tokens." });
  expect(compacted!.failed).toBeFalsy();
  // 20k left over Opus's 200k window — Opus, the primary model, not the auxiliary Haiku's window.
  expect(agent.status(worktreePath).meta?.contextPct).toBe(10);
});

test("C2: a failed compaction is a failed turn with the CLI's reason, though the CLI calls it success", async () => {
  await answerCompact(COMPACT_FAILED);
  const { branch, worktreePath } = await verbs.createWorkstream(cfg(), cfg().repos[0]!, { prompt: "add a cache", model: "claude-opus-5-5" });
  await settled(() => db.turns("r", branch), 1);
  await verbs.compact(cfg(), cfg().repos[0]!, branch);
  const [, compacted] = await settled(() => db.turns("r", branch), 2);
  expect(compacted!.failed).toBe(true);
  expect(compacted!.response).toBe("Error during compaction: summarization produced empty response");
  expect(agent.status(worktreePath).meta?.contextPct).toBeUndefined(); // nothing was measured
});

test("C3: only a Claude session can be compacted", async () => {
  await db.patchEnrichment("r", "feat", { agentProvider: "codex", sessionId: "codex-1" });
  await expect(verbs.compact(cfg(), cfg().repos[0]!, "feat")).rejects.toThrow("only a Claude session can be compacted");
});

test("C4: an orchestrated worker's compact does not report to the orchestrator", async () => {
  agent.onRunFinished((run) => orchestrator.onRunFinished(cfg(), run));
  const { branch } = await verbs.createWorkstream(cfg(), cfg().repos[0]!, { prompt: "add a cache", model: "claude-opus-5-5" });
  await settled(() => db.turns("r", branch), 1);
  await db.patchEnrichment("r", branch, { orchestrated: true }); // marked after its first run, so that one didn't report either
  await verbs.compact(cfg(), cfg().repos[0]!, branch);
  await settled(() => db.turns("r", branch), 2);
  expect(await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).toEqual([]);
  expect(await db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).toEqual([]);
});

test("C5: the orchestrator's Compact runs on its own session: refused mid-wake, no wake of its own", async () => {
  agent.onRunFinished((run) => orchestrator.onRunFinished(cfg(), run));
  const orch = () => db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
  await expect(orchestrator.compact(cfg())).rejects.toThrow("no session to compact");

  await writeFile(hold, "");
  await orchestrator.message(cfg(), "what is running?");
  await expect(orchestrator.compact(cfg())).rejects.toBeInstanceOf(verbs.BusyError);
  await rm(hold);
  await settled(orch, 1);
  const { sessionId } = (await db.enrichment(ORCHESTRATOR_REPO))[ORCHESTRATOR_BRANCH]!;
  expect((await orchestrator.status(cfg())).contextPct).toBe(72);

  await orchestrator.compact(cfg());
  const all = await settled(orch, 2);
  const argv = (await launches()).at(-1)!;
  expect(argv).toContain(`--resume ${sessionId}`);
  expect(argv).toEndWith("-- /compact");
  expect(all.at(-1)).toMatchObject({ instruction: "/compact", response: "Compacted: 150000 → 20000 tokens." });
  expect((await orchestrator.status(cfg())).contextPct).toBe(10); // the window's ring re-reads
  // A compact is housekeeping, not a wake: no "Wake stopped" line, nothing re-queued, no third turn.
  await new Promise((r) => setTimeout(r, 100));
  expect(await orch()).toHaveLength(2);
});
