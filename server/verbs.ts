// The board's agent verbs, runnable by the bridge itself: create a workstream, follow up, Address PR.
//
// These lived only in the browser (web/src/store.ts), which was fine while a person clicking was the
// only thing that ever started a run. The orchestrator is a server-side caller, so the same verbs
// exist here, built from the SAME pure pieces — the prompts and the handover-ladder decision in
// web/src/workstream.ts — so the two callers cannot drift on what a run is told or which rung it
// takes. Only the I/O glue (worktree, enrichment, launch) is written twice.
// ponytail: the browser still runs its own copies of that glue (optimistic cards, Undo, Follow);
// point it at these when that duplication costs something.
import * as git from "./git";
import * as gh from "./gh";
import * as agent from "./agent";
import * as db from "./db";
import * as preview from "./preview";
import * as forward from "./forward";
import * as notify from "./notify";
import { existsSync } from "fs";
import { featuresOf, modelFor, providerAllowed, type OrcaConfig, type RepoConfig } from "./config";
import { addressNeedsAgent, addressPrPrompt, chatPrompt, cleanupDecision, continuation, launchPrompt, mergeSettled, slugifyBranch, titleFromPrompt, workerPrBody, type MechanicalMerge, type SweepReport } from "../web/src/workstream";
import { providerOfModel } from "../shared/models";
import { isAgentProvider, type AgentOutcome, type AgentProvider } from "../shared/agent";

/** The --model for a run: the card's pinned model, else the config's default — a Claude id, so it
 *  applies to Claude only (an unpinned Codex/Cursor run takes that CLI's own default). */
export const runModel = (cfg: OrcaConfig, repo: RepoConfig, provider: AgentProvider, pinned?: string): string | undefined =>
  pinned || (provider === "claude" ? modelFor(cfg, repo) : undefined);

/** The verification gate for a repo's runs: its check command, auto-fixing only where the repo has
 *  opted into follow automation (an unasked-for agent run is that feature's whole question). */
export const checkGate = (repo: RepoConfig): { command: string; autofix: boolean } | undefined =>
  repo.checkCommand ? { command: repo.checkCommand, autofix: featuresOf(repo).followAutomation } : undefined;

/** What every run in a repo is launched with, whoever asked for it. */
export const launchOptions = (cfg: OrcaConfig, repo: RepoConfig, provider: AgentProvider, pinned?: string): agent.LaunchOptions => ({
  provider, repo: repo.name,
  model: runModel(cfg, repo, provider, pinned),
  permissionMode: repo.agentPermissionMode ?? "ask",
  maxBudgetUsd: repo.agentMaxBudgetUsd, check: checkGate(repo),
  timeoutMs: cfg.agentTimeoutMinutes ? cfg.agentTimeoutMinutes * 60_000 : undefined,
  memoryMaxGb: repo.agentMemoryMaxGb, cpuWeight: cfg.agentCpuWeight,
});

/** A new branch + worktree for a titled piece of work, with the repo's local config copied in. The
 *  jitter suffix (à la Claude Code branch names) keeps names collision-resistant. */
export async function newWorktree(repo: RepoConfig, title: string): Promise<{ branch: string; worktreePath: string }> {
  const branch = `${slugifyBranch(title)}-${crypto.randomUUID().slice(0, 6)}`;
  const wt = await git.createWorktree(repo.repoPath, repo.worktreeRoot, branch, repo.baseBranch);
  await git.copyToWorktree(repo.repoPath, wt.worktreePath, repo.copyToWorktree);
  await git.linkToWorktree(repo.repoPath, wt.worktreePath, repo.linkToWorktree);
  return wt;
}

/** The branch's worktree, adopting one from the branch if there isn't one yet. */
export async function ensureWorktree(repo: RepoConfig, branch: string): Promise<string> {
  const existing = (await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).find((w) => w.branch === branch);
  if (existing) return existing.worktreePath;
  const wt = await git.adoptWorktree(repo.repoPath, repo.worktreeRoot, branch);
  await git.copyToWorktree(repo.repoPath, wt.worktreePath, repo.copyToWorktree);
  await git.linkToWorktree(repo.repoPath, wt.worktreePath, repo.linkToWorktree);
  return wt.worktreePath;
}

