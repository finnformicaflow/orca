// The orchestrator: one conversation you talk to, which delegates to worker agents and is woken when
// they finish. Anthropic's orchestrator-workers pattern, kept to TWO layers — it, and the workstreams
// the board already shows.
//
// It is not a new runtime. A wake is the same headless one-shot every board action is, recorded as
// turns under a reserved (repo, branch) so the chat panel renders it unchanged. What makes it an
// orchestrator is only what it may run — the `orca` command (bin/orca → `tool` below), nothing else —
// and what wakes it: a message from you, or a worker it started going idle.
//
// The session is disposable. Everything it needs to carry on lives outside its context: its notes
// (rewritten by it, re-read on every wake), the live board, and the turn table. So the handover
// ladder applies to it like any other conversation — resume while the context is healthy, reset onto
// the portable transcript at 80% — and a reset loses nothing it was told to keep.
import { mkdirSync } from "fs";
import { join } from "path";
import * as agent from "./agent";
import * as db from "./db";
import * as primary from "./primary";
import * as lease from "./lease";
import * as procs from "./proc";
import * as attachments from "./attachments";
import * as git from "./git";
import * as gh from "./gh";
import * as verbs from "./verbs";
import * as prShots from "./prShots";
import * as preview from "./preview";
import * as mergeQueue from "./mergeQueue";
import { pushToTemplate } from "./pushTemplate";
import * as repos from "./repos";
import { stateDir } from "./state";
import { API_PORT } from "./ports";
import { featuresOf, runsHere, type OrcaConfig, type RepoConfig } from "./config";
import {
  MODEL_LADDER, NO_REPLY_PLACEHOLDER, ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, boardText, briefProblems, continuation, isWorkerEvent, isWorkerProblem, onlyCleanReports,
  joinMessages, ladderStep, mergedPrIsHistory, nextFailStreak, orchStatusText, orchStatusUpdate, orchestratorPrompt, sessionHint, sweepText, turnSource, wakeExitReason, wakeProgress, wakeStoppedLine, withAttachments, workerBrief, workerEvent,
  type BoardRow, type FailStreak, type OrchStatus, type WakeExit,
} from "../web/src/workstream";
import { activityLines, type AgentTurn } from "../shared/agent";
import { providerOfModel } from "../shared/models";
import { grantKey, grantRefusal, type Grant } from "../shared/integrations";

// ponytail: constants, not config — promote one to OrcaConfig the first time it needs tuning.
/** Wakes in a row with no message from you before it stops waking itself. The loop guard: an
 *  orchestrator and a worker can otherwise hand each other work indefinitely while you're away. */
export const MAX_WAKES = 12;
/** `--max-budget-usd` for one wake unless `orchestratorWakeBudgetUsd` says otherwise. Deciding what
 *  to delegate is cheap; a wake that isn't has gone wrong — or its session has grown (see sessionHint). */
/** `--max-budget-usd` for a wake — ONLY when `orchestratorWakeBudgetUsd` is set. There was a default
 *  (5, then 25): a long resumed session pays its cached context every turn and was cut off mid-reply
 *  several times a day. The user's call: it should work without worrying about dying. */
const budgetOf = (cfg: OrcaConfig): number | undefined => cfg.orchestratorWakeBudgetUsd;
/** How often startup recovery looks again at a wake that outlived the previous bridge. */
const RECOVER_POLL_MS = 5_000;
const NOTES_MAX = 20_000;

/** Its working directory, and the key its run is tracked under. Under the state dir — never a
 *  worktree — so nothing it writes can leak into a diff. */
export function dir(): string {
  const d = join(stateDir(), "orchestrator");
  mkdirSync(d, { recursive: true });
  return d;
}

type Blob = {
  notes?: string; wakes?: number; sessionId?: string; contextPct?: number; preferredModel?: string;
  lastWakeUsd?: number; // what its last wake cost, as the CLI reported it
  /** The wake in flight and the messages it took off the queue — in the blob, not memory, so a wake
   *  that dies with the bridge can still have them re-queued. */
  handling?: { runId: string; instance: string; messages: string[] };
  died?: string[]; // messages whose wake has died once and are being retried; a second death drops them
  cutOff?: string; // why the last wake died, for the next wake's prompt
  cutOffProgress?: string; // what that wake had already done and said (wakeProgress), for the same prompt
  /** The permission grant of the wake in flight (shared/integrations.ts §3.7): set before its launch,
   *  cleared when it ends. Absent or null = your own chat, the full grant. `tool` enforces it. */
  wakeGrant?: Grant | null;
};
/** The model it runs on: its pin, else Opus. Its judgement — what to delegate, how to brief, which
 *  model a task deserves — is what the workers' quality rests on, so it gets a strong model; Fable
 *  stays for the work itself where Opus has failed. Always a Claude model: its tool permissions are
 *  Claude Code's. (The user's call: Sonnet was tried first.) */
export const ORCHESTRATOR_DEFAULT_MODEL = "claude-opus-5-5";
const modelOf = (cfg: OrcaConfig, b: Blob): string =>
  (providerOfModel(b.preferredModel) === "claude" ? b.preferredModel! : undefined) ?? ORCHESTRATOR_DEFAULT_MODEL;
const blob = async (): Promise<Blob> => ((await db.enrichment(ORCHESTRATOR_REPO))[ORCHESTRATOR_BRANCH] ?? {}) as Blob;
const patch = (fields: db.Fields) => db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, fields);
const enqueue = (instruction: string, attachments: string[] = [], grant?: Grant | null) =>
  db.queueMessage({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, worktreePath: dir(), instruction, attachments, provider: "claude", ...(grant ? { grant } : {}) });

// Deliveries are serialised: two workers finishing in the same tick would otherwise both see an idle
// orchestrator, both launch, and the loser's message would be lost to "already running".
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

