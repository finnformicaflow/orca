// Source of truth is the LIVE system across ALL configured repos: worktrees + running
// agents (GET /api/agents) and open PRs (GET /api/prs) per repo, polled together and
// aggregated into unified rows tagged by repo. localStorage only *enriches* (prompt, title,
// local-promote flag, Slack timestamps), keyed by repo+branch.
import { useSyncExternalStore } from "react";
import { api, type LiveAgent, type PreviewSvc, type RepoInfo } from "./api";
import type { CiStatus, Mergeable, MergedPr, PrSummary, ReviewStatus } from "../../server/gh";
import {
  deriveKanbanState, followUpPrompt, launchPrompt, resolveCiPrompt, resolveConflictsPrompt,
  slackPrompt, withAttachments,
} from "./workstream";

const KEY = "orca.enrichment";
const now = () => new Date().toISOString();
const EMPTY_REPOS: RepoInfo[] = [];

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

// ---- config ----
let cfg: { repos: RepoInfo[]; staleHours: number } | null = null;
export const configReady = api.config()
  .then((c) => { cfg = c; notify(); void refresh(); })
  .catch(() => { cfg = { repos: EMPTY_REPOS, staleHours: 24 }; });

const repoInfo = (repo: string) => cfg?.repos.find((r) => r.name === repo);
export const useRepos = (): RepoInfo[] => useSyncExternalStore(subscribe, () => cfg?.repos ?? EMPTY_REPOS);
export const baseBranch = (repo: string) => repoInfo(repo)?.baseBranch ?? "main";
export const slackChannel = (repo: string) => repoInfo(repo)?.slackChannel;
export const staleHours = () => cfg?.staleHours ?? 24;

// ---- enrichment (repo+branch-keyed) ----
export type Enrichment = {
  prompt?: string; title?: string; promoted?: boolean; sessionId?: string;
  slackNotifiedAt?: string; slackLastBumpedAt?: string; createdAt?: string;
};
let enrichMap: Record<string, Enrichment> = load();
function load(): Record<string, Enrichment> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; }
}
const ekey = (repo: string, branch: string) => `${repo}::${branch}`;
const enrichOf = (repo: string, branch: string): Enrichment => enrichMap[ekey(repo, branch)] ?? {};
function patchEnrich(repo: string, branch: string, fields: Enrichment) {
  const k = ekey(repo, branch);
  enrichMap = { ...enrichMap, [k]: { ...enrichMap[k], ...fields } };
  localStorage.setItem(KEY, JSON.stringify(enrichMap));
  notify();
}
function deleteEnrich(repo: string, branch: string) {
  const { [ekey(repo, branch)]: _drop, ...rest } = enrichMap;
  enrichMap = rest;
  localStorage.setItem(KEY, JSON.stringify(enrichMap));
  notify();
}

// ---- live state (all repos) ----
type RepoLive = { repo: string; hasRemote: boolean; agents: LiveAgent[]; prs: PrSummary[]; merged: MergedPr[] };
let live: RepoLive[] = [];

export async function refresh() {
  const repos = cfg?.repos ?? [];
  live = await Promise.all(repos.map(async (r) => ({
    repo: r.name,
    hasRemote: r.hasRemote,
    agents: await api.agents(r.name).catch(() => [] as LiveAgent[]),
    prs: await api.prs(r.name).catch(() => [] as PrSummary[]),
    merged: r.hasRemote ? await api.mergedPrs(r.name).catch(() => [] as MergedPr[]) : [],
  })));
  // Persist any fresh session id so "Copy CLI" can resume it after a restart (in-memory only otherwise).
  for (const rl of live) {
    for (const a of rl.agents) {
      if (a.sessionId && enrichOf(rl.repo, a.branch).sessionId !== a.sessionId) patchEnrich(rl.repo, a.branch, { sessionId: a.sessionId });
    }
  }
  notify();
}
setInterval(() => void refresh(), 8_000);