/** Start (or restart) a worktree's preview — the one path behind the board's "Test locally" and the
 *  orchestrator's `orca preview`. Returns once the services are spawned, not once they are up.
 *  With a `branch`, the placement is recorded in its enrichment (`previewInstance`) so every browser —
 *  after a refresh, on another device — finds the preview on the instance that runs it. */
export async function startPreview(cfg: OrcaConfig, repo: RepoConfig, key: string, worktree: string, branch?: string): Promise<preview.SvcStatus[]> {
  // Gitignored config (backend/.env) is only copied at worktree create/adopt, so a worktree made
  // before the config listed it boots without one and the preview dies on "Error: .env not found".
  // Re-copy what's missing here, leaving any worktree-local edit intact.
  await git.copyToWorktree(repo.repoPath, worktree, repo.copyToWorktree, { keepExisting: true });
  await preview.start(key, worktree, repo.previewServices, cfg.portRange);
  const host = preview.ownerHost(cfg.instances, db.instanceName());
  if (branch) {
    await db.patchEnrichment(repo.name, branch, { previewInstance: { instance: db.instanceName(), key, startedAt: new Date().toISOString() } })
      .catch((e) => console.error("orca: preview placement write failed", e)); // advisory — never fail the start
  }
  // Tell the centre when it comes up (with the URL) or doesn't — headed by the card's title.
  const title = branch ? (await db.enrichment(repo.name).catch(() => ({}) as Record<string, db.Fields>))[branch]?.title : undefined;
  void notify.watchPreview({ key, repo: repo.name, branch, title: typeof title === "string" && title ? title : branch ?? key, host });
  return preview.status(key, host);
}

/** A published preview older than this is a machine that stopped reporting (asleep, down): its
 *  previews are not shown as running. Several of the bridge's 10s publish ticks. */
export const PREVIEW_STALE_MS = 60_000;

export type PreviewRow = { key: string; instance: string; svcs: preview.SvcStatus[] };

/** Does the preview at `key` (a worktree path on THIS machine) belong to a repo that needs a secure
 *  context? Read on the owner, whose config paths match the key, and published with the row. */
function secureContextOf(cfg: OrcaConfig, key: string): boolean {
  return (cfg.repos ?? []).some((r) => r.previewSecureContext === true
    && (key === r.repoPath || (!!r.worktreeRoot && key.startsWith(`${r.worktreeRoot.replace(/\/+$/, "")}/`))));
}

/** Does a RELAYED preview (a key on another instance) need a secure context? The owner published
 *  the answer with its row — the viewer can't map the owner's path to a repo, and a status poll
 *  often names no repo at all, so `repoOf`'s fallback (the first repo in config) must never decide.
 *  The repo flag is the fallback only when nothing was published for the key. */
export function secureForRelay(rows: { key: string; data: { secureContext?: unknown } }[], key: string, repoFlag: boolean | undefined): boolean {
  const row = rows.find((r) => r.key === key);
  return row ? row.data.secureContext === true : repoFlag === true;
}

/** Every running preview on every instance — the running-previews menu's list. This instance's own
 *  are read live and published (so the others see them); the others' come from what they published.
 *  `loopback` = this bridge serves a page on localhost: then another instance's opened service is
 *  forwarded here and carries a `localUrl`, exactly as a relayed /api/preview status does — only for
 *  a repo with `previewSecureContext`; otherwise the owner's tailnet url alone. */
export async function previewRows(cfg: OrcaConfig, opts: { loopback: boolean; now?: number }): Promise<PreviewRow[]> {
  const self = db.instanceName();
  const mine = (await preview.list(preview.ownerHost(cfg.instances, self))).map((p) => ({ ...p, instance: self }));
  // Published without `localUrl`: that names THIS machine's loopback, meaningless to any other viewer.
  // `secureContext` rides along: the viewer can't map the owner's path back to a repo.
  await db.publishPreviews(mine.map((p) => ({ key: p.key, data: { svcs: p.svcs.map(({ localUrl: _, ...s }) => s), secureContext: secureContextOf(cfg, p.key) } })))
    .catch((e) => console.error("orca: preview publish failed", e)); // advisory — never fail the list
  const cutoff = (opts.now ?? Date.now()) - PREVIEW_STALE_MS;
  const others = (await db.previewInventory().catch(() => []))
    .filter((r) => r.instance !== self && r.seenAt >= cutoff)
    .map((r) => {
      const svcs = (r.data.svcs ?? []) as preview.SvcStatus[];
      const base = cfg.instances?.[r.instance];
      return { key: r.key, instance: r.instance, svcs: opts.loopback && base ? forward.localize(r.key, svcs, new URL(base).hostname, r.data.secureContext === true) : svcs };
    });
  return [...mine, ...others];
}

