import type { LaunchReceipt, RunMeta } from "../../server/agent";
import type { RepoFeatures } from "../../server/config";
import type { ChangeSummary } from "../../server/git";
import type { CiFailureEvidence, ConversationComment, MergedPr, PrDetail, PrSummary, ReviewSignal, ReviewThreadEvidence } from "../../server/gh";
import type { Usage } from "../../server/usage";
import type { AgentOutcome, AgentProvider, AgentStep, AgentTurn, TurnCheck } from "../../shared/agent";
import type { Notification } from "../../shared/notifications";
import type { BridgeInfo, MechanicalMerge, MergePolicy, SyncResult, TurnShots } from "./workstream";

export type LiveAgent = {
  branch: string;
  worktreePath: string;
  /** The worktree's HEAD sha. */
  head?: string;
  agentStatus: "idle" | "running" | "done" | "error";
  agentError?: string;
  agentResult?: string;
  agentOutcome?: AgentOutcome;
  agentMeta?: RunMeta;
  /** Messages queued for this branch and not yet sent (the agents poll attaches it). */
  queued?: number;
  agentCheck?: TurnCheck;
  agentStartedAt?: number;
  agentFinishedAt?: number;
  agentProvider?: AgentProvider;
  agentRunId?: string;
  agentPrompt?: string;
  sessionId?: string;
  mergeClean?: "clean" | "conflict";
  // Reported by ANOTHER instance (see /api/agents): the worktree is on that machine, so anything
  // naming a local path — Copy CLI, the worktree path itself — doesn't apply here.
  remote?: boolean;
  instance?: string;
};

import { asTurnPage } from "./workstream";
import { trackedFetch as get } from "./lib/refresh";
import { apiFetch, apiUrl } from "./lib/server";

/** `dbUnavailable`: the bridge answered without the database — the turns are what it journaled
 *  locally (server/outbox.ts), to be synced when the database is back. */
export type TurnPage = { turns: AgentTurn[]; older: string | null; dbUnavailable?: boolean };

export type QueuedMessage = {
  id: number; repo: string; branch: string; instruction: string; attachments: string[]; createdAt: number;
};

export type InstanceHealth = {
  instance: string; hostname: string; cores: number; cpuPct: number; load1: number; load5: number;
  memUsedGb: number; memTotalGb: number; memPressurePct?: number; memPressure?: boolean;
  disk?: { usedGb: number; totalGb: number }; uptimeS: number;
  at: number;
  /** What this machine costs per hour (config → EC2 on-demand estimate → 0).
   *  Absent from an older bridge. */
  rate?: { hourlyUsd: number; source: "config" | "estimate" | "none"; instanceType?: string; region?: string };
  /** This calendar month's (UTC) cost: the rate over the hours the samples show it up. Absent with no rate. */
  month?: { usd: number; upHours: number; since: number; unknownHours?: number; usdMax?: number; assumedHours?: number; ledgerFrom?: number | null; billingSince?: number };
  /** Absent from an older bridge. */
  runningAgents?: number;
};
/** One recorded sample of an instance's vitals (instance_metric), for the chip's history graphs. */
export type MetricPoint = { at: number; cpuPct: number; load1: number; memUsedGb: number; memTotalGb: number; diskUsedGb?: number; /** Absent from a bridge older than migration 13 — unknown, not 0. */
  runningAgents?: number;
  /** Agent runs OOM-killed in their own scope since the previous sample (absent = none). */
  oomKills?: number };
export type PreviewSvc = { name: string; port: number; url: string; localUrl?: string; open: boolean; running: boolean; ready: boolean; error?: string; startedAt: number };

const post = (path: string, body: unknown) =>
  apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(res);

async function res(r: Response) {
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `${r.status}`);
  return data;
}

import type { IntegrationsOverview } from "../../shared/integrationSettings";
export type { IntegrationsOverview } from "../../shared/integrationSettings";

