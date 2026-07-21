// Source of truth is the LIVE system across ALL configured repos: worktrees + running
// agents (GET /api/agents) and open PRs (GET /api/prs) per repo, polled together and
// aggregated into unified rows tagged by repo. localStorage only *enriches* (prompt, title,
// local-promote flag, Slack timestamps), keyed by repo+branch.
import { useSyncExternalStore } from "react";
import { api, type LiveAgent, type PreviewSvc, type RepoInfo } from "./api";
import type { CiStatus, Mergeable, MergedPr, PrSummary, ReviewStatus } from "../../server/gh";
import {
  addressReviewPrompt, deriveKanbanState, followDecision, followUpPrompt, launchPrompt, resolveCiPrompt,
  rerunFailedPrompt, resolveConflictsPrompt, slackApiText, slackClipboard, titleFromPrompt, withAttachments,
} from "./workstream";
import type { AgentOutcome, AgentProvider, AgentTurn } from "../../shared/agent";
import { attachCommand, handoffPrompt } from "../../shared/agent";

const KEY = "orca.enrichment";
const now = () => new Date().toISOString();
const EMPTY_REPOS: RepoInfo[] = [];
// useSyncExternalStore snapshots must be referentially stable between notifications. A literal
// `["claude"]` fallback creates a new array on every read and can trigger an infinite render loop
// while /api/config is still loading (a blank screen on cold startup).
const DEFAULT_AGENT_PROVIDERS: AgentProvider[] = ["claude"];

const listeners = new Set<() => void>();
// A monotonic version bumped on every notify — useWorkstreams subscribes to it (not to `live`
// alone) so optimistic drafts and enrichment patches re-render immediately, not just on refresh.
let version = 0;
const notify = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

// ---- config ----
let cfg: { repos: RepoInfo[]; staleHours: number; agentProviders: AgentProvider[]; apiPort?: number } | null = null;
export const configReady = api.config()
  .then((c) => { cfg = c; notify(); void refresh(); })
  .catch(() => { cfg = { repos: EMPTY_REPOS, staleHours: 24, agentProviders: DEFAULT_AGENT_PROVIDERS }; });

/** The bridge's port — the terminal WebSocket targets it directly (the Bun-run Vite dev proxy can't
 *  forward a WS upgrade). Falls back to the page's own port, which is correct for the built app. */
export const apiPort = (): string => String(cfg?.apiPort ?? location.port);

const repoInfo = (repo: string) => cfg?.repos.find((r) => r.name === repo);
export const useRepos = (): RepoInfo[] => useSyncExternalStore(subscribe, () => cfg?.repos ?? EMPTY_REPOS);
export const agentProviders = (): AgentProvider[] => cfg?.agentProviders ?? DEFAULT_AGENT_PROVIDERS;
export const useAgentProviders = (): AgentProvider[] => useSyncExternalStore(subscribe, agentProviders);
export const baseBranch = (repo: string) => repoInfo(repo)?.baseBranch ?? "main";
export const slackChannel = (repo: string) => repoInfo(repo)?.slackChannel;
export const staleHours = () => cfg?.staleHours ?? 24;