/** The agent a branch's next run uses: its pin (when the repo allows that provider), else whoever
 *  ran last, else Claude — the store's `providerFor`, read from enrichment. */
function providerFor(repo: RepoConfig, e: db.Fields): AgentProvider {
  const pinned = providerOfModel(e.preferredModel as string | undefined) ?? e.preferredProvider;
  if (isAgentProvider(pinned) && providerAllowed(repo, pinned)) return pinned;
  return isAgentProvider(e.agentProvider) ? e.agentProvider : "claude";
}

/** Create a workstream and launch its first run. `fields` are extra enrichment for the new card. */
export async function createWorkstream(
  cfg: OrcaConfig, repo: RepoConfig,
  input: { prompt: string; title?: string; model?: string; fields?: db.Fields },
): Promise<{ branch: string; worktreePath: string; title: string; runId: string }> {
  const model = input.model ?? modelFor(cfg, repo);
  const provider = providerOfModel(model) ?? "claude";
  if (!providerAllowed(repo, provider)) throw new Error(`the ${provider} agent is not enabled for ${repo.name}`);
  const title = input.title?.trim() || titleFromPrompt(input.prompt);
  const created = await newWorktree(repo, title);
  // The path as `git worktree list` reports it — the key every other caller tracks this run under.
  const wt = { branch: created.branch, worktreePath: await ensureWorktree(repo, created.branch) };
  await db.patchEnrichment(repo.name, wt.branch, {
    prompt: input.prompt, title, agentProvider: provider, preferredModel: model, createdAt: new Date().toISOString(), ...input.fields,
  });
  const receipt = await agent.runAgent(wt.worktreePath, launchPrompt({ title, branch: wt.branch, prompt: input.prompt }, repo.baseBranch), {
    ...launchOptions(cfg, repo, provider, model), branch: wt.branch, action: "launch", instruction: input.prompt,
  });
  await db.patchEnrichment(repo.name, wt.branch, { sessionId: receipt.sessionId });
  return { ...wt, title, runId: receipt.runId };
}

/** Send the next message to a branch's agent, continuing by the handover ladder. Queued instead when
 *  a run is in flight, exactly as a message typed in the chat is. `prompt` overrides the chat
 *  scaffolding for an action that builds its own (Address PR). */
export async function followUp(
  cfg: OrcaConfig, repo: RepoConfig, branch: string,
  input: { instruction: string; prompt?: string; action?: string; evidenceChars?: number },
): Promise<{ status: "running" | "queued"; worktreePath: string }> {
  const worktreePath = await ensureWorktree(repo, branch);
  const e = (await db.enrichment(repo.name))[branch] ?? {};
  const provider = providerFor(repo, e);
  if (agent.isRunning(worktreePath)) {
    await db.queueMessage({ repo: repo.name, branch, worktreePath, instruction: input.instruction, attachments: [], provider });
    return { status: "queued", worktreePath };
  }
  const next = continuation({
    provider, from: isAgentProvider(e.agentProvider) ? e.agentProvider : undefined,
    sessionId: e.sessionId as string | undefined,
    contextPct: agent.status(worktreePath).meta?.contextPct,
    transcript: await db.turns(repo.name, branch),
  });
  const receipt = await agent.runAgent(worktreePath, input.prompt ?? chatPrompt(input.instruction), {
    ...launchOptions(cfg, repo, provider, e.preferredModel as string | undefined), ...next,
    branch, action: input.action ?? "followup", instruction: input.instruction, evidenceChars: input.evidenceChars,
  });
  await db.patchEnrichment(repo.name, branch, { agentProvider: provider, sessionId: receipt.sessionId });
  return { status: "running", worktreePath };
}

/** Compact a branch's Claude session: `/compact` as the whole prompt, on a native resume of that
 *  session — exactly what typing it in the session does, through the same launch as a follow-up.
 *  Never the handover ladder: compaction is for the session that's filling up, which the ladder
 *  would otherwise swap for a fresh one at 80%. Refused mid-turn (one run per session). */