export async function status(cfg: OrcaConfig): Promise<{ key: string; running: boolean; paused: boolean; notes: string; model: string; contextPct?: number; shell: boolean; lastWakeUsd?: number; hint?: string; startedAt?: number; queued: number }> {
  const b = await blob();
  const running = agent.isRunning(dir());
  return {
    key: dir(), running, paused: (b.wakes ?? 0) >= MAX_WAKES, notes: b.notes ?? "",
    startedAt: running ? agent.runStartedAt(dir()) : undefined, // when the wake in flight began — the header's elapsed time
    queued: (await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)).length, // waiting for the next wake
    model: modelOf(cfg, b),
    contextPct: b.contextPct, // how full its last run left the session; absent until one has reported
    shell: cfg.orchestratorShell !== false,
    lastWakeUsd: b.lastWakeUsd,
    hint: sessionHint({ contextPct: b.contextPct, lastWakeUsd: b.lastWakeUsd, budgetUsd: budgetOf(cfg) }),
  };
}

/** Pin the model its next wake runs on. The session is kept: a resumed Claude session accepts a
 *  different --model (rung 1 of the ladder). */
export async function setModel(model: unknown): Promise<void> {
  if (typeof model !== "string" || providerOfModel(model) !== "claude") throw new Error("the orchestrator runs on a Claude model");
  await patch({ preferredModel: model });
}

/** Something you typed. Resets the wake count — a person is in the loop again. An outside sender's
 *  message (server/integrations/inbox.ts) carries its `grant`: it never shares a wake with a message
 *  of another grant, and that wake's `orca` verbs are checked against it. `person: false` (a webhook
 *  script, not a person) does not reset the wake count, so a script cannot keep it awake forever. */
export function message(cfg: OrcaConfig, text: string, attachments: string[] = [], opts: { grant?: Grant; person?: boolean } = {}): Promise<{ status: "running" | "queued" }> {
  const grant = opts.grant && opts.grant.level !== "full" ? opts.grant : undefined;
  return serial(async () => {
    if (opts.person !== false) await patch({ wakes: 0 });
    if (agent.isRunning(dir())) {
      await enqueue(text, attachments, grant);
      return { status: "queued" as const };
    }
    try {
      await wake(cfg, [withAttachments(text, attachments)], grant);
    } catch (e) {
      // The launcher's own guard caught a run this process can't see (its session is still busy
      // under a lease): wake() has put the message back on the queue, where the drain finds it.
      if (e instanceof Error && /already running/.test(e.message)) return { status: "queued" as const };
      throw e;
    }
    return { status: "running" as const };
  });
}

/** Compact its session (the context ring's Compact button): `/compact` on a native resume, as the
 *  card's verb does. Not a wake — no prompt, no board, no claimed messages; whatever queued while it
 *  ran is drained when it finishes, like after any run of its own. */
export function compact(cfg: OrcaConfig): Promise<{ runId: string }> {
  return serial(async () => {
    const b = await blob();
    if (!b.sessionId) throw new Error("the orchestrator has no session to compact yet");
    if (agent.isRunning(dir())) throw new verbs.BusyError();
    const { runId } = await agent.launch(dir(), dir(), "/compact", {
      provider: "claude", resume: b.sessionId, repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH,
      instruction: "/compact", action: "compact", queue: false, model: modelOf(cfg, b), source: "human", // your button
      timeoutMs: cfg.agentTimeoutMinutes ? cfg.agentTimeoutMinutes * 60_000 : undefined,
    });
    return { runId };
  });
}

/** Stop its wake (the chat's Stop). A stopped wake never reaches the run-finished hook, so this does
 *  its part here: drop the wake's claim (Stop is not a death, so nothing is re-queued) and send what
 *  queued up meanwhile at once — the same drain a finished wake gets. */
export async function stop(cfg: OrcaConfig): Promise<string | undefined> {
  const runId = await agent.interrupt(dir(), { queue: false });
  await serial(async () => {
    if (runId && (await blob()).handling?.runId === runId) await patch({ handling: null, wakeGrant: null, died: null });
    // Only the primary drains (as the run-finished hook does), and a failed drain never fails Stop.
    if (primary.held()) await drain(cfg).catch(db.logUnlessDown("orca: orchestrator drain after stop failed"));
  });
  return runId;
}

/** The run-finished hook (wired in index.ts). A worker the orchestrator is responsible for going
 *  idle wakes it with the outcome; its own run ending drains whatever arrived meanwhile. */
export async function onRunFinished(cfg: OrcaConfig, run: agent.RunFinished): Promise<void> {
  const { repo, branch } = run.options;
  if (!repo || !branch) return;
  if (repo === ORCHESTRATOR_REPO) {
    const exit = run.options.action === "compact" ? undefined : wakeExit(cfg, run); // a compact is no wake
    await serial(async () => {
      // Inside the chain: a patch is read-modify-write, and one racing the next wake's own would
      // write back a blob without that wake's `handling` claim — and with it the retry guard.
      await patch({
        sessionId: run.sessionId,
        ...(run.meta?.contextPct === undefined ? {} : { contextPct: run.meta.contextPct }),
        ...(run.meta?.costUsd === undefined ? {} : { lastWakeUsd: run.meta.costUsd }),
      });
      if (exit) await died(run.runId, exit, run.meta?.costUsd);
      // Only its own claim: a message of yours may have launched the next wake already.
      else if ((await blob()).handling?.runId === run.runId) await patch({ handling: null, wakeGrant: null, died: null });
      await drain(cfg);
    });
    return;
  }
  const e = (await db.enrichment(repo))[branch] ?? {};
  if (!e.orchestrated) return;
  // Codex and Cursor reveal their session id mid-run, and no browser may be open to record it.
  if (run.sessionId && e.sessionId !== run.sessionId) await db.patchEnrichment(repo, branch, { sessionId: run.sessionId });
  if (run.options.action === "compact") return; // housekeeping you asked for, not work to report
  const step = await ladder(cfg, repo, branch, e, run); // counted even when an autofix takes over
  if (run.continued) return; // a queued follow-up (an autofix) took over — not idle yet
  const opened = await autoPr(cfg, repo, branch, run);
  const text = workerEvent({
    repo, branch, title: e.title as string | undefined, runId: run.runId, status: run.status,
    outcome: run.structured, response: run.result, check: run.check,
  }) + (opened ? `\n${opened}` : "") + (step ? `\n${step}` : "");
  await report(cfg, text, run.key);
}

/** Model-ladder automation: keep the workstream's failure streak, and once it reaches the threshold
 *  on one model, suggest the next model up — or, with the repo's `modelEscalation: "apply"`, re-pin
 *  the workstream to it so the retry runs there. Returns the worker report's line, if any. Only at
 *  report time: an autofix taking over is counted, not escalated, so its own run is the retry. */
