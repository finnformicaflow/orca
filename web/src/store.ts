// Source of truth is the LIVE system: worktrees + running agents (GET /api/agents) and
// open PRs (GET /api/prs), polled on a timer. localStorage only *enriches* that live data
// with metadata Orca can't recover from git/gh — prompt, title, preview port, Slack
// timestamps — keyed by branch. PRs/worktrees with no enrichment still show (backwards compat).
import { useSyncExternalStore } from "react";
import { api, type LiveAgent } from "./api";
import type { PrSummary } from "../../server/gh";
import {
  deriveKanbanState, launchPrompt, resolveCiPrompt, resolveConflictsPrompt,
  slackPrompt, titleFromPrompt, type WorkstreamState,
} from "./workstream";

const KEY = "orca.enrichment";
const FALLBACK_RANGE: [number, number] = [4173, 4272];
const now = () => new Date().toISOString();

// ---- subscriptions ----
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// ---- config ----
let cfg: { portRange: [number, number]; baseBranch: string; staleHours: number; slackChannel?: string } | null = null;
export const configReady = api
  .config()
  .then((c) => { cfg = c; })
  .catch(() => { cfg = { portRange: FALLBACK_RANGE, baseBranch: "master", staleHours: 24 }; });
export const baseBranch = () => cfg?.baseBranch ?? "master";
export const staleHours = () => cfg?.staleHours ?? 24;
export const slackChannel = () => cfg?.slackChannel;

// ---- enrichment (branch-keyed metadata, persisted to localStorage) ----
export type Enrichment = {
  prompt?: string;
  title?: string;
  slackNotifiedAt?: string;
  slackLastBumpedAt?: string;
  createdAt?: string;
};
type EnrichMap = Record<string, Enrichment>;

let enrichMap: EnrichMap = load();
function load(): EnrichMap {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; }
}
export const enrich = (branch: string): Enrichment => enrichMap[branch] ?? {};
function patchEnrich(branch: string, fields: Enrichment) {
  enrichMap = { ...enrichMap, [branch]: { ...enrichMap[branch], ...fields } };
  localStorage.setItem(KEY, JSON.stringify(enrichMap));
  notify();
}
function deleteEnrich(branch: string) {
  const { [branch]: _drop, ...rest } = enrichMap;
  enrichMap = rest;
  localStorage.setItem(KEY, JSON.stringify(enrichMap));
  notify();
}
// ---- live state (the source of truth) ----
type Live = { agents: LiveAgent[]; prs: PrSummary[] };
let live: Live = { agents: [], prs: [] };

export async function refresh() {
  const [agents, prs] = await Promise.all([
    api.agents().catch(() => live.agents),
    api.prs().catch(() => live.prs),
  ]);
  live = { agents, prs };
  notify();
}
function useLive(): Live {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => live);
}
void refresh();
setInterval(() => void refresh(), 8_000);

// ---- assembled view rows (live + enrichment) ----
export type AgentRow = LiveAgent & { title: string; prompt: string; createdAt?: string };
export type PrRow = PrSummary & {
  kanbanState: WorkstreamState;
  worktreePath?: string;
  agentStatus?: LiveAgent["agentStatus"];
  slackNotifiedAt?: string;
  slackLastBumpedAt?: string;
};

export function useAgents(): AgentRow[] {
  const { agents, prs } = useLive();
  const promoted = new Set(prs.map((p) => p.branch)); // a branch with an open PR lives in the kanban
  return agents
    .filter((a) => !promoted.has(a.branch))
    .map((a) => {
      const e = enrich(a.branch);
      return { ...a, title: e.title ?? a.branch, prompt: e.prompt ?? "", createdAt: e.createdAt };
    });
}

export function usePrs(): PrRow[] {
  const { agents, prs } = useLive();
  const agentOf = new Map(agents.map((a) => [a.branch, a]));
  return prs.map((pr) => {
    const e = enrich(pr.branch);
    const a = agentOf.get(pr.branch);
    return {
      ...pr,
      kanbanState: deriveKanbanState(pr),
      worktreePath: a?.worktreePath,
      agentStatus: a?.agentStatus,
      slackNotifiedAt: e.slackNotifiedAt,
      slackLastBumpedAt: e.slackLastBumpedAt,
    };
  });
}

// ---- actions ----
export async function createWorkstream(prompt: string): Promise<string> {
  const title = titleFromPrompt(prompt);
  const { branch, worktreePath } = await api.createWorktree(title);
  patchEnrich(branch, { prompt, title, createdAt: now() });
  void api.runAgent(worktreePath, launchPrompt({ title, branch, prompt })).catch(() => {});
  await refresh();
  return branch;
}

export function rerunAgent(branch: string, worktreePath: string) {
  const e = enrich(branch);
  return api.runAgent(worktreePath, launchPrompt({ title: e.title ?? branch, branch, prompt: e.prompt ?? "" })).then(refresh);
}

export async function promote(branch: string, worktreePath: string, title: string) {
  await api.promote({ worktreePath, branch, title });
  await refresh();
}

export async function merge(pr: number, worktreePath?: string) {
  await api.merge(pr, worktreePath);
  await refresh();
}

export const startPreview = (branch: string, worktreePath: string) => api.preview(branch, worktreePath);
export const stopPreview = (branch: string) => api.previewStop(branch);
export const previewStatus = (branch: string) => api.previewStatus(branch);
export const summary = (worktreePath: string) => api.summary(worktreePath);

/** Discard a draft: stop its preview, remove the worktree + branch, drop its enrichment. */
export async function discardDraft(branch: string, worktreePath: string) {
  await api.previewStop(branch).catch(() => {});
  await api.discardWorktree(worktreePath);
  deleteEnrich(branch);
  await refresh();
}

// --- PR actions: each launches Claude to actually do the thing ---

/** Ask Claude to post/bump a Slack message about the PR (repo-level run, no worktree). */
export function sendSlack(row: PrRow, kind: "notify" | "bump") {
  const prompt = slackPrompt({ title: row.title, prNumber: row.number, prUrl: row.url }, kind, slackChannel());
  const p = api.claude(`slack:${row.number}`, prompt);
  patchEnrich(row.branch, kind === "notify" ? { slackNotifiedAt: now() } : { slackLastBumpedAt: now() });
  return p;
}

/** Ask Claude to resolve the PR's merge conflicts in its worktree, then push. */
export function resolveConflicts(row: PrRow) {
  if (!row.worktreePath) return Promise.resolve();
  return api.claude(row.worktreePath, resolveConflictsPrompt({ branch: row.branch }, baseBranch()), row.worktreePath).then(refresh);
}

/** Ask Claude to fix failing CI on the PR in its worktree, then push. */
export function fixCi(row: PrRow) {
  if (!row.worktreePath) return Promise.resolve();
  return api.claude(row.worktreePath, resolveCiPrompt({ prNumber: row.number, branch: row.branch }), row.worktreePath).then(refresh);
}