export async function compact(cfg: OrcaConfig, repo: RepoConfig, branch: string): Promise<{ runId: string }> {
  const e = (await db.enrichment(repo.name))[branch] ?? {};
  if (e.agentProvider !== "claude" || typeof e.sessionId !== "string") throw new Error("only a Claude session can be compacted");
  const worktreePath = await ensureWorktree(repo, branch);
  if (agent.isRunning(worktreePath)) throw new BusyError();
  const pinned = providerOfModel(e.preferredModel as string | undefined) === "claude" ? e.preferredModel as string : undefined;
  const { runId } = await agent.runAgent(worktreePath, "/compact", {
    ...launchOptions(cfg, repo, "claude", pinned), check: undefined,
    resume: e.sessionId, branch, action: "compact", instruction: "/compact",
  });
  return { runId };
}

/** A session is mid-turn: its run must finish before it can take another command. */
export class BusyError extends Error {
  constructor() { super("the agent is mid-turn — compact once it finishes"); }
}

/** Stop a worktree's agent and preview and remove it, deleting (and archiving) its branch when asked
 *  — the Discard button's body, also the route's own, so a second caller can't drift from it. Never
 *  deletes a branch with an open PR. */
export async function removeWorktree(repo: RepoConfig, worktreePath: string, branch: string | undefined, deleteBranch: boolean): Promise<void> {
  agent.stop(worktreePath);
  await agent.killInWorktree(worktreePath);
  preview.stop(worktreePath);
  await git.removeWorktree(repo.repoPath, worktreePath).catch(() => {});
  if (deleteBranch && branch) await git.deleteBranch(repo.repoPath, branch);
  if (deleteBranch && branch) await db.archive(repo.name, branch);
}

/** Archive a workstream: stop its agent, drop anything queued for it (so a queued message can't
 *  restart a cancelled worker), and reap its worktree — the `orca archive` behind cancelling a
 *  workstream from the orchestrator, built from the same `removeWorktree` the Discard button runs. */
export async function archiveWorkstream(repo: RepoConfig, branch: string): Promise<void> {
  await db.dropQueuedMessages(repo.name, branch); // before stopping, so a racing exit handler can't claim one
  const hasPr = (await gh.listPrs(repo.repoPath)).some((p) => p.branch === branch);
  const existing = (await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).find((w) => w.branch === branch);
  if (existing) await removeWorktree(repo, existing.worktreePath, branch, !hasPr); // no worktree, nothing can run in it
  await db.archive(repo.name, branch); // idempotent — a no-op if removeWorktree already archived it
}

/** Settle a branch's conflict with its base without an agent where no judgement is needed: Orca
 *  merges the base itself and, when the only conflicts are in the repo's changelog files, unions them
 *  and pushes (`git.mergeBaseUnioningChangelogs`). Every other outcome leaves the worktree untouched
 *  for the agent. Never while an agent runs in the worktree — it owns the tree. */
export async function settleConflict(repo: RepoConfig, branch: string): Promise<{ outcome: MechanicalMerge; files: string[] }> {
  const worktreePath = await ensureWorktree(repo, branch);
  if (agent.isRunning(worktreePath)) return { outcome: "busy", files: [] };
  const r = await git.mergeBaseUnioningChangelogs(worktreePath, repo.baseBranch, repo.changelogFiles);
  if (r.outcome === "resolved") console.log(`[conflict] ${repo.name}/${branch}: changelog-only conflict unioned and pushed (${r.files.join(", ")}) — no agent`);
  return r;
}

/** THE agent action for a PR — one run for conflicts, failing CI and the review, whichever apply —
 *  with the evidence fetched immediately before launch. The manual form of the store's `addressPr`:
 *  every unresolved thread is sent, and the hand-over is recorded once the launch is accepted. */