async function ladder(cfg: OrcaConfig, repoName: string, branch: string, e: db.Fields, run: agent.RunFinished): Promise<string | undefined> {
  const prev = e.failStreak as FailStreak | undefined;
  const failed = run.status === "error" || run.check?.ok === false;
  const streak = run.status === "stopped" ? prev : nextFailStreak(prev, run.options.model ?? (e.preferredModel as string | undefined), failed);
  if (JSON.stringify(streak) !== JSON.stringify(prev)) await db.patchEnrichment(repoName, branch, { failStreak: streak ?? null });
  if (run.continued) return undefined;
  const repo = cfg.repos.find((r) => r.name === repoName);
  const step = ladderStep(streak, repo?.modelEscalation ?? "suggest", { repo: repoName, branch });
  if (step?.moveTo) {
    // The send that retries reads the pin (as `send --model` does); the streak restarts on the new model.
    await db.patchEnrichment(repoName, branch, { preferredModel: step.moveTo, preferredProvider: providerOfModel(step.moveTo) ?? "claude", failStreak: null });
  }
  return step?.line;
}

/** The repo's `mergePolicy.autoPr`: a clean finish opens the branch's PR (verbs.openWorkerPr), and
 *  a branch marked merge-when-green before it had one joins the queue. Returns the line the worker
 *  report carries, or nothing. A failure is reported, never thrown — the report still goes. */
async function autoPr(cfg: OrcaConfig, repoName: string, branch: string, run: agent.RunFinished): Promise<string | undefined> {
  const repo = cfg.repos.find((r) => r.name === repoName);
  if (!repo?.mergePolicy?.autoPr || run.status !== "done" || run.check?.ok === false) return undefined;
  try {
    const pr = await verbs.openWorkerPr(repo, branch, run.key, { outcome: run.structured, response: run.result });
    if (!pr) return undefined;
    void mergeQueue.tick(cfg).catch(() => {}); // a branch already marked merge-when-green is picked up now
    return `Orca opened PR #${pr.number}: ${pr.url}`;
  } catch (e) {
    return `Orca could not open its PR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Hand a report to the orchestrator: here, or posted to the instance it lives on (ONE process wakes
 *  it — two resuming the same session at once was the "one message behind" bug). Worker reports and
 *  the merge queue's both go through this. */
export async function report(cfg: OrcaConfig, text: string, key?: string): Promise<void> {
  const host = cfg.orchestratorOn;
  if (host && host !== db.instanceName()) {
    const base = cfg.instances?.[host];
    if (!base) { console.error(`orca: orchestratorOn "${host}" has no address; report dropped`); return; }
    await fetch(new URL("/api/orchestrator/event", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, key }) })
      .catch((e) => console.error("orca: could not deliver a worker report to the orchestrator's instance", e));
    return;
  }
  await deliverReport(cfg, text, key);
}

/** Deliver a worker's report by the management-by-exception rules, from this or another instance. */
export async function deliverReport(cfg: OrcaConfig, text: string, key?: string): Promise<void> {
  // Management by exception. A manager is interrupted for a problem, not for every completion: a
  // worker that failed, was stopped, or whose commit failed Orca's check wakes the orchestrator now.
  // A clean finish is queued and delivered when the batch is done — the last of its running
  // workers finishing — or when the user next speaks, whichever is first; in between, the board
  // and `orca read` are there whenever it wants to check in.
  const exception = isWorkerProblem(text);
  await serial(async () => {
    const wakes = (await blob()).wakes ?? 0;
    const othersRunning = !exception && await workersRunning(cfg, key);
    // Held, not dropped: a paused orchestrator hears about it with your next message.
    if (agent.isRunning(dir()) || wakes >= MAX_WAKES || othersRunning) return void (await enqueue(text));
    await patch({ wakes: wakes + 1 });
    await wake(cfg, [text]);
  });
}

/** Why a wake died before finishing its turn, or undefined when it ended normally (or you stopped
 *  it). The budget is the CLI's own result subtype and the timeout is our own timer firing, so both
 *  are exact; `no-reply` is a heuristic over the CLI's placeholder text. */
function wakeExit(cfg: OrcaConfig, run: agent.RunFinished): WakeExit | undefined {
  if (run.status === "stopped") return undefined;
  if (run.exit.budgetReached) return { kind: "budget", budgetUsd: run.options.maxBudgetUsd ?? budgetOf(cfg) ?? 0 };
  if (run.exit.timedOut) return { kind: "timeout", minutes: (run.options.timeoutMs ?? 0) / 60_000 };
  if (run.status === "error") return { kind: "error", code: run.exit.code, stderr: run.exit.stderr || (run.result ?? "").slice(-300) };
  if (run.result?.trim() === NO_REPLY_PLACEHOLDER) return { kind: "no-reply" };
  return undefined;
}

/** A wake died mid-turn: say why on its turn, and put what it was handling back on the queue — once.
 *  A message whose wake has now died twice is not retried again; the turn's line says so instead. */
async function died(runId: string, exit: WakeExit, costUsd?: number): Promise<void> {
  const b = await blob();
  const messages = b.handling?.runId === runId ? b.handling.messages : [];
  const before = new Set(b.died ?? []);
  const retry = messages.filter((m) => !before.has(m));
  for (const m of retry) await enqueue(m, [], b.wakeGrant);
  const reason = wakeExitReason(exit);
  const steps = await agent.runSteps(runId).catch(() => []);
  const toolCalls = steps.filter((s) => s.kind === "tool" && s.name !== "result").length;
  await agent.flushHistory(); // the exit handler's own finish write lands first, or it would overwrite the line
  await db.failTurn(runId, wakeStoppedLine({ reason, toolCalls, costUsd, retried: retry.length, dropped: messages.length - retry.length }));
  // What it had done is read off the steps it recorded as it went — they outlive the process — so the
  // next wake neither repeats a spawn/merge nor leaves the user without the reply it had started.
  await patch({ handling: null, wakeGrant: null, died: retry, cutOff: retry.length ? reason : null, cutOffProgress: wakeProgress(steps) || null });
}

/** Startup: a wake that was in flight when the previous bridge stopped has nobody to report its
 *  exit. If it died with the bridge (a service manager kills the whole process group) its messages
 *  are re-queued like any other death; if it outlived the bridge and finished, the queue it left is
 *  drained. `reconcile` is index.ts's turn reconciliation, re-run once the wake is really gone. */
export async function recover(cfg: OrcaConfig, reconcile: () => Promise<unknown>, opts: { runId?: string } = {}): Promise<void> {
  const { handling } = await blob();
  // None, or another instance's wake — unless it is the run `evictForeignWake` just killed, whose
  // stray bridge may have stamped it with a different instance name.
  if (!handling || (opts.runId ? handling.runId !== opts.runId : handling.instance !== db.instanceName())) return;
  if (agent.isRunning(dir())) {
    // Still going under its lease, and its `orca` calls reach this bridge — let it finish, look again.
    setTimeout(() => void recover(cfg, reconcile, opts).catch(db.logUnlessDown("orca: orchestrator recovery failed")), RECOVER_POLL_MS).unref();
    return;
  }
  await reconcile();
  const turn = await db.turn(handling.runId);
  // ponytail: "finished" = its recovered transcript ends on text, not a tool call. A wake killed
  // right after narrating would pass as finished; read the session file's stop_reason if that bites.
  const last = (await agent.runSteps(handling.runId).catch(() => [])).at(-1);
  // (A wake you stopped never reaches the run-finished hook, so its claim is still here: not a death.)
  const finished = Boolean(turn?.finishedAt) && !turn?.failed && (turn?.stopped || last?.kind === "text");
  await serial(async () => {
    if ((await blob()).handling?.runId !== handling.runId) return;
    if (finished) await patch({ handling: null, wakeGrant: null, died: null });
    else await died(handling.runId, { kind: "restart" });
    await drain(cfg);
  });
}

/** The main side of the one-waker rule, for bridges on code too OLD to have it (incident 2026-10-15:
 *  a branch preview's bridge from before #215 ran 19h after its worktree was deleted, launching the
 *  orchestrator's wakes with a dead bin/ on PATH, so no `orca` command). The orchestrator's lease is
 *  per host, so whoever launched the current wake is its process's nearest bridge ancestor. Only this
 *  bridge — the instance's primary — may be it: another live bridge there is stale by definition, so
 *  it and its wake (broken: wrong PATH/ORCA_URL) are SIGTERMed, and `recover` re-queues what the wake
 *  was handling for a proper one. A wake with NO bridge above it outlived its bridge (a restart) and
 *  is left to `recover` as before. A claimant is stopped only when the SAME one is seen on two checks
 *  in a row: on a restart the previous primary drains for a few seconds after letting the lock go,
 *  and its wake is legitimately parented to it until it exits (then it is adopted, no bridge above).
 *  Returns what it stopped. Primary only. */
let suspect: string | undefined;
export async function evictForeignWake(cfg: OrcaConfig, reconcile: () => Promise<unknown>, table?: procs.ProcRow[]): Promise<{ bridge: number; run: number; runId: string } | undefined> {
  if (!primary.held()) return undefined;
  const l = lease.current(dir());
  if (!l || !lease.pidAlive(l.pid)) return undefined;
  const claimant = procs.bridgeAncestor(l.pid, table ?? await procs.processTable());
  if (!claimant || claimant.pid === process.pid) { suspect = undefined; return undefined; }
  const seen = `${claimant.pid}:${l.pid}:${l.runId}`;
  if (suspect !== seen) {
    suspect = seen;
    console.warn(`orca: the orchestrator's wake (pid ${l.pid}) was launched by another bridge (pid ${claimant.pid}) — stopping both if it still is at the next check`);
    return undefined;
  }
  suspect = undefined;
  console.error(`orca: another bridge (pid ${claimant.pid}: ${claimant.command.slice(0, 120)}) launched the orchestrator's wake (pid ${l.pid}, run ${l.runId}) — only this instance's primary may; stopping both`);
  for (const pid of [claimant.pid, l.pid]) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  void recover(cfg, reconcile, { runId: l.runId }).catch(db.logUnlessDown("orca: orchestrator recovery failed"));
  return { bridge: claimant.pid, run: l.pid, runId: l.runId };
}

