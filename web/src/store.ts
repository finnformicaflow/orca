// Source of truth is the LIVE system across ALL configured repos: worktrees + running
// agents (GET /api/agents) and open PRs (GET /api/prs) per repo, polled together and
// aggregated into unified rows tagged by repo. localStorage only *enriches* (prompt, title,
// local-promote flag, Slack timestamps), keyed by repo+branch.
import { useSyncExternalStore } from "react";
import { api, type LiveAgent, type PreviewSvc, type RepoInfo } from "./api";
import type { CiStatus, Mergeable, MergedPr, PrSummary, ReviewStatus } from "../../server/gh";
import {
  deriveKanbanState, followUpPrompt, launchPrompt, resolveCiPrompt, resolveConflictsPrompt,
  slackPrompt, titleFromPrompt, withAttachments,
} from "./workstream";

const KEY = "orca.enrichment";
const now = () => new Date().toISOString();
const EMPTY_REPOS: RepoInfo[] = [];

const listeners = new Set<() => void>();
// A monotonic version bumped on every notify — useWorkstreams subscribes to it (not to `live`
// alone) so optimistic drafts and enrichment patches re-render immediately, not just on refresh.
let version = 0;
const notify = () => { version++; listeners.forEach((l) => l()); };
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
// Merge against the FRESHEST localStorage, not the in-memory copy: another Orca tab on the same
// origin (common while developing Orca itself) polls every 8s and writes the whole blob, so a
// stale in-memory map would clobber entries that tab just added — the "names lost on refresh" bug.
function patchEnrich(repo: string, branch: string, fields: Enrichment) {
  const k = ekey(repo, branch);
  const fresh = load();
  enrichMap = { ...fresh, [k]: { ...fresh[k], ...fields } };
  localStorage.setItem(KEY, JSON.stringify(enrichMap));
  notify();
}
function deleteEnrich(repo: string, branch: string) {
  const { [ekey(repo, branch)]: _drop, ...rest } = load();
  enrichMap = rest;
  localStorage.setItem(KEY, JSON.stringify(enrichMap));
  notify();
}
// Adopt another tab's writes so our in-memory map (and the board) stay in sync without a refresh.
window.addEventListener("storage", (e) => { if (e.key === KEY) { enrichMap = load(); notify(); } });

// Branches mid-removal (close/discard) — optimistically hidden so a poll that lands between "PR
// closed" and "worktree removed" doesn't flash the row back as a bare Local worktree.
const hiding = new Set<string>();
async function withHidden(repo: string, branch: string, op: () => Promise<void>) {
  const k = ekey(repo, branch);
  hiding.add(k); notify();
  try { await op(); } finally { hiding.delete(k); notify(); }
}