export async function addressPr(cfg: OrcaConfig, repo: RepoConfig, branch: string): Promise<{ status: "running" | "queued" | "resolved"; pr: number }> {
  const pr = (await gh.listPrs(repo.repoPath)).find((p) => p.branch === branch);
  if (!pr) throw new Error(`${repo.name}/${branch} has no open PR to address`);
  const e = (await db.enrichment(repo.name))[branch] ?? {};
  // A changelog-only (or clean) merge of the base is Orca's job, not a run's.
  const settled = pr.mergeable === "CONFLICTING" && mergeSettled((await settleConflict(repo, branch)).outcome);
  const conflicting = pr.mergeable === "CONFLICTING" && !settled;
  const ciFailing = pr.ciStatus === "failing";
  const [details, threads, comments] = await Promise.all([
    ciFailing ? gh.ciEvidence(repo.repoPath, pr.number).catch(() => []) : Promise.resolve([]),
    gh.reviewEvidence(repo.repoPath, pr.number).catch(() => []),
    gh.conversationComments(repo.repoPath, pr.number, e.commentsSeenAt as string | undefined).catch(() => []),
  ]);
  const handed = new Set((e.handedReviewThreadIds as string[] | undefined) ?? []);
  const marked = threads.map((thread) => ({ ...thread, alreadyHanded: handed.has(thread.id) }));
  const seenAt = new Date().toISOString();
  const ci = ciFailing ? { failingChecks: pr.failingChecks, details } : undefined;
  if (settled && !addressNeedsAgent({ conflicting, ci, feedback: pr.feedback, threads: marked, comments })) return { status: "resolved", pr: pr.number };
  const { status } = await followUp(cfg, repo, branch, {
    instruction: "Address the PR: conflicts, CI, review", action: "address",
    evidenceChars: JSON.stringify(details).length + JSON.stringify(marked).length + JSON.stringify(comments).length,
    prompt: addressPrPrompt({ prNumber: pr.number, branch }, {
      base: repo.baseBranch, conflicting, ci,
      feedback: pr.feedback, threads: marked, followed: false, comments,
    }),
  });
  const fields: db.Fields = {};
  if (threads.length) fields.handedReviewThreadIds = [...new Set([...handed, ...threads.map((thread) => thread.id)])].slice(-100);
  if (comments.length) fields.commentsSeenAt = seenAt;
  if (Object.keys(fields).length) await db.patchEnrichment(repo.name, branch, fields);
  return { status, pr: pr.number };
}

// ---- placement: which instance a request about a workstream belongs to ----

/** Is this repo checked out on this instance (so it can hold worktrees here)? */
export const repoHere = (repo: RepoConfig): boolean => existsSync(repo.repoPath);

/** The instance a request should run on. Explicit (`instance` in the body or query — the New-draft
 *  box's choice, the orchestrator's --on) beats the worktree's home (the instance whose inventory
 *  lists the branch or path — a workstream lives where its worktree is), which beats the repo's
 *  default (`runsOn`), which beats here. */
export async function placement(
  repo: RepoConfig,
  want: { instance?: unknown; branch?: unknown; worktreePath?: unknown; key?: unknown },
): Promise<string> {
  if (typeof want.instance === "string" && want.instance) return want.instance;
  const branch = typeof want.branch === "string" ? want.branch : undefined;
  const path = [want.worktreePath, want.key].find((v): v is string => typeof v === "string" && v.startsWith("/"));
  if (branch || path) {
    const rows = await db.inventory(repo.name).catch(() => []);
    const home = rows.find((r) => (branch && r.branch === branch) || (path && r.data.worktreePath === path));
    if (home) return home.instance;
  }
  return repo.runsOn ?? db.instanceName();
}

/** Open the PR for a finished worker's branch (the repo's `mergePolicy.autoPr`): title from the
 *  workstream, body from the worker's outcome and its commits, ready for review — not a draft, so the
 *  merge queue can take it. Nothing when the repo has no remote, the branch already has a PR, or it
 *  has no commits of its own. */
export async function openWorkerPr(repo: RepoConfig, branch: string, worktreePath: string, result: { outcome?: AgentOutcome; response?: string }): Promise<{ number: number; url: string } | undefined> {
  if (!(await git.hasRemote(repo.repoPath))) return undefined;
  if ((await gh.listPrs(repo.repoPath)).some((p) => p.branch === branch)) return undefined;
  const base = await git.resolveBase(repo.repoPath, repo.baseBranch);
  const { commits } = await git.changeSummary(worktreePath, base);
  if (!commits.length) return undefined;
  const e = (await db.enrichment(repo.name))[branch] ?? {};
  const title = (typeof e.title === "string" && e.title.trim()) || branch;
  await git.pushBranch(worktreePath, branch);
  const pr = await gh.createPr(worktreePath, {
    title, base: repo.baseBranch, head: branch,
    body: workerPrBody({ ...result, commits: commits.map((c) => c.subject).reverse() }), // changeSummary is newest-first
  });
  return pr;
}