// ---- enrichment (repo+branch-keyed) ----
export type Enrichment = {
  prompt?: string; title?: string; promoted?: boolean; sessionId?: string; agentProvider?: AgentProvider; preferredProvider?: AgentProvider; transcript?: AgentTurn[]; following?: boolean;
  followSig?: string; // last follow state Orca acted on (see runFollowers) — persisted so a reload doesn't re-fire
  followUps?: string[]; // every follow-up prompt SENT for this branch, oldest→newest — recorded on send (see followUp), kept until the branch is merged/discarded. Never lost to a launch/agent error, and drives the composer's ↑/↓ history recall.
  handedReviewThreadIds?: string[];
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
// branch, and made the worktree (a short selected-provider summary + git). Once the real worktree lands
// in `live`, the optimistic card is dropped and the real one takes over. Undo tears it down whether
// the worktree exists yet or not.
export type OptimisticDraft = {
  id: string; repo: string; prompt: string; title: string;
  cancelled?: boolean; created?: { branch: string; worktreePath: string };
};
let optimistic: OptimisticDraft[] = [];
let optSeq = 0;

// ---- live state (all repos), polled as three independent streams ----
// Local-agent status, open PRs, and merged history change on very different cadences, so they poll
// SEPARATELY: agents + PRs fast while work is active (keeps runs and Follow responsive), merged
// history on a slow TTL (it barely changes). Each stream keeps its own {ok} so one stream's
// transient failure never lets GC read another stream's branches as "gone". `live` is the merge of
// the three streams' latest good values — so a fast agents-only poll doesn't drop retained PRs.
type RepoLive = { repo: string; hasRemote: boolean; agents: LiveAgent[]; prs: PrSummary[]; merged: MergedPr[] };
type Slice<T> = { v: T; ok: boolean };
const agentsByRepo = new Map<string, Slice<LiveAgent[]>>();
const prsByRepo = new Map<string, Slice<PrSummary[]>>();
const mergedByRepo = new Map<string, Slice<MergedPr[]>>();
let live: RepoLive[] = [];

// Approximate client-side poll counters. (The server counts the GitHub calls themselves — see
// server/metrics.ts / /api/diagnostics; these track how often each stream fires from the browser.)
const pollCounts = { agents: 0, prs: 0, merged: 0 };
export const clientPollCounts = () => ({ ...pollCounts });

// Settle each fetch to {ok, v} instead of catch-to-empty, so GC can tell a genuinely-empty repo from
// a transient fetch failure (which must NOT be read as "everything's gone" and wipe enrichment).
const settle = <T>(p: Promise<T>, fallback: T): Promise<Slice<T>> =>
  p.then((v) => ({ ok: true, v }), () => ({ ok: false, v: fallback }));

function rebuildLive() {
  live = (cfg?.repos ?? []).map((r) => ({
    repo: r.name, hasRemote: r.hasRemote,
    agents: agentsByRepo.get(r.name)?.v ?? [],
    prs: prsByRepo.get(r.name)?.v ?? [],
    merged: mergedByRepo.get(r.name)?.v ?? [],
  }));
}

// Persist provider-native session ids and completed portable turns off the agents stream. Native ids
// make same-provider resume lossless; the transcript is what lets a different provider take over the
// worktree. The title stays the selected-provider summary of the PROMPT set at creation — deriving it
// from the agent's final response ("Done! I've added…") produced awkward, sentence-fragment titles.
function persistAgentEnrichment() {
  for (const rl of live) {
    for (const a of rl.agents) {
      const e = enrichOf(rl.repo, a.branch);
      const fields: Enrichment = {};
      if (a.sessionId && e.sessionId !== a.sessionId) fields.sessionId = a.sessionId;
      if (a.agentProvider && e.agentProvider !== a.agentProvider) fields.agentProvider = a.agentProvider;
      if (a.agentRunId && a.agentProvider && a.agentPrompt && (a.agentStatus === "done" || a.agentStatus === "error")) {
        const transcript = e.transcript ?? [];
        if (!transcript.some((t) => t.id === a.agentRunId)) {
          fields.transcript = [...transcript, {
            id: a.agentRunId, provider: a.agentProvider, prompt: a.agentPrompt,
            response: a.agentResult ?? a.agentError ?? "The run ended without a final response.",
            structured: a.agentOutcome,
            sessionId: a.sessionId, failed: a.agentStatus === "error" ? true : undefined,
            startedAt: a.agentStartedAt, finishedAt: a.agentFinishedAt,
          }].slice(-25);
        }
      }
      if (Object.keys(fields).length) patchEnrich(rl.repo, a.branch, fields);
    }
  }
}

// Leading + TRAILING coalescing: while a poll of a stream is in flight, a second request doesn't
// stack a duplicate GitHub call — but it also can't be fobbed off with the in-flight poll's result,
// which reflects state from BEFORE the caller asked (the caller may have just created/merged
// something). So it gets exactly one fresh poll chained after the current one finishes. This is what
// makes an imperative refresh() reliably reflect a just-applied mutation.
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let trailing: Promise<void> | null = null;
  const fn = (): Promise<void> => {
    if (!inFlight) { inFlight = run().finally(() => { inFlight = null; }); return inFlight; }
    // Swallow the in-flight poll's rejection before chaining: `.then(onFulfilled)` alone would skip
    // the `trailing = null` reset when it rejects, leaving a rejected promise wedged in the slot that
    // every later caller is handed forever (refresh() never notifies again until a reload).
    if (!trailing) trailing = inFlight.catch(() => {}).then(() => { trailing = null; return fn(); });
    return trailing;
  };
  return fn;
}

export const pollAgents = coalesced(async () => {
  const polled = await Promise.all((cfg?.repos ?? []).map((r) =>
    settle(api.agents(r.name), [] as LiveAgent[]).then((s) => [r.name, s] as const)));
  pollCounts.agents++;
  for (const [name, s] of polled) agentsByRepo.set(name, s);
  rebuildLive();
  persistAgentEnrichment();
  // No notify() here: the individual streams settle at different times, so rendering off one alone
  // shows a partial view where the sources disagree — a PR branch whose worktree loaded but whose PR
  // hasn't looks like a bare LOCAL card, then jumps. The coordinator (refreshAndGc / the solo merged
  // poll) notifies once after its streams settle, so the board only ever paints a consistent view.
});

