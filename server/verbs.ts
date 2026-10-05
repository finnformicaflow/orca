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
import { featuresOf, modelFor, providerAllowed, type OrcaConfig, type RepoConfig } from "./config";
import { addressPrPrompt, chatPrompt, continuation, launchPrompt, slugifyBranch, titleFromPrompt } from "../web/src/workstream";
import { providerOfModel } from "../shared/models";
import { isAgentProvider, type AgentProvider } from "../shared/agent";

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
 *  orchestrator's `orca preview`. Returns once the services are spawned, not once they are up. */
export async function startPreview(cfg: OrcaConfig, repo: RepoConfig, key: string, worktree: string): Promise<preview.SvcStatus[]> {
  // Gitignored config (backend/.env) is only copied at worktree create/adopt, so a worktree made
  // before the config listed it boots without one and the preview dies on "Error: .env not found".
  // Re-copy what's missing here, leaving any worktree-local edit intact.
  await git.copyToWorktree(repo.repoPath, worktree, repo.copyToWorktree, { keepExisting: true });
  await preview.start(key, worktree, repo.previewServices, cfg.portRange);
  return preview.status(key);
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

/** THE agent action for a PR — one run for conflicts, failing CI and the review, whichever apply —
 *  with the evidence fetched immediately before launch. The manual form of the store's `addressPr`:
 *  every unresolved thread is sent, and the hand-over is recorded once the launch is accepted. */
export async function addressPr(cfg: OrcaConfig, repo: RepoConfig, branch: string): Promise<{ status: "running" | "queued"; pr: number }> {
  const pr = (await gh.listPrs(repo.repoPath)).find((p) => p.branch === branch);
  if (!pr) throw new Error(`${repo.name}/${branch} has no open PR to address`);
  const e = (await db.enrichment(repo.name))[branch] ?? {};
  const conflicting = pr.mergeable === "CONFLICTING";
  const ciFailing = pr.ciStatus === "failing";
  const [details, threads, comments] = await Promise.all([
    ciFailing ? gh.ciEvidence(repo.repoPath, pr.number).catch(() => []) : Promise.resolve([]),
    gh.reviewEvidence(repo.repoPath, pr.number).catch(() => []),
    gh.conversationComments(repo.repoPath, pr.number, e.commentsSeenAt as string | undefined).catch(() => []),
  ]);
  const handed = new Set((e.handedReviewThreadIds as string[] | undefined) ?? []);
  const marked = threads.map((thread) => ({ ...thread, alreadyHanded: handed.has(thread.id) }));
  const seenAt = new Date().toISOString();
  const { status } = await followUp(cfg, repo, branch, {
    instruction: "Address the PR: conflicts, CI, review", action: "address",
    evidenceChars: JSON.stringify(details).length + JSON.stringify(marked).length + JSON.stringify(comments).length,
    prompt: addressPrPrompt({ prNumber: pr.number, branch }, {
      base: repo.baseBranch, conflicting,
      ci: ciFailing ? { failingChecks: pr.failingChecks, details } : undefined,
      feedback: pr.feedback, threads: marked, followed: false, comments,
    }),
  });
  const fields: db.Fields = {};
  if (threads.length) fields.handedReviewThreadIds = [...new Set([...handed, ...threads.map((thread) => thread.id)])].slice(-100);
  if (comments.length) fields.commentsSeenAt = seenAt;
  if (Object.keys(fields).length) await db.patchEnrichment(repo.name, branch, fields);
  return { status, pr: pr.number };
}