/** Move a workstream's worktree from THIS instance to another. The branch goes up to origin, the
 *  worktree here is removed (the branch is kept), the target adopts the branch over HTTP (with an
 *  explicit `instance`, because the inventory still shows the branch here until the next publish),
 *  and the provider session pointer is cleared: the session file lives on this host's disk, so the
 *  next run over there takes the ladder's portable-transcript rung rather than failing to resume.
 *  Turns and enrichment are in the shared database and need no moving. */
export async function moveWorkstream(cfg: OrcaConfig, repo: RepoConfig, branch: string, to: string): Promise<{ branch: string; worktreePath: string; instance: string }> {
  const here = db.instanceName();
  if (to === here) throw new Error(`${repo.name}/${branch} is already on ${here}`);
  const base = cfg.instances?.[to];
  if (!base) throw new Error(`"${to}" is not a configured instance (instances: ${Object.keys(cfg.instances ?? {}).join(", ") || "none"})`);
  const wt = (await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).find((w) => w.branch === branch);
  if (!wt) throw new Error(`${repo.name}/${branch} has no worktree on ${here}`);
  if (agent.isRunning(wt.worktreePath)) throw new Error(`${repo.name}/${branch} has an agent running; wait for it (or stop it) before moving`);
  if (!(await git.hasRemote(repo.repoPath))) throw new Error(`${repo.name} has no remote to carry the branch across`);
  await git.pushBranch(wt.worktreePath, branch);
  await git.removeWorktree(repo.repoPath, wt.worktreePath);
  const res = await fetch(new URL("/api/worktrees/adopt", base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: repo.name, branch, instance: to }),
  });
  const data = (await res.json().catch(() => ({}))) as { worktreePath?: string; error?: string };
  if (!res.ok || !data.worktreePath) throw new Error(`${to} could not adopt ${branch}: ${data.error ?? `answered ${res.status}`} (the branch is on origin; the worktree here is gone)`);
  await db.patchEnrichment(repo.name, branch, { sessionId: null, movedFrom: here, movedAt: new Date().toISOString() });
  return { branch, worktreePath: data.worktreePath, instance: to };
}

// ---- cleanup after finished work ----

/** What Orca itself put in a worktree (copied config, linked dependencies) — never "uncommitted work". */
const orcaPaths = (repo: RepoConfig): string[] => [...(repo.copyToWorktree ?? []), ...(repo.linkToWorktree ?? [])];

/** Reap one finished worktree: its preview stopped (and its placement forgotten), the worktree
 *  removed, a MERGED branch deleted (a closed PR's branch is kept), the workstream archived — its
 *  conversation stays. Only ever called once `cleanupDecision` said nothing would be lost. */
async function reapWorktree(repo: RepoConfig, w: { branch: string; worktreePath: string }, reason: git.ReapReason, blocked: boolean): Promise<void> {
  agent.stop(w.worktreePath);
  // A headless process left in the worktree (one this bridge no longer tracks), matched by its cwd —
  // never by argv: the orchestrator's prompt lists every branch, and an argv match SIGTERMed its wake.
  await agent.killInWorktree(w.worktreePath);
  preview.stop(w.worktreePath, true); // reaped → drop its preview DB too
  await db.clearPreviewPlacement(w.worktreePath).catch(() => {});
  await git.removeWorktree(repo.repoPath, w.worktreePath);
  if (reason === "merged") await git.deleteBranch(repo.repoPath, w.branch);
  if (blocked) await db.patchEnrichment(repo.name, w.branch, { cleanupBlocked: null }).catch(() => {});
  await db.archive(repo.name, w.branch);
}

export type CleanupResult = { branch: string; worktreePath: string; reason: git.ReapReason; action: "reaped" | "flagged" | "waiting"; why?: string };
const cleaning = new Map<string, Promise<CleanupResult[]>>();

/** Auto-archive: every worktree HERE whose PR merged or closed is reaped once the grace period is
 *  over and no agent runs on it — unless it holds uncommitted changes or commits that exist nowhere
 *  else, which is flagged on its card (`cleanupBlocked`) and left alone. Each instance runs this for
 *  its own worktrees (the agents poll and the publish tick), so a laptop's worktree is reaped by the
 *  laptop. One pass per repo at a time: the poll and the tick overlap. */