export const pollPrs = coalesced(async () => {
  const polled = await Promise.all((cfg?.repos ?? []).map((r) =>
    settle(api.prs(r.name), [] as PrSummary[]).then((s) => [r.name, s] as const)));
  pollCounts.prs++;
  for (const [name, s] of polled) prsByRepo.set(name, s);
  rebuildLive();
  runFollowers(); // auto-drive any followed PRs off the status we just polled
  // notify() is the coordinator's job (see pollAgents) — never render off PRs alone.
});

export const pollMerged = coalesced(async () => {
  const polled = await Promise.all((cfg?.repos ?? []).map((r) =>
    (r.hasRemote ? settle(api.mergedPrs(r.name), [] as MergedPr[]) : Promise.resolve({ ok: true, v: [] as MergedPr[] }))
      .then((s) => [r.name, s] as const)));
  pollCounts.merged++;
  for (const [name, s] of polled) mergedByRepo.set(name, s);
  rebuildLive();
  // notify() is the coordinator's job (see pollAgents): refreshAndGc after a full refresh, or the
  // solo TTL caller below via `.then(notify)`.
});

// GC runs only after a COORDINATED settle of the streams that can make a branch disappear (agents +
// PRs) — never off a single stream mid-flight, where another stream's map could still hold a stale
// value and make a live branch look gone. `known` is snapshotted first so a key written during the
// polls (a new draft) is never judged by data gathered before it existed.
async function refreshAndGc(streams: Promise<void>[]): Promise<void> {
  const known = enrichKeysAtStart();
  await Promise.all(streams);
  gcEnrichment(known);
  notify(); // one render off the fully-settled view — never mid-flight (see pollAgents)
}

/** Imperative full refresh (after a mutation) — all three streams, then GC once on a consistent view. */
export function refresh(): Promise<void> {
  return refreshAndGc([pollAgents(), pollPrs(), pollMerged()]);
}

let pollTick = 0;
let lastMergedAt = 0;
const MERGED_TTL_MS = 90_000;
setInterval(() => {
  pollTick++;
  const active = optimistic.length > 0 || live.some((repo) =>
    repo.agents.some((agent) => agent.agentStatus === "running")
    || repo.prs.some((pr) => enrichOf(repo.repo, pr.branch).following));
  const hidden = document.visibilityState === "hidden";
  // Keep transitions responsive; idle boards poll every 32s, hidden idle tabs every 64s.
  const every = active ? 1 : hidden ? 8 : 4;
  if (pollTick % every === 0) void refreshAndGc([pollAgents(), pollPrs()]); // agents + PRs together; GC on the settled pair
  // Merged history changes slowly — poll on a TTL, and far slower when the tab is hidden. It only
  // ever ADDS branches to the "alive" set, so it can't trigger a prune and needs no GC of its own.
  const mergedTtl = hidden ? MERGED_TTL_MS * 8 : MERGED_TTL_MS;
  if (Date.now() - lastMergedAt >= mergedTtl) { lastMergedAt = Date.now(); void pollMerged().then(notify); }
}, 8_000);

// Prune enrichment for branches that no longer exist — merged / closed / branch-deleted, whether via
// Orca or (the leaky case) directly on GitHub. Without this, every finished branch's prompt/title/
// followUps lingered forever. Safe by construction: only prune a repo that polled cleanly this cycle
// (a transient fetch failure would otherwise read as "no branches" and wipe live enrichment), and
// keep very recent keys — a just-created draft's enrichment lands before its worktree shows in `live`.
const GC_GRACE_MS = 2 * 60_000;
// The enrichment keys that existed when a poll STARTED. A poll's result reflects the world at that
// moment, so it may only prune keys already present then — never one written mid-flight (e.g. a draft
// created, or another action's enrichment landing, after the poll's GitHub calls went out).
const enrichKeysAtStart = () => new Set(Object.keys(load()));
function gcEnrichment(allowed: Set<string>) {
  const fresh = load();
  let changed = false;
  for (const r of cfg?.repos ?? []) {
    const agents = agentsByRepo.get(r.name);
    const prs = prsByRepo.get(r.name);
    const merged = mergedByRepo.get(r.name);
    // Judge a branch "gone" only against a CLEAN sample of every stream. A stream not yet polled, or
    // whose last poll failed, means we can't tell — skip the whole repo rather than prune blindly.
    // Because the streams poll on different cadences, this reads each one's LAST GOOD value (not just
    // what the poll that triggered GC fetched), so an agents-only poll can't drop a retained PR.
    if (!agents?.ok || !prs?.ok) continue;
    if (r.hasRemote && !merged?.ok) continue;
    const alive = new Set<string>([
      ...agents.v.map((a) => a.branch),
      ...prs.v.map((p) => p.branch),
      ...(merged?.v ?? []).map((m) => m.branch),
    ]);
    for (const key of Object.keys(fresh)) {
      if (!allowed.has(key)) continue; // written after this poll began — it can't have seen the branch
      const sep = key.indexOf("::");
      if (sep < 0 || key.slice(0, sep) !== r.name) continue; // key belongs to a different (or unconfigured) repo
      const branch = key.slice(sep + 2);
      if (alive.has(branch)) continue;
      const created = fresh[key]!.createdAt;
      if (created && Date.now() - Date.parse(created) < GC_GRACE_MS) continue; // too new to have appeared in `live` yet
      delete fresh[key];
      changed = true;
    }
  }
  if (changed) { enrichMap = fresh; localStorage.setItem(KEY, JSON.stringify(enrichMap)); }
}