/** After its own run: everything that queued up meanwhile becomes ONE wake, not one each. */
/** Any of its workers still running, other than `except`? The batch is not done while one is. */
async function workersRunning(cfg: OrcaConfig, except?: string): Promise<boolean> {
  return (await board(cfg)).some((r) => r.orchestrated && r.agent === "running" && r.worktreePath !== except);
}

async function drain(cfg: OrcaConfig): Promise<void> {
  const pending = await db.queuedMessages(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH);
  if (!pending.length || agent.isRunning(dir())) return;
  const wakes = (await blob()).wakes ?? 0;
  const human = pending.some((m) => !isWorkerEvent(m.instruction));
  if (!human && wakes >= MAX_WAKES) return; // paused
  // The same rule as for a fresh report: clean reports that piled up while it worked wait for the
  // batch too. Without this, its own exit re-delivered them one wake at a time — every report
  // still interrupted it, just a turn later.
  if (onlyCleanReports(pending.map((m) => m.instruction)) && await workersRunning(cfg)) return;
  await patch({ wakes: human ? 0 : wakes + 1 });
  await wake(cfg, [], pending[0]?.grant); // the oldest message's grant group; the rest wait for the next drain
}

async function wake(cfg: OrcaConfig, fresh: string[], grant?: Grant): Promise<void> {
  // Only the instance's primary bridge wakes it (server/primary.ts); a secondary leaves the queue alone.
  if (!primary.held()) {
    for (const text of fresh) await enqueue(text, [], grant).catch(() => {});
    throw new Error("not the primary bridge: the orchestrator is woken by the instance's primary");
  }
  // One grant per wake (§3.7): claim only the queued messages of this wake's grant.
  const only = grantKey(grant);
  const claimed: db.QueuedMessage[] = [];
  for (let m = await db.claimQueuedMessage(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, only); m; m = await db.claimQueuedMessage(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, only)) claimed.push(m);
  const messages = [...claimed.map((m) => withAttachments(m.instruction, m.attachments)), ...fresh];
  if (!messages.length) return;
  try {
    const b = await blob();
    const next = continuation({
      provider: "claude", from: b.sessionId ? "claude" : undefined, sessionId: b.sessionId, contextPct: b.contextPct,
      transcript: await db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH),
    });
    // The full terminal toolset unless opted out — and never for an outside sender's wake: there the
    // `orca` command (checked against the grant server-side) is the only way to act.
    const shell = cfg.orchestratorShell !== false && !grant;
    await patch({ wakeGrant: grant ?? null }); // before the launch: its first `orca` call is checked
    const prompt = orchestratorPrompt({ fresh: !next.resume, notes: b.notes, board: boardText(await board(cfg)), messages, shell, cutOff: b.cutOff, cutOffProgress: b.cutOffProgress });
    const receipt = await agent.launch(dir(), dir(), prompt, {
      ...next, provider: "claude", repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH,
      instruction: joinMessages(messages), action: "orchestrate", queue: false,
      // Anything you said makes it yours; worker reports alone are the agents' (folded in the chat).
      source: turnSource(messages),
      model: modelOf(cfg, b), maxBudgetUsd: budgetOf(cfg),
      timeoutMs: cfg.agentTimeoutMinutes ? cfg.agentTimeoutMinutes * 60_000 : undefined,
      // Everything Claude Code has in a terminal (bypassPermissions), as the user asked: a manager
      // who can find things out, run things and fix the machine. `orchestratorShell: false` keeps
      // it to `orca`, reading, the web and read-only subagents — nothing that can change this machine.
      ...(shell ? { permissionMode: "bypass" as const } : { permissionMode: "ask" as const, allowedTools: ["Bash(orca *)", "Read", "Grep", "Glob", "Agent", "WebSearch", "WebFetch"] }),
      env: {
        // The main install's `orca` and this — the primary — bridge on loopback (always bound), never
        // a worktree's bin/ that may be deleted under it (incident 2026-10-14).
        ORCA_URL: `http://127.0.0.1:${API_PORT}`,
        PATH: `${primary.mainBin()}:${process.env.PATH ?? ""}`,
      },
    });
    await patch({ sessionId: receipt.sessionId, handling: { runId: receipt.runId, instance: db.instanceName(), messages }, cutOff: null, cutOffProgress: null });
  } catch (e) {
    // The messages were claimed off the queue; a launch that never happened must not eat them.
    for (const m of claimed) await enqueue(m.instruction, m.attachments, m.grant).catch(() => {});
    for (const text of fresh) await enqueue(text, [], grant).catch(() => {});
    await patch({ wakeGrant: null }).catch(() => {});
    throw e;
  }
}