// ---- optimistic drafts ----
// Shown as a Local card the instant you submit — before the server has derived a title, cut a
// branch, and made the worktree (a couple of seconds of Haiku + git). Once the real worktree lands
// in `live`, the optimistic card is dropped and the real one takes over. Undo tears it down whether
// the worktree exists yet or not.
export type OptimisticDraft = {
  id: string; repo: string; prompt: string; title: string;
  cancelled?: boolean; created?: { branch: string; worktreePath: string };
};
let optimistic: OptimisticDraft[] = [];
let optSeq = 0;

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
  // The title stays the Haiku summary of the PROMPT set at creation — deriving it from the agent's
  // final response text instead ("Done! I've added…") produced awkward, sentence-fragment titles.
  for (const rl of live) {
    for (const a of rl.agents) {
      const e = enrichOf(rl.repo, a.branch);
      if (a.sessionId && e.sessionId !== a.sessionId) patchEnrich(rl.repo, a.branch, { sessionId: a.sessionId });
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
  autoMergeEnabled?: boolean;
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
  useSyncExternalStore(subscribe, () => version); // re-render on any store change (live, enrichment, optimistic)
  const snapshot = live;
  const rows: Row[] = [];
  // Optimistic drafts first — they own the top of the Local lane until their real worktree lands.
  const optBranches = new Set<string>();
  for (const o of optimistic) {
    optBranches.add(`${o.repo}::${o.created?.branch}`);
    rows.push({
      repo: o.repo, hasRemote: repoInfo(o.repo)?.hasRemote ?? false, branch: o.id,
      title: o.title, prompt: o.prompt, lane: "LOCAL", agentStatus: "running",
    });
  }
  for (const rl of snapshot) {
    const prByBranch = new Map(rl.prs.map((p) => [p.branch, p]));
    const wtByBranch = new Map(rl.agents.map((a) => [a.branch, a]));
    const mergedBranches = new Set(rl.merged.map((m) => m.branch));
    for (const branch of new Set([...prByBranch.keys(), ...wtByBranch.keys()])) {
      if (optBranches.has(`${rl.repo}::${branch}`)) continue; // its optimistic card is still standing in
      if (hiding.has(ekey(rl.repo, branch))) continue; // being closed/discarded — don't flash it back
      if (mergedBranches.has(branch)) continue; // merged PR → its Done row wins; skip the lingering worktree

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
        ciStatus: pr?.ciStatus, reviewStatus: pr?.reviewStatus, mergeable: pr?.mergeable, autoMergeEnabled: pr?.autoMergeEnabled,
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
// Optimistic: paint the Local card + Undo affordance immediately, then create the worktree and launch
// the agent in the background. Returns the draft synchronously so the caller can wire up Undo without
// waiting on the server. If Undo fires before the worktree exists, we tear it down once it lands.
export function createWorkstream(repo: string, prompt: string, images: File[] = []): OptimisticDraft {
  const draft: OptimisticDraft = { id: `opt-${optSeq++}`, repo, prompt, title: titleFromPrompt(prompt) };
  optimistic = [...optimistic, draft];
  notify();
  void (async () => {
    try {
      const paths = images.length ? await api.uploadAttachments(images) : [];
      const { branch, worktreePath, title } = await api.createWorktree(repo, prompt); // server derives the title (Haiku)
      draft.created = { branch, worktreePath };
      patchEnrich(repo, branch, { prompt, title, createdAt: now() });
      if (draft.cancelled) { // Undo pressed while creating — discard the worktree we just made.
        await api.discardWorktree(repo, worktreePath, branch, true).catch(() => {});
        deleteEnrich(repo, branch);
      } else {
        void api.runAgent(worktreePath, withAttachments(launchPrompt({ title, branch, prompt }, baseBranch(repo)), paths)).catch(() => {});
      }
    } finally {
      await refresh();                                       // pull the real worktree into `live`…
      optimistic = optimistic.filter((o) => o.id !== draft.id); // …then drop the stand-in
      notify();
    }
  })();
  return draft;
}

/** Undo a just-created draft: kill the run + remove the worktree/branch if it exists yet, else flag
 *  it so createWorkstream discards it the moment the worktree lands. */
export async function undoDraft(draft: OptimisticDraft) {
  draft.cancelled = true;
  optimistic = optimistic.filter((o) => o.id !== draft.id);
  notify();
  if (draft.created) await discardDraft({ repo: draft.repo, branch: draft.created.branch, worktreePath: draft.created.worktreePath } as Row);
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

export async function convertToDraft(row: Row) {
  if (!row.prNumber) return;
  await api.convertToDraft(row.repo, row.prNumber);
  await refresh();
}

/** Ask GitHub to squash-merge this PR automatically once its checks + reviews pass. */
export async function autoMerge(row: Row) {
  if (!row.prNumber) return;
  await api.autoMerge(row.repo, row.prNumber);
  await refresh();
}

export async function merge(row: Row) {
  if (row.prNumber) await api.merge(row.repo, row.prNumber, row.worktreePath);
  else await api.mergeLocal(row.repo, row.branch, row.worktreePath);
  await refresh();
}

/** Close a PR without merging and clean up its worktree + local branch + enrichment. */
export async function closePr(row: Row) {
  if (!row.prNumber) return;
  await withHidden(row.repo, row.branch, async () => {
    await api.closePr(row.repo, row.prNumber!, row.worktreePath, row.branch);
    deleteEnrich(row.repo, row.branch);
    await refresh();
  });
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
  await withHidden(row.repo, row.branch, async () => {
    await api.previewStop(row.worktreePath!).catch(() => {});
    // Only delete the branch for pre-PR locals; never delete a branch that has an open PR.
    await api.discardWorktree(row.repo, row.worktreePath!, row.branch, !row.prNumber);
    deleteEnrich(row.repo, row.branch);
    await refresh();
  });
}