export type GithubAccount = { login: string; active: boolean; name?: string; email?: string; configured: { name?: string; email?: string }; repos: string[]; avatarUrl?: string };

export type RepoInfo = {
  name: string; baseBranch: string; slackChannel?: string; hasRemote: boolean; prLabels?: { name: string; default?: boolean }[];
  previewLabel?: string; mergePolicy?: MergePolicy;
  defaultModel?: string; runsOn?: string; features?: RepoFeatures;
  /** GitHub owner from origin, when it has one. */
  owner?: string;
};
const q = (repo: string, extra = "") => `?repo=${encodeURIComponent(repo)}${extra}`;

export const api = {
  config: (): Promise<{ repos: RepoInfo[]; staleHours: number; agentProviders: AgentProvider[]; apiPort: number; instance?: string; instances?: string[]; instanceHourlyUsd?: Record<string, number>; terminal?: Record<string, boolean>; instanceUrls?: Record<string, string>; bridge?: BridgeInfo }> => get("/api/config").then(res),
  /** Settings' Machine cost: one instance's USD/hour; null clears it (back to the EC2 estimate / 0). */
  setInstanceRate: (instance: string, hourlyUsd: number | null): Promise<{ ok: true }> => post("/api/config/instance-rate", { instance, hourlyUsd }),
  setInstanceTerminal: (instance: string, on: boolean): Promise<{ ok: true }> => post("/api/config/terminal", { instance, on }),
  usage: (): Promise<Usage | null> => get("/api/usage").then(res),
  /** The GitHub page: this host's signed-in gh accounts, the identity each commits as, the repos on each. */
  githubAccounts: (): Promise<{ accounts: GithubAccount[] }> => get("/api/github/accounts").then(res),
  /** Settings > Integrations: everything the page shows, in one read; each write is one POST. */
  integrations: (): Promise<IntegrationsOverview> => get("/api/integrations").then(res),
  integrationPost: (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => post(`/api/integrations/${path}`, body),
  setGithubAccount: (login: string, fields: { name?: string; email?: string }): Promise<{ accounts: GithubAccount[] }> => post("/api/github/accounts", { login, ...fields }),
  // Take a hydra login out of its rotation or put it back; `instance` names the host it's signed
  // in on (hydra state is per host) — the usage card's own, today.
  setProfileEnabled: (name: string, enabled: boolean, instance?: string): Promise<{ profiles: Usage["profiles"] }> =>
    post("/api/usage/profile", { name, enabled, instance }),
  // Force a token refresh for a login reporting "token stale" (`hydra refresh <name> --force`) —
  // the fix for the stale chip that would otherwise need SSH.
  refreshProfile: (name: string, instance?: string): Promise<{ profiles: Usage["profiles"] }> =>
    post("/api/usage/refresh", { name, instance }),
  // `instance` places the worktree on that instance (the bridge forwards there); the reply says where it landed.
  createWorktree: (repo: string, prompt: string, provider: AgentProvider, instance?: string): Promise<{ branch: string; worktreePath: string; title: string; instance?: string }> =>
    post("/api/workstreams", { repo, prompt, provider, instance }),
  summary: (repo: string, worktree: string, base?: string): Promise<ChangeSummary> =>
    get(`/api/summary${q(repo, `&worktree=${encodeURIComponent(worktree)}${base ? `&base=${encodeURIComponent(base)}` : ""}`)}`).then(res),
  promote: (repo: string, b: { worktreePath: string; branch: string; title: string; provider: AgentProvider; task?: string; sessionId?: string; outcome?: AgentOutcome; body?: string; draft?: boolean; labels?: string[] }): Promise<{ number: number; url: string }> =>
    post("/api/promote", { repo, ...b }),
  markReady: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/ready", { repo, pr }),
  /** Merge the base into the branch on its own instance; a changelog-only conflict is unioned and
   *  pushed there with no agent (server/verbs.ts `settleConflict`). */
  settleConflict: (repo: string, branch: string): Promise<{ outcome: MechanicalMerge; files: string[] }> => post("/api/conflicts/settle", { repo, branch }),
  // Rename a card: for a PR this edits the GitHub title (the card's title source); always records it in
  // enrichment. suggestTitle asks the provider to name it from the prompt (or the PR body for adopted PRs).
  suggestTitle: (repo: string, b: { provider: AgentProvider; prompt?: string; pr?: number; branch?: string; worktreePath?: string }): Promise<{ title: string }> =>
    post("/api/suggest-title", { repo, ...b }),
  rename: (repo: string, b: { branch: string; title: string; pr?: number }): Promise<{ ok: true }> =>
    post("/api/rename", { repo, ...b }),
  autoMerge: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/auto-merge", { repo, pr }),
  mergeWhenGreen: (repo: string, pr: number, branch?: string): Promise<{ text: string }> => post("/api/prs/merge-when-green", { repo, pr, branch, by: "user" }),
  disableAutoMerge: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/disable-auto-merge", { repo, pr }),
  convertToDraft: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/draft", { repo, pr }),
  // `instance` adopts the branch on THAT instance (a preview can run where the session doesn't).
  adopt: (repo: string, branch: string, instance?: string): Promise<{ branch: string; worktreePath: string }> => post("/api/worktrees/adopt", { repo, branch, instance }),
  // Move a workstream's worktree to another instance; the bridge routes it to wherever it is now.
  moveWorkstream: (repo: string, branch: string, to: string): Promise<{ branch: string; worktreePath: string; instance: string }> =>
    post("/api/workstreams/move", { repo, branch, to }),
  handoff: (repo: string, branch: string, content: string): Promise<{ path: string }> => post("/api/handoff", { repo, branch, content }),
  // The durable enrichment + chat history (server/db.ts) — what localStorage used to hold.
  enrichment: (repo: string): Promise<Record<string, Record<string, unknown>>> => get(`/api/enrichment${q(repo)}`).then(res),
  patchEnrichment: (repo: string, branch: string, fields: Record<string, unknown>): Promise<{ ok: true }> =>
    post("/api/enrichment", { repo, branch, fields }),
  importEnrichment: (entries: { repo: string; branch: string; fields: Record<string, unknown> }[]): Promise<{ imported: number }> =>
    post("/api/enrichment/import", { entries }),
  turns: (repo: string, branch: string): Promise<AgentTurn[]> =>
    get(`/api/turns${q(repo, `&branch=${encodeURIComponent(branch)}`)}`).then(res),
  /** Every screenshot the branch's turns reported, newest turn first (`workstreamShots`). */
  shots: (repo: string, branch: string): Promise<TurnShots[]> =>
    get(`/api/shots${q(repo, `&branch=${encodeURIComponent(branch)}`)}`).then(res),
  /** One page of a conversation: the newest `limit` turns, or the `limit` before the `before` cursor
   *  a previous page returned (`older`, null at the conversation's first turn). The chat opens on the
   *  tail and walks back as you scroll up, instead of loading hundreds of turns to show the last few. */
  turnPage: (repo: string, branch: string, opts: { limit: number; before?: string }): Promise<TurnPage> =>
    get(`/api/turns${q(repo, `&branch=${encodeURIComponent(branch)}&limit=${opts.limit}${opts.before ? `&before=${encodeURIComponent(opts.before)}` : ""}`)}`)
      .then(res).then((body) => asTurnPage<AgentTurn>(body)), // a pre-paging bridge answers with the whole array
  /** URL for the tab's ONE live feed (every chat's steps and turn events, multiplexed — see
   *  lib/events.ts). A URL, not a fetch, because EventSource opens it itself and reconnects on its own. */
  eventsUrl: (): string => apiUrl("/api/events"),
  /** Instructions typed while a run was in flight, waiting to be sent. */
  queued: (repo: string, branch: string): Promise<QueuedMessage[]> =>
    get(`/api/queued${q(repo, `&branch=${encodeURIComponent(branch)}`)}`).then(res),
  cancelQueued: (repo: string, id: number): Promise<{ ok: true }> => post("/api/queued/cancel", { repo, id }),
  /** Catch-up after a dropped stream: steps recorded since `since` for one run. */
  turnSteps: (repo: string, branch: string, runId: string, since: number): Promise<{ steps: AgentStep[]; seq: number; finished: boolean }> =>
    get(`/api/turns/steps${q(repo, `&branch=${encodeURIComponent(branch)}&runId=${encodeURIComponent(runId)}&since=${since}`)}`).then(res),
  /** Interrupt the running agent for a worktree, keeping the worktree and session (see /api/agent/stop). */
  stopAgent: (key: string): Promise<{ ok: true; runId?: string }> => post("/api/agent/stop", { key }),
  /** `/compact` in a conversation's own Claude session (a card's, or the orchestrator's under its
   *  reserved repo). 409 while the session is mid-turn. */
  compact: (repo: string, branch: string): Promise<{ runId: string }> => post("/api/compact", { repo, branch }),
  // The orchestrator: one conversation that delegates to workstreams (server/orchestrator.ts). Its
  // turns are read through the ordinary chat routes under its reserved repo/branch.
  orchestrator: (): Promise<{ key: string; running: boolean; paused: boolean; notes: string; model: string; contextPct?: number; shell?: boolean; lastWakeUsd?: number; hint?: string; startedAt?: number; queued?: number }> => get("/api/orchestrator").then(res),
  orchestratorModel: (model: string): Promise<{ ok: true }> => post("/api/orchestrator/model", { model }),
  orchestratorMessage: (text: string, attachments: string[] = []): Promise<{ status: "running" | "queued" }> =>
    post("/api/orchestrator/message", { text, attachments }),
  slack: (repo: string, text: string): Promise<{ ok: true }> => post("/api/slack", { repo, text }),
  // The notification centre (one table, any instance answers). `since` (ms) is the catch-up cursor
  // after the live stream was dropped; the live rows themselves arrive on /api/events.
  notifications: (since?: number): Promise<Notification[]> => get(`/api/notifications${since ? `?since=${since}` : ""}`).then(res),
  notificationsRead: (ids: number[] | "all"): Promise<{ ok: true; changed: number }> => post("/api/notifications/read", ids === "all" ? { all: true } : { ids }),
  agents: (repo: string): Promise<LiveAgent[]> => get(`/api/agents${q(repo)}`).then(res),
  prs: (repo: string): Promise<PrSummary[]> => get(`/api/prs${q(repo)}`).then(res),
  // The client sends its own local midnight: "merged today" belongs to the person reading the board,
  // not to the timezone of whatever machine the bridge runs on.
  mergedPrs: (repo: string): Promise<MergedPr[]> => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return get(`/api/prs/merged${q(repo, `&since=${midnight.getTime()}`)}`).then(res);
  },
  prDetail: (repo: string, n: number): Promise<PrDetail> => get(`/api/prs/${n}${q(repo)}`).then(res),
  prDiff: (repo: string, n: number): Promise<{ diff: string }> => get(`/api/prs/${n}/diff${q(repo)}`).then(res),
  reviewEvidence: (repo: string, n: number): Promise<ReviewThreadEvidence[]> => get(`/api/prs/${n}/review-evidence${q(repo)}`).then(res),
  reviewSignal: (repo: string, n: number): Promise<ReviewSignal> => get(`/api/prs/${n}/review-signal${q(repo)}`).then(res),
  prComments: (repo: string, n: number, since?: string): Promise<ConversationComment[]> =>
    get(`/api/prs/${n}/comments${q(repo)}${since ? `&since=${encodeURIComponent(since)}` : ""}`).then(res),
  ciEvidence: (repo: string, n: number): Promise<CiFailureEvidence[]> => get(`/api/prs/${n}/ci-evidence${q(repo)}`).then(res),
  localDiff: (repo: string, worktree: string): Promise<{ diff: string }> =>
    get(`/api/diff${q(repo, `&worktree=${encodeURIComponent(worktree)}`)}`).then(res),
  merge: (repo: string, pr: number, worktreePath?: string): Promise<{ ok: true }> => post("/api/merge", { repo, pr, worktreePath }),
  closePr: (repo: string, pr: number, worktreePath?: string, branch?: string): Promise<{ ok: true }> =>
    post("/api/prs/close", { repo, pr, worktreePath, branch }),
  mergeLocal: (repo: string, branch: string, worktreePath?: string): Promise<{ ok: true }> => post("/api/merge-local", { repo, branch, worktreePath }),
  addPreviewLabel: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/label", { repo, pr }),
  // Previews are placed explicitly: a worktree path alone can't say which instance holds it once a
  // branch is checked out on both (the session's instance and the preview's may differ).
  preview: (repo: string, key: string, worktree: string, instance?: string, branch?: string): Promise<PreviewSvc[]> => post("/api/preview", { repo, key, worktree, instance, branch }),
  previewMaster: (repo: string): Promise<{ worktreePath: string; svcs: PreviewSvc[] }> => post("/api/preview/master", { repo }),
  previewStatus: (key: string, instance?: string): Promise<PreviewSvc[]> => get(`/api/preview?key=${encodeURIComponent(key)}${instance ? `&instance=${encodeURIComponent(instance)}` : ""}`).then(res),
  previews: (): Promise<{ key: string; instance?: string; svcs: PreviewSvc[] }[]> => get("/api/previews").then(res),
  previewStop: (key: string, instance?: string): Promise<{ ok: true }> => post("/api/preview/stop", { key, instance }),
  // A machine's vitals (the header's instance chip); `instance` asks another instance for its own.
  health: (instance?: string): Promise<InstanceHealth> => get(`/api/health${instance ? `?instance=${encodeURIComponent(instance)}` : ""}`).then(res),
  // Its recorded vitals over the last `hours` (default 24), read from Postgres by whichever instance answers.
  healthHistory: (instance: string, hours = 24): Promise<MetricPoint[]> => get(`/api/health/history?instance=${encodeURIComponent(instance)}&hours=${hours}`).then(res),
  syncWorktrees: (repo: string): Promise<SyncResult[]> => post("/api/worktrees/sync", { repo }),
  discardWorktree: (repo: string, worktreePath: string, branch?: string, deleteBranch?: boolean): Promise<{ ok: true }> =>
    post("/api/worktrees/remove", { repo, worktreePath, branch, deleteBranch }),
  runAgent: (worktreePath: string, prompt: string, provider: AgentProvider = "claude", options: { instance?: string; resume?: string; history?: AgentTurn[]; handoffFrom?: AgentProvider; branch?: string; action?: string; evidenceChars?: number; instruction?: string; model?: string } = {}): Promise<LaunchReceipt> =>
    post("/api/agents/run", { worktreePath, prompt, provider, ...options }),
  // Returns `{ status: "queued" }` instead of a receipt when a run is already in flight and this is a
  // follow-up — the bridge holds it and sends it when that run finishes.
  agent: (repo: string, key: string, prompt: string, options: { worktree?: string; provider?: AgentProvider; resume?: string; history?: AgentTurn[]; handoffFrom?: AgentProvider; branch?: string; action?: string; evidenceChars?: number; attachments?: string[]; instruction?: string; model?: string } = {}): Promise<LaunchReceipt | { status: "queued"; queued: QueuedMessage }> =>
    post("/api/agent", { repo, key, prompt, ...options }),
  // Compatibility helper for existing callers/tests while agent actions migrate to `agent`.
  claude: (repo: string, key: string, prompt: string, worktree?: string, resume?: string): Promise<{ status: string }> =>
    post("/api/claude", { repo, key, prompt, worktree, resume }),
  uploadAttachments: async (files: File[]): Promise<string[]> => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return (await apiFetch("/api/attachments", { method: "POST", body: form }).then(res)).paths;
  },
};