/** Every workstream on this instance, as the orchestrator reads it.
 *  ponytail: `last` and `check` come from the in-memory run state, so they are blank for a run that
 *  finished before a bridge restart — `orca read` still has it. Join the turn table if that bites. */
export async function board(cfg: OrcaConfig): Promise<BoardRow[]> {
  const rows: BoardRow[] = [];
  const here = db.instanceName();
  const several = Object.keys(cfg.instances ?? {}).length > 0;
  for (const repo of cfg.repos) {
    const local = verbs.repoHere(repo);
    const [worktrees, prs, merged, enrichment, inventory, queued] = await Promise.all([
      local ? git.listWorktrees(repo.repoPath, repo.worktreeRoot).catch(() => []) : Promise.resolve([]),
      local ? gh.listPrs(repo.repoPath).catch(() => []) : Promise.resolve([]), // a local-only repo has no PRs
      local ? gh.listMerged(repo.repoPath).catch(() => []) : Promise.resolve([]),
      db.enrichment(repo.name),
      db.inventory(repo.name).catch(() => []),
      db.queuedCounts(repo.name).catch(() => new Map<string, number>()),
    ]);
    const paths = new Map(worktrees.map((w) => [w.branch, w.worktreePath]));
    const heads = new Map(worktrees.map((w) => [w.branch, w.head]));
    // Other instances' worktrees, as they last published them (newest sighting per branch).
    const elsewhere = new Map<string, { instance: string; data: db.Fields }>();
    for (const r of inventory) if (r.instance !== here && !paths.has(r.branch) && !elsewhere.has(r.branch)) elsewhere.set(r.branch, { instance: r.instance, data: r.data });
    for (const branch of new Set([...paths.keys(), ...elsewhere.keys(), ...prs.map((p) => p.branch)])) {
      const worktreePath = paths.get(branch);
      const remote = elsewhere.get(branch);
      const pr = prs.find((p) => p.branch === branch);
      const run = worktreePath ? agent.status(worktreePath) : undefined;
      const e = enrichment[branch] ?? {};
      const agentState = worktreePath ? (agent.isRunning(worktreePath) ? "running" : run?.status ?? "idle") : ((remote?.data.agentStatus as string | undefined) ?? "idle");
      const head = heads.get(branch) ?? (remote?.data.head as string | undefined);
      const mergedPr = merged.find((m) => m.branch === branch);
      // The web board's derivation (mergedPrIsHistory): a merged PR stands only while nothing has
      // happened on the branch since — a reused branch reads as its live state, not "merged". A
      // worktree that is merely BEHIND the PR's last head (never fetched a push from elsewhere) is
      // not reuse; `git.isAncestor` is only possible when the worktree is on this instance.
      const headBehindPr = local && worktreePath && head && mergedPr?.headSha && head !== mergedPr.headSha
        ? await git.isAncestor(repo.repoPath, head, mergedPr.headSha, branch) : undefined;
      const activity = {
        agentStatus: agentState, queued: queued.get(branch) ?? 0, openPr: Boolean(pr),
        agentStartedAt: run?.startedAt ?? (remote?.data.agentStartedAt as number | undefined),
        head, headBehindPr,
      };
      const done = mergedPr && !mergedPrIsHistory(mergedPr, activity) ? mergedPr : undefined;
      rows.push({
        repo: repo.name, branch, title: pr?.title ?? (e.title as string | undefined), worktreePath: worktreePath ?? (remote?.data.worktreePath as string | undefined),
        agent: agentState,
        pr: pr ? { number: pr.number, isDraft: pr.isDraft, reviewStatus: pr.reviewStatus, ciStatus: pr.ciStatus, mergeable: pr.mergeable } : done && { number: done.number, merged: true },
        check: run?.check?.ok ?? ((remote?.data.agentCheck as { ok?: boolean } | undefined)?.ok), orchestrated: Boolean(e.orchestrated),
        last: run?.structured?.outcome ?? run?.error ?? ((remote?.data.agentOutcome as { outcome?: string } | undefined)?.outcome),
        instance: several ? (remote?.instance ?? (worktreePath ? here : undefined)) : undefined,
        status: e.orchStatus as OrchStatus | undefined,
      });
    }
  }
  return rows;
}