// ---- assembled rows ----
export type Lane = "LOCAL" | "DRAFT" | "IN_REVIEW" | "MERGEABLE" | "DONE";
export type Row = {
  isDraft?: boolean;
  repo: string;
  hasRemote: boolean;
  branch: string;
  title: string;
  prompt: string;
  lane: Lane;
  worktreePath?: string;
  agentStatus?: LiveAgent["agentStatus"];
  agentError?: string;
  agentResult?: string;
  agentStartedAt?: number;
  sessionId?: string;
  mergeClean?: "clean" | "conflict";
  promoted?: boolean;
  prNumber?: number;
  prUrl?: string;
  previewUrl?: string;
  ciStatus?: CiStatus;
  reviewStatus?: ReviewStatus;
  mergeable?: Mergeable;
  mergedAt?: string;
  slackNotifiedAt?: string;
  slackLastBumpedAt?: string;
};

function laneFor(row: Row, pr?: PrSummary): Lane {
  if (pr) {
    if (pr.isDraft) return "DRAFT";
    return deriveKanbanState(pr) === "MERGEABLE" ? "MERGEABLE" : "IN_REVIEW";
  }
  if (row.worktreePath && row.promoted) return row.mergeClean === "clean" ? "MERGEABLE" : "IN_REVIEW";
  return "LOCAL"; // pre-PR worktree
}

export function useWorkstreams(): Row[] {
  const snapshot = useSyncExternalStore(subscribe, () => live);
  const rows: Row[] = [];
  for (const rl of snapshot) {
    const prByBranch = new Map(rl.prs.map((p) => [p.branch, p]));
    const wtByBranch = new Map(rl.agents.map((a) => [a.branch, a]));
    for (const branch of new Set([...prByBranch.keys(), ...wtByBranch.keys()])) {
      const pr = prByBranch.get(branch);
      const wt = wtByBranch.get(branch);
      const e = enrichOf(rl.repo, branch);
      const row: Row = {
        repo: rl.repo, hasRemote: rl.hasRemote, branch,
        title: pr?.title ?? e.title ?? branch,
        prompt: e.prompt ?? "",
        worktreePath: wt?.worktreePath, agentStatus: wt?.agentStatus, agentError: wt?.agentError,
        agentResult: wt?.agentResult, agentStartedAt: wt?.agentStartedAt,
        sessionId: e.sessionId ?? wt?.sessionId, // prefer the persisted id (survives restarts)
        mergeClean: wt?.mergeClean, promoted: e.promoted,
        prNumber: pr?.number, prUrl: pr?.url, previewUrl: pr?.previewUrl, isDraft: pr?.isDraft,
        ciStatus: pr?.ciStatus, reviewStatus: pr?.reviewStatus, mergeable: pr?.mergeable,
        slackNotifiedAt: e.slackNotifiedAt, slackLastBumpedAt: e.slackLastBumpedAt,
        lane: "DRAFT",
      };
      row.lane = laneFor(row, pr);
      rows.push(row);
    }
    for (const m of rl.merged) {
      rows.push({
        repo: rl.repo, hasRemote: rl.hasRemote, branch: m.branch, title: m.title, prompt: "",
        lane: "DONE", prNumber: m.number, prUrl: m.url, mergedAt: m.mergedAt,
      });
    }
  }
  return rows;
}

// ---- actions (scoped by each row's repo) ----
export async function createWorkstream(repo: string, prompt: string, images: File[] = []): Promise<void> {
  const paths = images.length ? await api.uploadAttachments(images) : [];
  const { branch, worktreePath, title } = await api.createWorktree(repo, prompt); // server derives the title (Haiku)
  patchEnrich(repo, branch, { prompt, title, createdAt: now() });
  void api.runAgent(worktreePath, withAttachments(launchPrompt({ title, branch, prompt }, baseBranch(repo)), paths)).catch(() => {});
  await refresh();
}