// ---- active PR following ----
// A "followed" card is on autopilot: each poll, if its PR has a blocker (conflict / failing CI /
// requested changes) OR a coworker has left new feedback since we last acted, and no agent is
// already working the branch, Orca fires the same action you'd click. The state it last acted on is
// a signature persisted in enrichment (`followSig`) — so it fires once per distinct state, a new
// comment re-triggers, a steady state doesn't stack runs, and a page reload can't replay a storm of
// launches. Followed rows fire from `live` (not the assembled rows) so this stays poll-driven.

/** Toggle whether Orca actively follows a PR's card (auto-fixing conflicts/CI/review, addressing new
 *  comments). Clears the acted-on signature when turning off so re-enabling addresses current state. */
export function toggleFollow(row: Row) {
  const following = !enrichOf(row.repo, row.branch).following;
  patchEnrich(row.repo, row.branch, following ? { following } : { following, followSig: undefined });
}

function runFollowers() {
  for (const rl of live) {
    const wtByBranch = new Map(rl.agents.map((a) => [a.branch, a]));
    for (const pr of rl.prs) {
      const e = enrichOf(rl.repo, pr.branch);
      if (!e.following) continue;
      if (wtByBranch.get(pr.branch)?.agentStatus === "running") continue; // let the current run finish
      const { action, sig } = followDecision(pr, e.followSig);
      if (e.followSig !== sig) patchEnrich(rl.repo, pr.branch, { followSig: sig }); // record before firing → no double-fire
      if (!action) continue;
      const wt = wtByBranch.get(pr.branch);
      const row: Row = {
        repo: rl.repo, hasRemote: rl.hasRemote, branch: pr.branch, title: pr.title, prompt: e.prompt ?? "",
        lane: "IN_REVIEW", worktreePath: wt?.worktreePath, sessionId: e.sessionId ?? wt?.sessionId,
        agentProvider: e.agentProvider ?? wt?.agentProvider, preferredProvider: e.preferredProvider, transcript: e.transcript,
        prNumber: pr.number, prUrl: pr.url, following: true,
        failingChecks: pr.failingChecks, feedback: pr.feedback,
      };
      const fire = action === "resolveConflicts" ? resolveConflicts(row)
        : action === "fixCi" ? fixCi(row)
        : addressReview(row, false);
      void fire.catch(() => {});
    }
  }
}

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
  agentOutcome?: AgentOutcome;
  agentMeta?: LiveAgent["agentMeta"];
  agentStartedAt?: number;
  agentProvider?: AgentProvider;
  preferredProvider?: AgentProvider;
  sessionId?: string;
  transcript?: AgentTurn[];
  mergeClean?: "clean" | "conflict";
  tmux?: boolean; // a live interactive tmux terminal exists for this worktree
  promoted?: boolean;
  prNumber?: number;
  prUrl?: string;
  previewUrl?: string;
  ciStatus?: CiStatus;
  reviewStatus?: ReviewStatus;
  mergeable?: Mergeable;
  autoMergeEnabled?: boolean;
  following?: boolean;
  followUps?: string[];
  failingChecks?: string[];
  feedback?: string[];
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
        agentResult: wt?.agentResult, agentOutcome: wt?.agentOutcome, agentMeta: wt?.agentMeta, agentStartedAt: wt?.agentStartedAt,
        agentProvider: e.agentProvider ?? wt?.agentProvider,
        preferredProvider: e.preferredProvider,
        sessionId: e.sessionId ?? wt?.sessionId, // prefer the persisted id (survives restarts)
        transcript: e.transcript,
        mergeClean: wt?.mergeClean, tmux: wt?.tmux, promoted: e.promoted,
        prNumber: pr?.number, prUrl: pr?.url, previewUrl: pr?.previewUrl, isDraft: pr?.isDraft,
        ciStatus: pr?.ciStatus, reviewStatus: pr?.reviewStatus, mergeable: pr?.mergeable, autoMergeEnabled: pr?.autoMergeEnabled,
        following: e.following, followUps: e.followUps,
        failingChecks: pr?.failingChecks, feedback: pr?.feedback,
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
export function createWorkstream(repo: string, prompt: string, images: File[] = [], provider: AgentProvider = "claude"): OptimisticDraft {
  const draft: OptimisticDraft = { id: `opt-${optSeq++}`, repo, prompt, title: titleFromPrompt(prompt) };
  optimistic = [...optimistic, draft];
  notify();
  void (async () => {
    try {
      const [paths, created] = await Promise.all([
        images.length ? api.uploadAttachments(images) : Promise.resolve([]),
        api.createWorktree(repo, prompt, provider),
      ]);
      const { branch, worktreePath, title } = created; // selected provider derives the title
      draft.created = { branch, worktreePath };
      patchEnrich(repo, branch, { prompt, title, agentProvider: provider, createdAt: now() });
      if (draft.cancelled) { // Undo pressed while creating — discard the worktree we just made.
        await api.discardWorktree(repo, worktreePath, branch, true).catch(() => {});
        deleteEnrich(repo, branch);
      } else {
        void api.runAgent(worktreePath, withAttachments(launchPrompt({ title, branch, prompt }, baseBranch(repo)), paths), provider, { branch, action: "launch" })
          .then((receipt) => patchEnrich(repo, branch, { agentProvider: provider, sessionId: receipt.sessionId }))
          .catch(() => {});
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

/** The agent a card will use for its next action: the user's pin (when that provider is installed),
 *  else the provider that last ran, else Claude. Read by every agent action AND Follow autopilot, so
 *  one pinned choice drives Follow up / Fix CI / Resolve conflicts / Address review consistently. */
export function providerFor(row: Row): AgentProvider {
  if (row.preferredProvider && agentProviders().includes(row.preferredProvider)) return row.preferredProvider;
  return row.agentProvider ?? "claude";
}

/** Pin the card to an agent (persisted per branch). A pin that differs from the provider that last
 *  ran makes the next action hand off through launchOnRow's portable transcript — so switching agents
 *  mid-workstream stays lossless; the worktree/git remain the source of truth. */
export function setCardProvider(row: Row, provider: AgentProvider) {
  patchEnrich(row.repo, row.branch, { preferredProvider: provider });
}

/** How to (re)enter the pinned agent's CLI for a card. Honours the pin, and never hands one provider's
 *  session id to another. Three outcomes: a known session id → resume it; no id but the pinned agent
 *  HAS run in this worktree → continue its latest; `fresh` → the pinned agent has never run here (e.g.
 *  right after switching the pin), so start a new session rather than emit a `--continue` that errors
 *  with "no conversation to continue". Used by Copy CLI and Promote's PR-description writer. */
export function resumeTarget(row: Row): { provider: AgentProvider; sessionId?: string; fresh: boolean } {
  const provider = providerFor(row);
  // The active session pointer belongs to whoever ran last; an id stored with no provider is Claude's.
  const sessionOwner = row.agentProvider ?? "claude";
  const activeId = provider === sessionOwner ? row.sessionId : undefined;
  // Else fall back to the newest transcript turn recorded under this provider (a session that ran
  // earlier, before switching the pin away and back).
  const turnId = (row.transcript ?? []).filter((t) => t.provider === provider).at(-1)?.sessionId;
  const sessionId = activeId ?? turnId;
  if (sessionId) return { provider, sessionId, fresh: false };
  // No id. Only `--continue` if this provider genuinely ran here (strict — an undefined agentProvider
  // means nothing ran, so an adopted PR / just-switched pin gets a fresh session, not a failing continue).
  const ranHere = row.agentProvider === provider || (row.transcript ?? []).some((t) => t.provider === provider);
  return { provider, fresh: !ranHere };
}

// Opening instruction for a handed-off interactive session: orient from the transcript + live worktree
// without doing work, then wait — so you carry on prompting the new model in-context.
const HANDOFF_SEED_INSTRUCTION =
  "Get up to speed from the transcript above and the current worktree (files, git status, recent commits, test results). Then wait for my next instruction — don't make changes yet.";

/** Resolve everything attachCommand needs to (re)enter this row's pinned agent: its worktree (adopted
 *  if missing), the native-resume target, and — when the pinned agent has never run here but there IS
 *  prior context (a model switch / handoff) — a seed file written from the portable transcript, so a
 *  NEW session is primed with it and a maxed-out/previous model is never resumed. Shared by Copy CLI
 *  and Open terminal so the two lanes launch identically. */
async function resolveAttach(row: Row): Promise<{ worktreePath: string; provider: AgentProvider; sessionId?: string; fresh: boolean; seedFile?: string }> {
  const worktreePath = row.worktreePath ?? (await ensureWorktree(row));
  const target = resumeTarget(row);
  const e = enrichOf(row.repo, row.branch);
  const transcript = e.transcript ?? row.transcript ?? [];
  let seedFile: string | undefined;
  if (target.fresh && transcript.length) {
    const from = e.agentProvider ?? row.agentProvider;
    const seed = handoffPrompt(transcript, HANDOFF_SEED_INSTRUCTION, from, target.provider);
    seedFile = (await api.handoff(row.repo, row.branch, seed)).path;
  }
  return { worktreePath, ...target, seedFile };
}

/** The terminal command to (re)enter this workstream's pinned agent, for Copy CLI. */
export async function cliCommand(row: Row): Promise<string> {
  return attachCommand(await resolveAttach(row));
}

/** Open (ensure) the interactive tmux terminal for this row's worktree — the hand-driven lane. Enters
 *  the pinned agent the same way Copy CLI does; idempotent server-side, so re-opening re-attaches to
 *  the running session rather than starting a second one. */
export async function openTerminal(row: Row): Promise<void> {
  const { worktreePath, provider, sessionId, fresh, seedFile } = await resolveAttach(row);
  await api.ensureTerminal(row.repo, { branch: row.branch, worktreePath, provider, sessionId, fresh, seedFile });
}

/** New-draft "Start interactive session": cut the worktree, then start the agent in tmux seeded with
 *  the typed prompt as its first message and drop the user into the browser terminal. No headless run
 *  is launched — this lane is driven by hand; closing the tab leaves the session running (tmux
 *  persists). Returns the new branch so the caller can navigate to its Terminal tab. */
export async function startInteractive(repo: string, prompt: string, provider: AgentProvider): Promise<{ branch: string }> {
  const { branch, worktreePath, title } = await api.createWorktree(repo, prompt, provider);
  patchEnrich(repo, branch, { prompt, title, agentProvider: provider, createdAt: now() });
  const seedFile = (await api.handoff(repo, branch, prompt)).path; // the typed prompt = the opening message
  await api.ensureTerminal(repo, { branch, worktreePath, provider, fresh: true, seedFile });
  await refresh();
  return { branch };
}

export function rerunAgent(row: Row) {
  if (!row.worktreePath) return Promise.resolve();
  const latest = row.agentOutcome ?? row.transcript?.at(-1)?.structured;
  return launchOnRow(row, row.worktreePath, rerunFailedPrompt({ original: row.prompt, error: row.agentError, outcome: latest }), providerFor(row), { action: "rerun" }).then(refresh);
}

export async function promote(row: Row, opts?: { draft?: boolean; labels?: string[] }) {
  if (!row.worktreePath) return;
  if (row.hasRemote) {
    const outcome = row.agentOutcome ?? row.transcript?.slice().reverse().find((turn) => turn.structured)?.structured;
    const { provider, sessionId } = resumeTarget(row); // PR body written by the pinned agent
    await api.promote(row.repo, {
      worktreePath: row.worktreePath, branch: row.branch, title: row.title,
      provider, task: row.prompt, sessionId, outcome,
      draft: opts?.draft, labels: opts?.labels,
    });
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
  return worktreePath;
}

/** Check out the branch locally (if needed) and spin up its preview services. Returns the preview
 *  key (the worktree path) so the caller can poll/stop it. */
export async function testLocally(row: Row): Promise<{ key: string; svcs: PreviewSvc[] }> {
  const worktreePath = await ensureWorktree(row);
  return { key: worktreePath, svcs: await api.preview(row.repo, worktreePath, worktreePath) };
}

// ---- master previews ("test master": preview a repo's base branch itself) ----
// The whole lifecycle lives HERE, as module state, not in the popover's components. The popover
// unmounts its rows every time it closes, so any state held there is lost mid-spin-up — which is
// why the preview "reset" on click-off. Keeping it in the store (polled at module level, read via
// useSyncExternalStore) means the detached preview keeps running AND the UI reconnects to it, and
// lets the always-mounted menu trigger reflect a spinner/badge without the popover being open.
export type MasterPreview = { key?: string; svcs: PreviewSvc[]; busy: boolean; error: string | null };
const EMPTY_MASTER: MasterPreview = { svcs: [], busy: false, error: null };
const masters = new Map<string, MasterPreview>();
const masterTimers = new Map<string, ReturnType<typeof setInterval>>();

export const useMaster = (repo: string): MasterPreview =>
  useSyncExternalStore(subscribe, () => masters.get(repo) ?? EMPTY_MASTER);
/** Snapshot of every repo's master preview — for the menu trigger's aggregate spinner/badge. */
export const useMasters = (): MasterPreview[] => useSyncExternalStore(subscribe, mastersSnapshot);
let mastersCache: { key: number; value: MasterPreview[] } = { key: -1, value: [] };
function mastersSnapshot(): MasterPreview[] {
  // Stable reference between notifies (useSyncExternalStore compares with Object.is), rebuilt only
  // when `version` bumps — so the trigger re-renders on real changes, not on every poll of an unrelated row.
  if (mastersCache.key !== version) mastersCache = { key: version, value: [...masters.values()] };
  return mastersCache.value;
}

// Immutable update: replace the entry (never mutate in place) so useSyncExternalStore sees the change.
const setMaster = (repo: string, patch: Partial<MasterPreview>) => {
  masters.set(repo, { ...(masters.get(repo) ?? EMPTY_MASTER), ...patch });
  notify();
};

function pollMaster(repo: string) {
  if (masterTimers.has(repo)) return; // already polling this repo
  const tick = async () => {
    const key = masters.get(repo)?.key;
    if (!key) return;
    let svcs: PreviewSvc[];
    try { svcs = await api.previewStatus(key); } catch { return; }
    if (masters.get(repo)?.key !== key) return; // stopped/restarted while in flight
    const crashed = svcs.find((s) => !s.running);
    // A crashed service leaves its siblings running + ports held; reap the whole group and surface
    // the log, dropping back to Retry — mirrors the old per-row auto-reap.
    if (crashed) void stopMaster(repo, crashed.error ?? "a service failed to start");
    else setMaster(repo, { svcs });
  };
  masterTimers.set(repo, setInterval(() => void tick(), 2500));
  void tick();
}

/** Spin up (or restart) a preview of the repo's base branch. Sets `busy` immediately so the trigger
 *  spins the instant it's clicked, then polls in the background until stopped. */
export async function startMaster(repo: string): Promise<void> {
  setMaster(repo, { busy: true, error: null, svcs: [] });
  try {
    const { worktreePath, svcs } = await api.previewMaster(repo);
    setMaster(repo, { key: worktreePath, svcs, busy: false });
    pollMaster(repo);
  } catch (e) {
    setMaster(repo, { busy: false, svcs: [], error: e instanceof Error ? e.message : String(e) });
  }
}

/** Tear down a repo's base preview (manual Stop, or an auto-reap after a crash carries the error). */
export async function stopMaster(repo: string, error: string | null = null): Promise<void> {
  const t = masterTimers.get(repo);
  if (t) { clearInterval(t); masterTimers.delete(repo); }
  const key = masters.get(repo)?.key;
  setMaster(repo, { key: undefined, svcs: [], busy: false, error });
  if (key) { try { await api.previewStop(key); } catch { /* already gone */ } }
}

/** Launch a follow-up agent run in the PR's worktree (adopting one if needed), resuming its session. */
/** Cap on the per-branch follow-up history — enough to walk with ↑, small enough to stay tiny. */
const FOLLOWUP_HISTORY = 25;

export async function followUp(
  row: Row,
  instruction: string,
  images: File[] = [],
  options: { provider?: AgentProvider } = {},
) {
  // Record the SENT prompt in enrichment first thing — before the upload/adopt/launch, any of which
  // can throw (a failed worktree adopt, a claude launch error) or "succeed" only to have the headless
  // run error moments later. Kept until the branch is merged/discarded (deleteEnrich wipes the key),
  // so a follow-up is never lost to a downstream failure, and ↑ in the composer can resend it.
  const prev = enrichOf(row.repo, row.branch).followUps ?? [];
  const followUps = prev.at(-1) === instruction ? prev : [...prev, instruction].slice(-FOLLOWUP_HISTORY);
  patchEnrich(row.repo, row.branch, { followUps });
  const paths = images.length ? await api.uploadAttachments(images) : [];
  const wt = await ensureWorktree(row);
  await launchOnRow(row, wt, withAttachments(followUpPrompt(instruction), paths), options.provider ?? providerFor(row), { action: "followup" });
  await refresh();
}

/** Continue natively when possible; otherwise create a target-provider session with portable history. */
const CONTEXT_RESET_PCT = 80;
async function launchOnRow(row: Row, worktree: string, prompt: string, provider: AgentProvider, ledger: { action?: string; evidenceChars?: number } = {}) {
  const current = enrichOf(row.repo, row.branch);
  const from = current.agentProvider ?? row.agentProvider;
  const sessionId = current.sessionId ?? row.sessionId;
  const contextTooFull = typeof row.agentMeta?.contextPct === "number" && row.agentMeta.contextPct >= CONTEXT_RESET_PCT;
  const transcript = current.transcript ?? row.transcript ?? [];
  const nativeTurns = sessionId ? transcript.filter((turn) => turn.provider === provider && turn.sessionId === sessionId) : [];
  const repeatedFailures = nativeTurns.slice(-3).length === 3 && nativeTurns.slice(-3).every((turn) => turn.failed);
  // Codex and Cursor report token usage but not their context-window occupancy.
  // Reset only on observable bounded history, never a fabricated percentage.
  const portableReset = provider !== "claude" && (nativeTurns.length >= 12 || repeatedFailures);
  const sameNativeSession = from === provider && Boolean(sessionId) && !contextTooFull && !portableReset;
  const receipt = await api.agent(row.repo, worktree, prompt, {
    worktree,
    provider,
    branch: row.branch,
    action: ledger.action,
    evidenceChars: ledger.evidenceChars,
    resume: sameNativeSession ? sessionId : undefined,
    history: !sameNativeSession ? transcript : undefined,
    handoffFrom: !sameNativeSession ? from : undefined,
  });
  // Switch the active native-session pointer immediately. Its new id arrives on the next poll.
  patchEnrich(row.repo, row.branch, { agentProvider: provider, sessionId: receipt.sessionId });
  return receipt;
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

export async function disableAutoMerge(row: Row) {
  if (!row.prNumber) return;
  await api.disableAutoMerge(row.repo, row.prNumber);
  await refresh();
}

export async function merge(row: Row) {
  if (row.prNumber) await api.merge(row.repo, row.prNumber, row.worktreePath);
  else await api.mergeLocal(row.repo, row.branch, row.worktreePath);
  deleteEnrich(row.repo, row.branch); // the branch is done — drop its enrichment (Done cards render from gh data, not enrichment)
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

export async function sendSlack(row: Row, kind: "notify" | "bump") {
  const ws = { title: row.title, prNumber: row.prNumber ?? 0, prUrl: row.prUrl };
  // One path for every provider: post the message VERBATIM from your identity via chat.postMessage
  // (server-side). On failure, copy the message so it isn't lost, then rethrow so the UI shows the
  // error — a post that didn't land must never be stamped as notified.
  try {
    await api.slack(row.repo, slackApiText(ws, kind));
  } catch (e) {
    const { text, html } = slackClipboard(ws, kind);
    // Prefer a rich write (text/html) so Slack pastes a real hyperlink; fall back to plain text on
    // browsers without ClipboardItem or when the write is blocked.
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch { /* clipboard unavailable — the error below is still surfaced */ }
    throw e instanceof Error ? e : new Error(String(e));
  }
  patchEnrich(row.repo, row.branch, kind === "notify" ? { slackNotifiedAt: now() } : { slackLastBumpedAt: now() });
}

export async function resolveConflicts(row: Row) {
  const wt = await ensureWorktree(row); // spin up a worktree for the PR if there isn't one yet
  await launchOnRow(row, wt, resolveConflictsPrompt({ branch: row.branch }, baseBranch(row.repo)), providerFor(row), { action: "conflict" });
  await refresh();
}

export function addPreviewLabel(row: Row) {
  if (!row.prNumber) return Promise.resolve();
  return api.addPreviewLabel(row.repo, row.prNumber);
}

export async function fixCi(row: Row) {
  const wt = await ensureWorktree(row); // spin up a worktree for the PR if there isn't one yet
  const details = row.prNumber ? await api.ciEvidence(row.repo, row.prNumber).catch(() => []) : [];
  await launchOnRow(row, wt, resolveCiPrompt({ prNumber: row.prNumber ?? 0, branch: row.branch }, row.failingChecks, details), providerFor(row), { action: "ci", evidenceChars: JSON.stringify(details).length });
  await refresh();
}

/** Fetch unresolved inline threads immediately before launch. Manual runs include all current
 * threads; Follow sends only newly actionable IDs and records them only after launch acceptance. */
export async function addressReview(row: Row, manual = true) {
  const wt = await ensureWorktree(row);
  const collected = row.prNumber ? await api.reviewEvidence(row.repo, row.prNumber).catch(() => undefined) : undefined;
  const enrichment = enrichOf(row.repo, row.branch);
  const handed = new Set(enrichment.handedReviewThreadIds ?? []);
  const threads = collected?.filter((thread) => manual || !handed.has(thread.id));
  if (!manual && collected?.length && !threads?.length) return; // unchanged unresolved state
  const marked = (threads ?? []).map((thread) => ({ ...thread, alreadyHanded: handed.has(thread.id) }));
  await launchOnRow(
    row, wt,
    addressReviewPrompt({ prNumber: row.prNumber ?? 0, branch: row.branch }, row.feedback, marked),
    providerFor(row),
    { action: "review", evidenceChars: JSON.stringify(marked).length },
  );
  if (threads?.length) {
    patchEnrich(row.repo, row.branch, { handedReviewThreadIds: [...new Set([...handed, ...threads.map((thread) => thread.id)])].slice(-100) });
  }
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