/** Call one of this bridge's own verb routes on another instance (the orchestrator lives on one
 *  machine; a workstream may live on another). The body names the repo and branch, so the far
 *  instance's own placement forwarding would even bounce it on again if it had moved. */
export async function viaInstance(cfg: OrcaConfig, instance: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = cfg.instances?.[instance];
  if (!base) throw new Error(`"${instance}" is not a configured instance (instances: ${Object.keys(cfg.instances ?? {}).join(", ") || "none"})`);
  const res = await fetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `${instance} answered ${res.status}`));
  return data;
}

// ---- the `orca` command ----

const when = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const answer = (t: AgentTurn) => t.structured?.outcome || t.response || (t.finishedAt ? "(no output)" : "(still running)");
const turnStatus = (t: AgentTurn) => (!t.finishedAt ? "running" : t.failed ? "failed" : t.stopped ? "stopped" : "done");

function repoNamed(cfg: OrcaConfig, name: unknown): RepoConfig {
  const repo = cfg.repos.find((r) => r.name === name);
  if (!repo) throw new Error(`--repo must be one of: ${cfg.repos.map((r) => r.name).join(", ")}`);
  return repo; // a repo may live on any instance; each verb finds the workstream's home (viaInstance)
}
const required = (args: ToolArgs, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`--${key} is required`);
  return v.trim();
};

export type ToolArgs = Record<string, unknown> & { _?: string[] };

/** `--attach` (repeatable) as stored references, ready for `withAttachments` — they ride the brief or
 *  message to the worker's instance, which materialises them at launch like any other attachment. */
async function attachArgs(args: ToolArgs): Promise<string[]> {
  const raw = args.attach === undefined ? [] : Array.isArray(args.attach) ? args.attach : [args.attach];
  const refs: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v.trim()) throw new Error("--attach needs a value: an attachment id from ## Attachments, or a file path");
    refs.push(await attachments.forward(v));
  }
  return refs;
}