export function rerunAgent(row: Row) {
  if (!row.worktreePath) return Promise.resolve();
  return api.runAgent(row.worktreePath, launchPrompt({ title: row.title, branch: row.branch, prompt: row.prompt }, baseBranch(row.repo))).then(refresh);
}

export async function promote(row: Row, opts?: { draft?: boolean; addPreviewLabel?: boolean }) {
  if (!row.worktreePath) return;
  if (row.hasRemote) {
    await api.promote(row.repo, { worktreePath: row.worktreePath, branch: row.branch, title: row.title, draft: opts?.draft, addPreviewLabel: opts?.addPreviewLabel });
  } else {
    patchEnrich(row.repo, row.branch, { promoted: true }); // local repos have no PR — just mark ready
  }
  await refresh();
}

/** Ensure a local worktree exists for a row (adopts the branch if needed). Returns its path. */
export async function ensureWorktree(row: Row): Promise<string> {
  if (row.worktreePath) return row.worktreePath;
  const { worktreePath } = await api.adopt(row.repo, row.branch);
  patchEnrich(row.repo, row.branch, { title: row.title });
  await refresh();
  return worktreePath;
}

/** Check out the branch locally (if needed) and spin up its preview services. */
export async function testLocally(row: Row): Promise<PreviewSvc[]> {
  const worktreePath = await ensureWorktree(row);
  return api.preview(row.repo, worktreePath, worktreePath);
}

/** Launch a follow-up agent run in the PR's worktree (adopting one if needed), resuming its session. */
export async function followUp(row: Row, instruction: string, images: File[] = []) {
  const paths = images.length ? await api.uploadAttachments(images) : [];
  const wt = await ensureWorktree(row);
  await api.claude(row.repo, wt, withAttachments(followUpPrompt(instruction), paths), wt, row.sessionId);
  await refresh();
}

export async function markReady(row: Row) {
  if (!row.prNumber) return;
  await api.markReady(row.repo, row.prNumber);
  await refresh();
}

export async function merge(row: Row) {
  if (row.prNumber) await api.merge(row.repo, row.prNumber, row.worktreePath);
  else await api.mergeLocal(row.repo, row.branch, row.worktreePath);
  await refresh();
}

export function sendSlack(row: Row, kind: "notify" | "bump") {
  const prompt = slackPrompt({ title: row.title, prNumber: row.prNumber ?? 0, prUrl: row.prUrl }, kind, slackChannel(row.repo));
  const p = api.claude(row.repo, `slack:${row.repo}:${row.branch}`, prompt);
  patchEnrich(row.repo, row.branch, kind === "notify" ? { slackNotifiedAt: now() } : { slackLastBumpedAt: now() });
  return p;
}

export async function resolveConflicts(row: Row) {
  const wt = await ensureWorktree(row); // spin up a worktree for the PR if there isn't one yet
  await api.claude(row.repo, wt, resolveConflictsPrompt({ branch: row.branch }, baseBranch(row.repo)), wt);
  await refresh();
}

export function addPreviewLabel(row: Row) {
  if (!row.prNumber) return Promise.resolve();
  return api.addPreviewLabel(row.repo, row.prNumber);
}

export async function fixCi(row: Row) {
  const wt = await ensureWorktree(row); // spin up a worktree for the PR if there isn't one yet
  await api.claude(row.repo, wt, resolveCiPrompt({ prNumber: row.prNumber ?? 0, branch: row.branch }), wt);
  await refresh();
}

export const stopPreview = (worktreePath: string) => api.previewStop(worktreePath);
export const previewStatus = (worktreePath: string) => api.previewStatus(worktreePath);
export const summary = (repo: string, worktreePath: string) => api.summary(repo, worktreePath);

export async function discardDraft(row: Row) {
  if (!row.worktreePath) return;
  await api.previewStop(row.worktreePath).catch(() => {});
  // Only delete the branch for pre-PR locals; never delete a branch that has an open PR.
  await api.discardWorktree(row.repo, row.worktreePath, row.branch, !row.prNumber);
  deleteEnrich(row.repo, row.branch);
  await refresh();
}
