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
import * as git from "./git";
import * as gh from "./gh";
import * as verbs from "./verbs";
import * as preview from "./preview";
import { stateDir } from "./state";
import { API_PORT } from "./ports";
import { featuresOf, runsHere, type OrcaConfig, type RepoConfig } from "./config";
import {
  MODEL_LADDER, NO_REPLY_PLACEHOLDER, ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, boardText, briefProblems, continuation, isWorkerEvent, isWorkerProblem, onlyCleanReports,
  orchestratorPrompt, sessionHint, wakeExitReason, wakeStoppedLine, withAttachments, workerBrief, workerEvent,
  type BoardRow, type WakeExit,
} from "../web/src/workstream";
import { activityLines, type AgentTurn } from "../shared/agent";
import { providerOfModel } from "../shared/models";

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
const enqueue = (instruction: string, attachments: string[] = []) =>
  db.queueMessage({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, worktreePath: dir(), instruction, attachments, provider: "claude" });

// Deliveries are serialised: two workers finishing in the same tick would otherwise both see an idle
// orchestrator, both launch, and the loser's message would be lost to "already running".
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

export async function status(cfg: OrcaConfig): Promise<{ key: string; running: boolean; paused: boolean; notes: string; model: string; contextPct?: number; shell: boolean; lastWakeUsd?: number; hint?: string }> {
  const b = await blob();
  return {
    key: dir(), running: agent.isRunning(dir()), paused: (b.wakes ?? 0) >= MAX_WAKES, notes: b.notes ?? "",
    model: modelOf(cfg, b),
    contextPct: b.contextPct, // how full its last run left the session; absent until one has reported
    shell: cfg.orchestratorShell === true,
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

/** Something you typed. Resets the wake count — a person is in the loop again. */
export function message(cfg: OrcaConfig, text: string, attachments: string[] = []): Promise<{ status: "running" | "queued" }> {
  return serial(async () => {
    await patch({ wakes: 0 });
    if (agent.isRunning(dir())) {
      await enqueue(text, attachments);
      return { status: "queued" as const };
    }
    try {
      await wake(cfg, [withAttachments(text, attachments)]);
    } catch (e) {
      // The launcher's own guard caught a run this process can't see (its session is still busy
      // under a lease): wake() has put the message back on the queue, where the drain finds it.
      if (e instanceof Error && /already running/.test(e.message)) return { status: "queued" as const };
      throw e;
    }
    return { status: "running" as const };
  });
}

/** The run-finished hook (wired in index.ts). A worker the orchestrator is responsible for going
 *  idle wakes it with the outcome; its own run ending drains whatever arrived meanwhile. */
export async function onRunFinished(cfg: OrcaConfig, run: agent.RunFinished): Promise<void> {
  const { repo, branch } = run.options;
  if (!repo || !branch) return;
  if (repo === ORCHESTRATOR_REPO) {
    const exit = wakeExit(cfg, run);
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
      else if ((await blob()).handling?.runId === run.runId) await patch({ handling: null, died: null });
      await drain(cfg);
    });
    return;
  }
  const e = (await db.enrichment(repo))[branch] ?? {};
  if (!e.orchestrated) return;
  // Codex and Cursor reveal their session id mid-run, and no browser may be open to record it.
  if (run.sessionId && e.sessionId !== run.sessionId) await db.patchEnrichment(repo, branch, { sessionId: run.sessionId });
  if (run.continued) return; // a queued follow-up (an autofix) took over — not idle yet
  const text = workerEvent({
    repo, branch, title: e.title as string | undefined, runId: run.runId, status: run.status,
    outcome: run.structured, response: run.result, check: run.check,
  });
  // Management by exception. A manager is interrupted for a problem, not for every completion: a
  // worker that failed, was stopped, or whose commit failed Orca's check wakes the orchestrator now.
  // A clean finish is queued and delivered when the batch is done — the last of its running
  // workers finishing — or when the user next speaks, whichever is first; in between, the board
  // and `orca read` are there whenever it wants to check in.
  const exception = isWorkerProblem(text);
  await serial(async () => {
    const wakes = (await blob()).wakes ?? 0;
    const othersRunning = !exception && await workersRunning(cfg, run.key);
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
  for (const m of retry) await enqueue(m);
  const reason = wakeExitReason(exit);
  const toolCalls = (await agent.runSteps(runId).catch(() => [])).filter((s) => s.kind === "tool" && s.name !== "result").length;
  await agent.flushHistory(); // the exit handler's own finish write lands first, or it would overwrite the line
  await db.failTurn(runId, wakeStoppedLine({ reason, toolCalls, costUsd, retried: retry.length, dropped: messages.length - retry.length }));
  await patch({ handling: null, died: retry, cutOff: retry.length ? reason : null });
}

/** Startup: a wake that was in flight when the previous bridge stopped has nobody to report its
 *  exit. If it died with the bridge (a service manager kills the whole process group) its messages
 *  are re-queued like any other death; if it outlived the bridge and finished, the queue it left is
 *  drained. `reconcile` is index.ts's turn reconciliation, re-run once the wake is really gone. */
export async function recover(cfg: OrcaConfig, reconcile: () => Promise<unknown>): Promise<void> {
  const { handling } = await blob();
  if (!handling || handling.instance !== db.instanceName()) return; // none, or another instance's wake
  if (agent.isRunning(dir())) {
    // Still going under its lease, and its `orca` calls reach this bridge — let it finish, look again.
    setTimeout(() => void recover(cfg, reconcile).catch((e) => console.error("orca: orchestrator recovery failed", e)), RECOVER_POLL_MS).unref();
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
    if (finished) await patch({ handling: null, died: null });
    else await died(handling.runId, { kind: "restart" });
    await drain(cfg);
  });
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
  await wake(cfg, []);
}

async function wake(cfg: OrcaConfig, fresh: string[]): Promise<void> {
  const claimed: db.QueuedMessage[] = [];
  for (let m = await db.claimQueuedMessage(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH); m; m = await db.claimQueuedMessage(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH)) claimed.push(m);
  const messages = [...claimed.map((m) => withAttachments(m.instruction, m.attachments)), ...fresh];
  if (!messages.length) return;
  try {
    const b = await blob();
    const next = continuation({
      provider: "claude", from: b.sessionId ? "claude" : undefined, sessionId: b.sessionId, contextPct: b.contextPct,
      transcript: await db.turns(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH),
    });
    const shell = cfg.orchestratorShell === true;
    const prompt = orchestratorPrompt({ fresh: !next.resume, notes: b.notes, board: boardText(await board(cfg)), messages, shell, cutOff: b.cutOff });
    const receipt = await agent.launch(dir(), dir(), prompt, {
      ...next, provider: "claude", repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH,
      instruction: messages.join("\n\n"), action: "orchestrate", queue: false,
      model: modelOf(cfg, b), maxBudgetUsd: budgetOf(cfg),
      timeoutMs: cfg.agentTimeoutMinutes ? cfg.agentTimeoutMinutes * 60_000 : undefined,
      // By default NOT bypassPermissions: it may run `orca` and read files, and that is all. The
      // `orchestratorShell` setting trades that for a full shell on this machine.
      ...(shell ? { permissionMode: "bypass" as const } : { permissionMode: "ask" as const, allowedTools: ["Bash(orca *)", "Read", "Grep", "Glob"] }),
      env: {
        ORCA_URL: `http://${process.env.ORCA_BIND || "127.0.0.1"}:${API_PORT}`,
        PATH: `${new URL("../bin", import.meta.url).pathname}:${process.env.PATH ?? ""}`,
      },
    });
    await patch({ sessionId: receipt.sessionId, handling: { runId: receipt.runId, instance: db.instanceName(), messages }, cutOff: null });
  } catch (e) {
    // The messages were claimed off the queue; a launch that never happened must not eat them.
    for (const m of claimed) await enqueue(m.instruction, m.attachments).catch(() => {});
    for (const text of fresh) await enqueue(text).catch(() => {});
    throw e;
  }
}

/** Every workstream on this instance, as the orchestrator reads it.
 *  ponytail: `last` and `check` come from the in-memory run state, so they are blank for a run that
 *  finished before a bridge restart — `orca read` still has it. Join the turn table if that bites. */
export async function board(cfg: OrcaConfig): Promise<BoardRow[]> {
  const rows: BoardRow[] = [];
  for (const repo of cfg.repos.filter((r) => runsHere(r, db.instanceName()))) {
    const [worktrees, prs, enrichment] = await Promise.all([
      git.listWorktrees(repo.repoPath, repo.worktreeRoot).catch(() => []),
      gh.listPrs(repo.repoPath).catch(() => []), // a local-only repo has no PRs
      db.enrichment(repo.name),
    ]);
    const paths = new Map(worktrees.map((w) => [w.branch, w.worktreePath]));
    for (const branch of new Set([...paths.keys(), ...prs.map((p) => p.branch)])) {
      const worktreePath = paths.get(branch);
      const pr = prs.find((p) => p.branch === branch);
      const run = worktreePath ? agent.status(worktreePath) : undefined;
      const e = enrichment[branch] ?? {};
      rows.push({
        repo: repo.name, branch, title: pr?.title ?? (e.title as string | undefined), worktreePath,
        agent: worktreePath && agent.isRunning(worktreePath) ? "running" : run?.status ?? "idle",
        pr: pr && { number: pr.number, isDraft: pr.isDraft, reviewStatus: pr.reviewStatus, ciStatus: pr.ciStatus, mergeable: pr.mergeable },
        check: run?.check?.ok, orchestrated: Boolean(e.orchestrated),
        last: run?.structured?.outcome ?? run?.error,
      });
    }
  }
  return rows;
}

// ---- the `orca` command ----

const when = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const answer = (t: AgentTurn) => t.structured?.outcome || t.response || (t.finishedAt ? "(no output)" : "(still running)");
const turnStatus = (t: AgentTurn) => (!t.finishedAt ? "running" : t.failed ? "failed" : t.stopped ? "stopped" : "done");

function repoNamed(cfg: OrcaConfig, name: unknown): RepoConfig {
  const repo = cfg.repos.find((r) => r.name === name);
  if (!repo) throw new Error(`--repo must be one of: ${cfg.repos.map((r) => r.name).join(", ")}`);
  // ponytail: no forwarding — the orchestrator acts on the repos its own instance runs.
  if (!runsHere(repo, db.instanceName())) throw new Error(`${repo.name} runs on another instance (${repo.runsOn}); this orchestrator cannot act on it`);
  return repo;
}
const required = (args: ToolArgs, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`--${key} is required`);
  return v.trim();
};