/** Run one `orca <verb>` and return what it prints. Throws with a message the model can act on. */
export async function tool(cfg: OrcaConfig, verb: string, args: ToolArgs = {}): Promise<string> {
  // The grant check (§3.7): a wake an outside sender caused may only use the verbs its grant allows.
  // Server-side, so no prompt can talk its way past it.
  const refusal = grantRefusal((await blob()).wakeGrant ?? undefined, verb, args);
  if (refusal) throw new Error(refusal);
  const words = args._ ?? [];
  switch (verb) {
    case "board": return boardText(await board(cfg));
    case "spawn": {
      const repo = repoNamed(cfg, args.repo);
      const brief = { objective: args.objective, output: args.output, boundaries: args.boundaries, context: args.context } as Record<string, string | undefined>;
      const problems = briefProblems(brief);
      if (problems.length) throw new Error(`${problems.join("; ")}. A worker knows only its brief.`);
      // Required, not defaulted: left out, every worker got the config default — the biggest model.
      if (typeof args.model !== "string" || !providerOfModel(args.model)) {
        throw new Error(`--model is required (${args.model ? `"${args.model}" is not a model` : "choose from the ladder"}): ${MODEL_LADDER.map((m) => m.id).join(", ")}`);
      }
      const on = typeof args.on === "string" && args.on ? args.on : (repo.runsOn ?? db.instanceName());
      const title = typeof args.title === "string" ? args.title : undefined;
      const prompt = withAttachments(workerBrief(brief), await attachArgs(args));
      if (on !== db.instanceName()) {
        const ws = await viaInstance(cfg, on, "/api/workstreams/spawn", { repo: repo.name, prompt, title, model: args.model });
        return `Spawned ${repo.name}/${ws.branch} "${ws.title}" on ${on}. End your turn; you are woken when it finishes.`;
      }
      const ws = await verbs.createWorkstream(cfg, repo, { prompt, title, model: String(args.model), fields: { orchestrated: true } });
      return `Spawned ${repo.name}/${ws.branch} "${ws.title}"${cfg.instances ? ` on ${on}` : ""}. End your turn; you are woken when it finishes.`;
    }
    case "send": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const typed = words.join(" ").trim();
      if (!typed) throw new Error('the message is required: orca send --repo <repo> --branch <branch> "<message>"');
      const text = withAttachments(typed, await attachArgs(args));
      // A new pin is read by followUp, so the move happens on this message (the ladder decides
      // resume vs handoff from the pinned provider as it does for the card's own picker).
      if (typeof args.model === "string") {
        const provider = providerOfModel(args.model);
        if (!provider) throw new Error(`unknown model "${args.model}"`);
        await db.patchEnrichment(repo.name, branch, { preferredModel: args.model, preferredProvider: provider });
      }
      const home = await verbs.placement(repo, { branch });
      const { status } = home !== db.instanceName()
        ? (await viaInstance(cfg, home, "/api/workstreams/followup", { repo: repo.name, branch, instruction: text }) as { status: string })
        : await verbs.followUp(cfg, repo, branch, { instruction: text });
      await db.patchEnrichment(repo.name, branch, { orchestrated: true }); // now yours to hear back from
      return status === "queued" ? "Queued behind the run in flight; it is sent when that finishes." : `Sent to ${repo.name}/${branch}. End your turn; you are woken when it finishes.`;
    }
    case "address": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const home = await verbs.placement(repo, { branch });
      const { status, pr } = home !== db.instanceName()
        ? (await viaInstance(cfg, home, "/api/workstreams/address", { repo: repo.name, branch }) as { status: string; pr: number })
        : await verbs.addressPr(cfg, repo, branch);
      await db.patchEnrichment(repo.name, branch, { orchestrated: true });
      if (status === "resolved") return `#${pr}'s only conflict was in its changelog: Orca merged the base, kept both sides' entries and pushed. Nothing else needed an agent, so none was started.`;
      return `${status === "queued" ? "Queued" : "Started"} Address PR for #${pr}. End your turn; you are woken when it finishes.`;
    }
    case "pr-shots": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const body = { repo: repo.name, branch, ...(args.pr ? { pr: Number(args.pr) } : {}) };
      const home = await verbs.placement(repo, { branch });
      const r = (home !== db.instanceName()
        ? await viaInstance(cfg, home, "/api/prs/shots", body)
        : await prShots.attachPrShots(repo, branch, { pr: body.pr })) as prShots.PrShotsResult;
      if (!r.shots) return `No screenshots on ${repo.name}/${branch} to show (${r.why ?? "none reported"}).`;
      return r.updated ? `PR #${r.pr}'s Screenshots section now shows the ${r.shots} newest (hosted on ${r.ref}).` : `PR #${r.pr}'s Screenshots section is ${r.why ?? "unchanged"}.`;
    }
    case "move": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const to = required(args, "to");
      const home = await verbs.placement(repo, { branch });
      const r = home !== db.instanceName()
        ? (await viaInstance(cfg, home, "/api/workstreams/move", { repo: repo.name, branch, to }) as { instance: string })
        : await verbs.moveWorkstream(cfg, repo, branch, to);
      return `Moved ${repo.name}/${branch} to ${r.instance}. Its next run starts a new session there from the portable transcript.`;
    }
    case "archive": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const e = (await db.enrichment(repo.name))[branch];
      if (!e?.orchestrated) throw new Error(`${repo.name}/${branch} is not an orchestrated workstream; this command only archives ones this orchestrator spawned or sent to`);
      // The worktree is removed where it lives: a laptop's worktree by the laptop.
      const home = await verbs.placement(repo, { branch });
      if (home !== db.instanceName()) await viaInstance(cfg, home, "/api/workstreams/archive", { repo: repo.name, branch });
      else await verbs.archiveWorkstream(repo, branch);
      return `Archived ${repo.name}/${branch}. Its branch, commits and transcript stay readable with \`orca chats\` / \`orca read\`.`;
    }
    case "stop": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const e = (await db.enrichment(repo.name))[branch];
      if (!e?.orchestrated) throw new Error(`${repo.name}/${branch} is not an orchestrated workstream; this command only stops ones this orchestrator spawned or sent to`);
      const dropQueue = "drop-queue" in args;
      const home = await verbs.placement(repo, { branch });
      const r = home !== db.instanceName()
        ? (await viaInstance(cfg, home, "/api/workstreams/stop", { repo: repo.name, branch, dropQueue }) as { runId?: string })
        : await verbs.stopWorkstream(repo, branch, { dropQueue });
      if (!r.runId) return `Nothing running on ${repo.name}/${branch}.`;
      return `Stopped ${repo.name}/${branch} (run ${r.runId}).${dropQueue ? " Its queued messages were dropped." : " Its worktree, commits, queue and session stay; `orca send` resumes it."}`;
    }
    case "sweep": {
      // Finished worktrees, dead previews and orphan branches on every instance. Dry run unless --confirm.
      return sweepText(await verbs.sweepAll(cfg, { confirm: "confirm" in args }));
    }
    case "preview": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      if (!featuresOf(repo).previews || !repo.previewServices.length) throw new Error(`Previews are not enabled for ${repo.name}; the user turns them on in the repo's config`);
      const at = `--repo ${repo.name} --branch ${branch}`;
      if ("push-to-template" in args) {
        // Read-only lookup, like --status: pushing needs an existing preview, never a new checkout.
        const key = (await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).find((w) => w.branch === branch)?.worktreePath;
        if (!key) throw new Error(`No worktree for ${repo.name}/${branch}, so no preview to push`);
        const envFile = repo.copyToWorktree?.find((f) => /(^|\/)\.env$/.test(f));
        if (!envFile) throw new Error(`${repo.name} copies no .env file into its worktrees (copyToWorktree), so there is no source env to push to`);
        return pushToTemplate({ worktree: key, repoPath: repo.repoPath, envFile, confirm: "confirm" in args, backupDir: join(stateDir(), "env-backups") });
      }
      if ("status" in args) {
        // Read-only: look the worktree up rather than `ensureWorktree`, which would check one out.
        const key = (await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).find((w) => w.branch === branch)?.worktreePath;
        const svcs = key ? await preview.status(key) : [];
        if (!key || !svcs.length) return `No preview for ${repo.name}/${branch}. Start one: orca preview ${at}`;
        const state = (s: preview.SvcStatus) => (!s.running ? "failed" : s.ready ? `running ${s.url}` : "starting");
        const overall = svcs.some((s) => !s.running) ? "failed" : svcs.every((s) => s.ready) ? "running" : "starting";
        return [
          `Preview ${repo.name}/${branch}: ${overall}`,
          ...svcs.map((s) => `  ${s.name}: ${state(s)}`),
          ...(await preview.logs(key)).flatMap((l) => ["", `--- ${l.name} log (tail) ---`, l.log || "(empty)"]),
        ].join("\n");
      }
      const key = await verbs.ensureWorktree(repo, branch);
      const svcs = await verbs.startPreview(cfg, repo, key, key, branch);
      return `Starting the preview for ${repo.name}/${branch}: ${svcs.map((s) => `${s.name} ${s.url}`).join(", ")}. It takes a minute or more to boot and nothing wakes you when it is up: check with \`orca preview ${at} --status\`.`;
    }
    case "chats": {
      const query = words.join(" ").trim();
      if (!query) {
        const all = (await db.conversations()).filter((c) => c.repo !== ORCHESTRATOR_REPO);
        return all.map((c) => `#${c.id} ${c.repo}/${c.branch}${c.title ? ` "${c.title}"` : ""}${c.archived ? " [archived]" : ""} — ${c.turns} turn${c.turns === 1 ? "" : "s"}, last ${when(c.lastAt)}`).join("\n") || "(no conversations yet)";
      }
      const hits = (await db.searchTurns(query)).filter((h) => h.repo !== ORCHESTRATOR_REPO);
      return hits.map((h) => [
        `#${h.id} ${h.repo}/${h.branch}${h.archived ? " [archived]" : ""} — run ${h.runId} (${when(h.turn.startedAt)})`,
        `  ❯ ${clip(h.turn.instruction ?? "", 200)}`,
        `  → ${clip(answer(h.turn).replace(/\s+/g, " "), 300)}`,
      ].join("\n")).join("\n") || `No past turn matches "${query}".`;
    }
    case "read": {
      if (typeof args.run === "string") {
        const t = await db.turn(args.run);
        if (!t) throw new Error(`no turn with run id ${args.run}`);
        const activity = activityLines(await agent.runSteps(t.id).catch(() => []));
        return [
          `run ${t.id} — ${turnStatus(t)} (${when(t.startedAt)})`,
          `❯ ${t.instruction ?? clip(t.prompt, 2000)}`,
          ...(activity.length ? ["", "Activity:", ...activity.map((a) => `- ${a}`)] : []),
          "", clip(t.response || "(no output)", 12_000),
          ...(t.check ? ["", `Orca's check \`${t.check.command}\` ${t.check.ok ? "passed" : `FAILED (exit ${t.check.exitCode}):\n${clip(t.check.output, 2000)}`}`] : []),
        ].join("\n");
      }
      const id = Number(args.chat);
      if (!id) throw new Error("read needs --chat <id> (from `orca chats`) or --run <runId>");
      const turns = await db.conversationTurns(id);
      return turns.map((t) => `run ${t.id} — ${turnStatus(t)} (${when(t.startedAt)})\n❯ ${clip(t.instruction ?? "", 500)}\n→ ${clip(answer(t), 1200)}`).join("\n\n") || `No conversation #${id}.`;
    }
    case "merge": return mergeVerb(cfg, args);
    case "status": {
      // Enrichment is in the shared database, so any instance can write it — no forwarding.
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const prev = (await db.enrichment(repo.name))[branch]?.orchStatus as OrchStatus | undefined;
      const next = orchStatusUpdate(prev, args, new Date().toISOString());
      if (next === undefined) return orchStatusText(prev) || `(no status for ${repo.name}/${branch})`;
      await db.patchEnrichment(repo.name, branch, { orchStatus: next });
      return next ? `Status of ${repo.name}/${branch}: ${orchStatusText(next)}` : `Cleared the status of ${repo.name}/${branch}.`;
    }
    case "repo": {
      const [sub, target] = words;
      if (sub === "list") {
        const user = typeof args.user === "string" && args.user ? args.user : undefined;
        const have = await Promise.all(cfg.repos.map((r) => git.remoteNameWithOwner(r.repoPath).catch(() => "")));
        return repos.listText(cfg, await repos.list(cfg, user), have.filter(Boolean));
      }
      if (sub === "add") {
        if (!target) throw new Error("orca repo add <owner/name> [--on <instance>] [--name <slug>]");
        const on = typeof args.on === "string" && args.on ? args.on : db.instanceName();
        const name = typeof args.name === "string" && args.name ? args.name : undefined;
        const repo = on !== db.instanceName()
          ? (await viaInstance(cfg, on, "/api/repos/add", { nameWithOwner: target, name })) as unknown as RepoConfig
          : await repos.add(cfg, target, { name });
        return `Added ${target} to Orca as "${repo.name}" on ${on}: ${repo.repoPath}, base ${repo.baseBranch}${repo.githubUser ? `, gh account ${repo.githubUser}` : ""}. No previews or check command yet — the user sets those in Settings. It is on the board now; spawn on it with --repo ${repo.name}.`;
      }
      throw new Error("orca repo list [--user <login>] | orca repo add <owner/name> [--on <instance>] [--name <slug>]");
    }
    case "notes": {
      if (words[0] !== "set") return (await blob()).notes || "(empty)";
      const text = words.slice(1).join(" ").trim();
      if (text.length > NOTES_MAX) throw new Error(`notes are limited to ${NOTES_MAX} characters (got ${text.length}); condense them`);
      await patch({ notes: text });
      return "Notes saved.";
    }
    default: throw new Error(`unknown command "${verb}". Commands: board, spawn, send, address, archive, stop [--drop-queue], sweep [--confirm], merge --when-green, preview [--status | --push-to-template [--confirm]], status, chats, read, notes`);
  }
}