export function cleanupRepo(repo: RepoConfig, opts: { now?: number; graceMs?: number } = {}): Promise<CleanupResult[]> {
  // A branch preview's read-only bridge (db.previewBridge) answers the same agents poll: it must
  // never remove this instance's worktrees.
  if (db.previewBridge()) return Promise.resolve([]);
  const inflight = cleaning.get(repo.name);
  if (inflight) return inflight;
  const pass = (async () => {
    const done = await gh.donePrs(repo.repoPath).catch(() => new Map<string, gh.DonePr>()); // empty for local-only repos
    if (!done.size) return [];
    const out: CleanupResult[] = [];
    let ench: Record<string, db.Fields> | undefined;
    for (const w of await git.listWorktrees(repo.repoPath, repo.worktreeRoot)) {
      const pr = done.get(w.branch);
      if (!pr) continue;
      const facts = { doneAt: pr.at, now: opts.now ?? Date.now(), graceMs: opts.graceMs, running: agent.isRunning(w.worktreePath) };
      let d = cleanupDecision({ ...facts, dirty: [], unpushed: 0 }); // timing first — the git probes only once due
      if (d.action === "reap") d = cleanupDecision({ ...facts, ...(await git.worktreeSafety(repo.repoPath, w, { base: repo.baseBranch, head: pr.head, ignore: orcaPaths(repo) })) });
      ench ??= await db.enrichment(repo.name).catch(() => ({}));
      const blocked = ench[w.branch]?.cleanupBlocked as { why?: string } | undefined;
      if (d.action === "reap") {
        try {
          await reapWorktree(repo, w, pr.reason, Boolean(blocked));
          out.push({ ...w, reason: pr.reason, action: "reaped" });
          continue;
        } catch (e) {
          d = { action: "flag", why: `removal failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
        }
      }
      if (d.action === "flag" && blocked?.why !== d.why) {
        console.warn(`orca: not reaping ${repo.name}/${w.branch} (PR ${pr.reason}): ${d.why}`);
        await db.patchEnrichment(repo.name, w.branch, { cleanupBlocked: { why: d.why, at: new Date().toISOString() } }).catch(() => {});
      }
      out.push({ ...w, reason: pr.reason, action: d.action === "flag" ? "flagged" : "waiting", why: d.why });
    }
    return out;
  })().finally(() => cleaning.delete(repo.name));
  cleaning.set(repo.name, pass);
  return pass;
}

/** The one-off sweep on THIS instance: every finished (merged, closed or archived) workstream whose
 *  worktree is still on disk, every preview with nothing behind it, and every branch Orca knows of
 *  (a done PR's or a workstream's) left with no worktree and no open PR. A dry run unless `confirm`;
 *  the same safety as auto-archive (no grace period — you asked), and a branch goes only when every
 *  commit on it exists elsewhere. */
export async function sweep(cfg: OrcaConfig, opts: { confirm?: boolean; now?: number } = {}): Promise<SweepReport> {
  const confirm = Boolean(opts.confirm) && !db.previewBridge(); // a preview bridge only ever dry-runs
  const report: SweepReport = { instance: db.instanceName(), confirmed: confirm, worktrees: [], previews: [], branches: [] };
  const removing = new Map<string, () => Promise<void>>(); // worktree path → its reap
  for (const repo of cfg.repos.filter(repoHere)) {
    const [done, archived, ench] = await Promise.all([
      gh.donePrs(repo.repoPath).catch(() => new Map<string, gh.DonePr>()),
      db.archivedBranches(repo.name).catch(() => new Set<string>()),
      db.enrichment(repo.name).catch(() => ({}) as Record<string, db.Fields>),
    ]);
    let open: Set<string>;
    try { open = new Set((await gh.listPrs(repo.repoPath)).map((p) => p.branch)); }
    catch (e) {
      if (await git.hasRemote(repo.repoPath)) {
        report.branches.push({ repo: repo.name, branch: "*", action: "keep", why: `skipped the repo: open PRs unknown (${e instanceof Error ? e.message.split("\n")[0] : String(e)})` });
        continue;
      }
      open = new Set(); // a local-only repo has no PRs
    }
    const goingBranches = new Set<string>();
    for (const w of await git.listWorktrees(repo.repoPath, repo.worktreeRoot)) {
      const pr = done.get(w.branch);
      const reason: git.ReapReason | undefined = pr?.reason ?? (archived.has(w.branch) ? "archived" : undefined);
      if (!reason || open.has(w.branch)) continue; // not finished, or a newer PR reuses the branch
      const d = cleanupDecision({
        now: opts.now ?? Date.now(), graceMs: 0, running: agent.isRunning(w.worktreePath),
        ...(await git.worktreeSafety(repo.repoPath, w, { base: repo.baseBranch, head: pr?.head, ignore: orcaPaths(repo) })),
      });
      report.worktrees.push({ repo: repo.name, branch: w.branch, worktreePath: w.worktreePath, reason, action: d.action === "reap" ? "remove" : "keep", why: d.action === "reap" ? undefined : d.why });
      if (d.action !== "reap") continue;
      removing.set(w.worktreePath, () => reapWorktree(repo, w, reason, Boolean(ench[w.branch]?.cleanupBlocked)));
      if (reason === "merged") goingBranches.add(w.branch); // the reap deletes it
    }
    const known = new Set([...done.keys(), ...archived, ...Object.keys(ench)]);
    for (const b of await git.localBranches(repo.repoPath).catch(() => [])) {
      if (b.branch === repo.baseBranch || !known.has(b.branch) || open.has(b.branch) || goingBranches.has(b.branch)) continue;
      if (b.worktreePath && !removing.has(b.worktreePath)) continue; // still checked out somewhere that stays
      const unpushed = await git.unpushedCount(repo.repoPath, `refs/heads/${b.branch}`, { base: repo.baseBranch, head: done.get(b.branch)?.head });
      const what = done.get(b.branch) ? `PR ${done.get(b.branch)!.reason}` : archived.has(b.branch) ? "archived" : "no open PR";
      report.branches.push(unpushed
        ? { repo: repo.name, branch: b.branch, action: "keep", why: `${what}, but ${unpushed === 1 ? "1 commit exists" : `${unpushed} commits exist`} only on it` }
        : { repo: repo.name, branch: b.branch, action: "remove", why: `${what}, no worktree, every commit is on a remote or in ${repo.baseBranch}` });
    }
  }
  for (const p of await preview.list().catch(() => [])) {
    const why = removing.has(p.key) ? "its worktree is being removed" : !existsSync(p.key) ? "its worktree is gone" : undefined;
    if (why) report.previews.push({ key: p.key, why });
  }
  if (!confirm) return report;
  for (const w of report.worktrees) {
    if (w.action !== "remove") continue;
    try { await removing.get(w.worktreePath)!(); w.done = true; }
    catch (e) { w.done = false; w.why = e instanceof Error ? e.message.split("\n")[0] : String(e); }
  }
  for (const p of report.previews) {
    preview.stop(p.key, true);
    await db.clearPreviewPlacement(p.key).catch(() => {});
    p.done = true;
  }
  for (const b of report.branches) {
    if (b.action !== "remove") continue;
    const repo = cfg.repos.find((r) => r.name === b.repo)!;
    await git.deleteBranch(repo.repoPath, b.branch);
    b.done = !(await git.localBranches(repo.repoPath)).some((x) => x.branch === b.branch);
  }
  return report; // the 10s publish tick carries the stopped previews to the other instance
}

/** The sweep on EVERY instance: this one directly, the others over HTTP (`/api/cleanup/sweep` with
 *  `local`, so it doesn't fan out again). An instance that doesn't answer is reported, not skipped. */
export async function sweepAll(cfg: OrcaConfig, opts: { confirm?: boolean } = {}): Promise<SweepReport[]> {
  const here = db.instanceName();
  const others = Object.entries(cfg.instances ?? {}).filter(([name]) => name !== here);
  return Promise.all([sweep(cfg, opts), ...others.map(async ([instance, base]): Promise<SweepReport> => {
    try {
      const res = await fetch(new URL("/api/cleanup/sweep", base), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: Boolean(opts.confirm), local: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { reports?: SweepReport[]; error?: string };
      if (!res.ok || !data.reports?.[0]) throw new Error(data.error ?? `answered ${res.status}`);
      return data.reports[0];
    } catch (e) {
      return { instance, confirmed: Boolean(opts.confirm), error: e instanceof Error ? e.message : String(e), worktrees: [], previews: [], branches: [] };
    }
  })]);
}