export type ToolArgs = Record<string, unknown> & { _?: string[] };

/** Run one `orca <verb>` and return what it prints. Throws with a message the model can act on. */
export async function tool(cfg: OrcaConfig, verb: string, args: ToolArgs = {}): Promise<string> {
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
      const ws = await verbs.createWorkstream(cfg, repo, {
        prompt: workerBrief(brief), title: typeof args.title === "string" ? args.title : undefined,
        model: typeof args.model === "string" ? args.model : undefined, fields: { orchestrated: true },
      });
      return `Spawned ${repo.name}/${ws.branch} "${ws.title}". End your turn; you are woken when it finishes.`;
    }
    case "send": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const text = words.join(" ").trim();
      if (!text) throw new Error('the message is required: orca send --repo <repo> --branch <branch> "<message>"');
      // A new pin is read by followUp, so the move happens on this message (the ladder decides
      // resume vs handoff from the pinned provider as it does for the card's own picker).
      if (typeof args.model === "string") {
        const provider = providerOfModel(args.model);
        if (!provider) throw new Error(`unknown model "${args.model}"`);
        await db.patchEnrichment(repo.name, branch, { preferredModel: args.model, preferredProvider: provider });
      }
      const { status } = await verbs.followUp(cfg, repo, branch, { instruction: text });
      await db.patchEnrichment(repo.name, branch, { orchestrated: true }); // now yours to hear back from
      return status === "queued" ? "Queued behind the run in flight; it is sent when that finishes." : `Sent to ${repo.name}/${branch}. End your turn; you are woken when it finishes.`;
    }
    case "address": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const { status, pr } = await verbs.addressPr(cfg, repo, branch);
      await db.patchEnrichment(repo.name, branch, { orchestrated: true });
      return `${status === "queued" ? "Queued" : "Started"} Address PR for #${pr}. End your turn; you are woken when it finishes.`;
    }
    case "archive": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      const e = (await db.enrichment(repo.name))[branch];
      if (!e?.orchestrated) throw new Error(`${repo.name}/${branch} is not an orchestrated workstream; this command only archives ones this orchestrator spawned or sent to`);
      await verbs.archiveWorkstream(repo, branch);
      return `Archived ${repo.name}/${branch}. Its branch, commits and transcript stay readable with \`orca chats\` / \`orca read\`.`;
    }
    case "preview": {
      const repo = repoNamed(cfg, args.repo);
      const branch = required(args, "branch");
      if (!featuresOf(repo).previews || !repo.previewServices.length) throw new Error(`Previews are not enabled for ${repo.name}; the user turns them on in the repo's config`);
      const at = `--repo ${repo.name} --branch ${branch}`;
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
      const svcs = await verbs.startPreview(cfg, repo, key, key);
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
    case "notes": {
      if (words[0] !== "set") return (await blob()).notes || "(empty)";
      const text = words.slice(1).join(" ").trim();
      if (text.length > NOTES_MAX) throw new Error(`notes are limited to ${NOTES_MAX} characters (got ${text.length}); condense them`);
      await patch({ notes: text });
      return "Notes saved.";
    }
    default: throw new Error(`unknown command "${verb}". Commands: board, spawn, send, address, archive, preview, chats, read, notes`);
  }
}