/** `orca merge --repo r (--pr N | --branch b) --when-green [--small]` (or `--cancel`): the merge
 *  queue, never a direct merge — Orca merges on green under the repo's mergePolicy. Runs where the
 *  repo is checked out (its `runsOn` when that is not here). */
async function mergeVerb(cfg: OrcaConfig, args: ToolArgs): Promise<string> {
  const repo = repoNamed(cfg, args.repo);
  const pr = args.pr === undefined ? undefined : Number(args.pr);
  if (pr !== undefined && !(pr > 0)) throw new Error("--pr must be a PR number");
  const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined;
  if (!pr && !branch) throw new Error("merge needs --pr <number> or --branch <branch>");
  const cancel = "cancel" in args;
  if (!cancel && !("when-green" in args)) throw new Error("orca merge only queues: add --when-green (Orca squash-merges once checks pass and it merges clean), or --cancel");
  const body = { repo: repo.name, pr, branch, small: "small" in args, by: "orchestrator", cancel };
  if (!verbs.repoHere(repo) && repo.runsOn && repo.runsOn !== db.instanceName()) {
    return String((await viaInstance(cfg, repo.runsOn, "/api/prs/merge-when-green", body)).text ?? "");
  }
  return mergeWhenGreen(cfg, repo, body);
}

/** The body of `orca merge` and of the PR menu's route (index.ts). */
export async function mergeWhenGreen(cfg: OrcaConfig, repo: RepoConfig, body: { pr?: number; branch?: string; small?: boolean; by?: string; cancel?: boolean }): Promise<string> {
  const by = body.by === "orchestrator" ? "orchestrator" as const : "user" as const;
  if (body.cancel) {
    const branch = body.branch ?? (body.pr ? (await gh.prMergeGate(repo.repoPath, body.pr)).branch : undefined);
    if (!branch) throw new Error("cancel needs --pr or --branch");
    await mergeQueue.cancel(repo, branch);
    return `Unmarked ${repo.name}/${branch}: it is no longer merged on green.`;
  }
  return mergeQueue.request(cfg, repo, { pr: body.pr, branch: body.branch }, { small: body.small, by });
}
