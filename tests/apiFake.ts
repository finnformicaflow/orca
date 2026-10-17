// A shared, test-controllable fake of the browser api layer (web/src/api.ts), installed as a bun
// test PRELOAD (see bunfig.toml). The store binds `api` and reads config exactly once at module
// load, and other test files import the store (via Board) before any single test's setup runs — so
// the mock has to beat every import, which only a preload guarantees. Tests drive it through the
// exported `apiFake` handle. Files that never call the browser api are unaffected; server tests
// don't import this module at all.
import { mock } from "bun:test";
import type { AgentOutcome, AgentProvider, AgentTurn } from "../shared/agent";
import type { CiFailureEvidence, ConversationComment, ReviewThreadEvidence } from "../server/gh";
import { workstreamShots, type MechanicalMerge } from "../web/src/workstream";

// Chains onto any launch already held, so one releaseClaude() frees them all.
async function holdLaunch() {
  await new Promise<void>((resolve) => { const prev = apiFake.releaseClaude; apiFake.releaseClaude = () => { prev?.(); resolve(); }; });
  if (apiFake.claudeError) throw new Error(apiFake.claudeError);
}

export const apiFake = {
  worktrees: new Map<string, { branch: string; worktreePath: string }>(),
  // Held resolver for createWorktree, so a test can assert the optimistic card while the "server"
  // is still working, then hand back a real branch.
  pending: null as null | ((v: { branch: string; worktreePath: string; title: string }) => void),
  calls: [] as string[],
  compactError: null as string | null, // api.compact rejects with this (e.g. the bridge's busy 409)
  mergeError: null as string | null, // api.merge rejects with this (e.g. GitHub refusing the merge)
  // Diffstat served by api.summary (the card polls it) — tests set this before mounting a card.
  summaryData: null as null | { files: unknown[]; commits: unknown[]; additions: number; deletions: number },
  // Unified diff served by api.localDiff / api.prDiff (the Files-changed tabs).
  diffText: "",
  // PR detail served by api.prDetail (the PR page) — overrides the minimal default below.
  prDetailData: null as null | Record<string, unknown>,
  prDetailError: null as string | null, // the PR page's load fails with this (error + Retry)
  // When true, api.prDetail blocks until releasePrDetail() — lets a test assert the CI chip's
  // hover card shows "Loading checks…" (not "No checks.") while the lazy fetch is still in flight.
  holdPrDetail: false,
  releasePrDetail: null as null | (() => void),
  // Open PRs served by api.prs (the board's source of truth) — tests set this before mounting.
  prsData: [] as unknown[],
  // When set, api.prs rejects — lets a GC test simulate a transient poll failure (must NOT prune).
  prsError: null as null | string,
  // When true, api.prs blocks until releasePrs() — lets a test settle the agents stream first and
  // prove the board doesn't paint a partial (worktree-but-no-PR) view.
  holdPrs: false,
  releasePrs: null as null | (() => void),
  // Override for api.agents: when set, returned verbatim (lets a test drive a done run with a result).
  agentsData: null as null | unknown[],
  // Preview services served by api.previewMaster (on start) + api.previewStatus (the poll) — tests set
  // these to drive the Test-master menu through its ready state.
  previewSvcs: [] as unknown[],
  // When set, api.previewMaster rejects with it — the failed-start path (Retry + Log popover).
  previewMasterError: null as null | string,
  // Running previews served by api.previews (the running-previews menu) — keyed by worktree path.
  previewsData: [] as { key: string; instance?: string; svcs: unknown[] }[],
  // When set, api.previews rejects with it — the unreachable-endpoint path (e.g. a self-preview
  // whose bridge predates the /api/previews route and 404s).
  previewsError: null as null | string,
  // Prompts passed to the agent APIs (active-following fires agent actions through them) — tests assert
  // which action ran by matching the prompt text.
  claudePrompts: [] as string[],
  agentLaunches: [] as { key: string; prompt: string; provider: AgentProvider; resume?: string; history?: unknown[]; handoffFrom?: AgentProvider; model?: string; instance?: string }[],
  handoffs: [] as { branch: string; content: string }[],
  slackSends: [] as { repo: string; text: string }[],
  slackPosted: true, // when false, api.slack throws (post failed) → the client copies the message
  // Rename flow: title AI-suggest returns this; rename() calls are captured for assertions.
  suggestTitleReply: "Suggested Name",
  suggestTitleCalls: [] as { provider: AgentProvider; prompt?: string; pr?: number; branch?: string; worktreePath?: string }[],
  renames: [] as { branch: string; title: string; pr?: number }[],
  titleProviders: [] as AgentProvider[],
  createWorktreeCalls: [] as { repo: string; instance?: string }[],
  adoptCalls: [] as { repo: string; branch: string; instance?: string }[],
  previewCalls: [] as { key: string; instance?: string }[],
  // Where each preview status poll / stop was sent (the instance the store resolved for its key).
  previewStatusCalls: [] as { key: string; instance?: string }[],
  previewStopCalls: [] as { key: string; instance?: string }[],
  previewStopError: null as string | null, // when set, api.previewStop throws (the Stop button's error toast)
  // When true, api.usage blocks until releaseUsage() — the Usage card's loading-skeleton state.
  holdUsage: false,
  releaseUsage: null as null | (() => void),
  healthData: null as null | Record<string, unknown>,
  healthHistoryData: [] as Record<string, unknown>[],
  healthHistoryCalls: [] as { instance: string; hours?: number }[],
  // When true, api.healthHistory blocks until releaseHealthHistory() — a slow history call.
  holdHealthHistory: false,
  releaseHealthHistory: null as null | (() => void),
  // When true (set BEFORE the store is imported), api.config blocks until releaseConfig() — lets a
  // test mount the header before config has landed, the way a real first paint does.
  holdConfig: false,
  releaseConfig: null as null | (() => void),
  promotions: [] as { provider: AgentProvider; task?: string; sessionId?: string; outcome?: AgentOutcome; body?: string }[],
  reviewEvidenceData: [] as ReviewThreadEvidence[],
  prCommentsData: [] as ConversationComment[],
  // api.reviewSignal (the review cluster / Review panel) serves the threads and comments above,
  // as the PR authored by `reviewSignalAuthor`; `reviewSignalCalls` counts the lazy fetches.
  reviewSignalAuthor: "me" as string | undefined,
  reviewSignalCalls: [] as string[],
  reviewEvidenceError: null as string | null,
  // What api.settleConflict (Orca's own merge of the base, before Address PR / Resolve conflicts)
  // answers; every call's branch is recorded.
  settleResult: { outcome: "conflict", files: [] } as { outcome: MechanicalMerge; files: string[] },
  settleCalls: [] as string[],
  ciEvidenceData: [] as CiFailureEvidence[],
  ciEvidenceError: null as string | null,
  // The bridge's durable enrichment + chat history (server/db.ts), keyed `repo::branch`. Tests seed
  // and assert against this instead of localStorage — it stands in for the DB, not for a cache.
  enrichmentData: new Map<string, Record<string, unknown>>(),
  stopped: [] as string[],
  // The notification centre's rows (api.notifications) and what was marked read.
  notificationsData: [] as Record<string, unknown>[],
  notificationCalls: [] as { verb: "read"; ids: number[] | "all" }[],
  notificationFetches: [] as (number | undefined)[],
  // The orchestrator's status (api.orchestrator) and what was typed to it (api.orchestratorMessage).
  orchestratorState: { key: "/state/orchestrator", running: false, paused: false, notes: "", model: "claude-fable-5-1" } as { key: string; running: boolean; paused: boolean; notes: string; model: string; contextPct?: number; lastWakeUsd?: number; hint?: string; startedAt?: number; queued?: number },
  orchestratorMessages: [] as { text: string; attachments: string[] }[],
  // api.uploadAttachments's answer — the refs a test wants the next upload to resolve to.
  uploadAttachmentsResult: [] as string[],
  orchestratorMessageError: null as string | null, // api.orchestratorMessage rejects with this (a bridge that is down)
  // Per-call latency (ms), consumed in call order: a message is recorded when it ARRIVES, so a slow
  // first send and a fast second one would land swapped unless the client chains them.
  orchestratorMessageDelays: [] as number[],
  // Steps the chat's tail will serve, keyed by runId, and which runs have completed.
  turnStepsData: new Map<string, unknown[]>(),
  // Instructions held because a run was in flight, keyed by branch.
  queuedData: new Map<string, unknown[]>(),
  turnFinished: new Set<string>(),
  turnsData: new Map<string, unknown[]>(),
  turnPageCalls: [] as { branch: string; limit: number; before?: string }[],
  /** The bridge answered without its database (the turns are its local journal). */
  turnPageDbUnavailable: false,
  // Hold turn-page answers: each is computed at CALL time (what the database said then) and released
  // later by the test, in any order — a slow fetch overtaken by a newer one.
  holdTurnPages: false,
  heldTurnPages: [] as (() => void)[],
  // When set, importEnrichment rejects — the migration must then KEEP the browser's blob, since it
  // is the only copy of that history.
  importError: null as null | string,
  // When true, patchEnrichment blocks until releaseEnrichmentWrites() — lets a test land a poll
  // BETWEEN an optimistic mirror write and its server round-trip.
  holdEnrichmentWrites: false,
  releaseEnrichmentWrites: null as null | (() => void),
  // When set, agent launch rejects with it — the failed-launch path (e.g. optimistic follow-up reopen).
  claudeError: null as null | string,
  // When true, api.claude blocks until releaseClaude() — lets a test assert the in-flight state
  // (e.g. the Follow up button's spinner) while the launch is still running. releaseClaude frees
  // EVERY held launch, and claudeError is read again after it, so a held launch can fail.
  holdClaude: false,
  releaseClaude: null as null | (() => void),
  // When set, api.agent/api.claude answer `{ status: "queued" }` instead of launching — simulates
  // the bridge finding an agent already running for the worktree (server/index.ts's /api/agent).
  agentQueued: null as null | { id: number; repo: string; branch: string; worktreePath: string; instruction: string; attachments: string[]; createdAt: number },
  // Provider usage served by api.usage (the header meter) — null hides the widget (default).
  usageData: null as null | {
    claude: null | { fiveHour: { utilization: number; resetsAt: string | null }; sevenDay: { utilization: number; resetsAt: string | null }; extra: { usedMinor: number; limitMinor: number; currency: string; exponent: number; utilization: number } | null };
    codex: null | { windows: { label: string; durationMinutes: number | null; utilization: number; resetsAt: string | null }[] };
    profiles?: {
      name: string; usage: null | { fiveHour: { utilization: number; resetsAt: string | null }; sevenDay: { utilization: number; resetsAt: string | null }; extra: null; fable?: { utilization: number; resetsAt: string | null } | null };
      state?: string; email?: string; instance?: string; hosts?: { instance: string; state?: string }[];
    }[];
    routing?: { hydra: boolean; shim: boolean; bin?: string };
  },
  // The Usage card's hover switch: POST /api/usage/profile. A set error rejects the call; otherwise
  // the matching profile in usageData flips state and the refreshed list is handed back, same as the
  // real route.
  setProfileEnabledCalls: [] as { name: string; enabled: boolean; instance?: string }[],
  setProfileEnabledError: null as null | string,
  // When true, api.setProfileEnabled blocks until its call's turn is released (FIFO queue) — lets a
  // test observe the optimistic flip before the request settles, and release two in-flight calls in
  // either order to prove a stale response never clobbers a newer click.
  holdSetProfileEnabled: false,
  setProfileEnabledReleasers: [] as (() => void)[],
  // The Stale row's fix: POST /api/usage/refresh. Same shape as setProfileEnabled — a set error
  // rejects the call; otherwise the matching profile's state clears to "ok" and the refreshed list
  // is handed back.
  refreshProfileCalls: [] as { name: string; instance?: string }[],
  refreshProfileError: null as null | string,
  // Simulates a refresh token that has itself expired: `hydra refresh --force` exits clean (no
  // error thrown) but the profile's state is still "token stale" on the re-read.
  refreshProfileStaysStale: false,
  instanceRates: {} as Record<string, number>,
  setInstanceRateCalls: [] as { instance: string; hourlyUsd: number | null }[],
  setInstanceTerminalCalls: [] as { instance: string; on: boolean }[],
  githubAccounts: [] as import("../web/src/api").GithubAccount[],
  setGithubAccountCalls: [] as { login: string; name?: string; email?: string }[],
  // The unified inbox: the page /api/inbox answers (filtered here like the server does), each
  // conversation's thread, and the thread links behind the cards' source chips.
  inboxData: null as import("../web/src/api").InboxPage | null,
  inboxCalls: [] as { before?: string; source?: string; person?: string }[],
  inboxThreads: new Map<string, import("../web/src/api").InboxThread>(),
  threadLinksData: [] as import("../shared/inbox").ThreadLinkRecord[],
  inboxActions: [] as unknown[][],
  inboxReplyError: null as string | null,
  reset() { this.inboxData = null; this.inboxCalls = []; this.inboxThreads.clear(); this.threadLinksData = []; this.inboxActions = []; this.inboxReplyError = null; this.worktrees.clear(); this.pending = null; this.calls = []; this.compactError = null; this.mergeError = null; this.summaryData = null; this.diffText = ""; this.prDetailData = null; this.prDetailError = null; this.holdPrDetail = false; this.releasePrDetail = null; this.prsData = []; this.prsError = null; this.holdPrs = false; this.releasePrs = null; this.agentsData = null; this.previewSvcs = []; this.previewMasterError = null; this.previewsData = []; this.previewsError = null; this.claudePrompts = []; this.agentLaunches = []; this.handoffs = []; this.slackSends = []; this.slackPosted = true; this.suggestTitleReply = "Suggested Name"; this.suggestTitleCalls = []; this.renames = []; this.titleProviders = []; this.createWorktreeCalls = []; this.adoptCalls = []; this.previewCalls = []; this.previewStatusCalls = []; this.previewStopCalls = []; this.previewStopError = null; this.holdUsage = false; this.releaseUsage = null; this.healthData = null; this.healthHistoryData = []; this.healthHistoryCalls = []; this.holdHealthHistory = false; this.releaseHealthHistory = null; this.promotions = []; this.reviewEvidenceData = []; this.reviewEvidenceError = null; this.prCommentsData = []; this.reviewSignalAuthor = "me"; this.reviewSignalCalls = []; this.ciEvidenceData = []; this.ciEvidenceError = null; this.settleResult = { outcome: "conflict", files: [] }; this.settleCalls = []; this.claudeError = null; this.holdClaude = false; this.releaseClaude = null; this.agentQueued = null; this.usageData = null; this.enrichmentData.clear(); this.turnsData.clear(); this.turnPageCalls = []; this.turnPageDbUnavailable = false; this.holdTurnPages = false; this.heldTurnPages = []; this.stopped = []; this.orchestratorState = { key: "/state/orchestrator", running: false, paused: false, notes: "", model: "claude-fable-5-1" }; this.orchestratorMessages = []; this.uploadAttachmentsResult = []; this.orchestratorMessageError = null; this.orchestratorMessageDelays = []; this.notificationsData = []; this.notificationCalls = []; this.notificationFetches = []; this.turnStepsData.clear(); this.turnFinished.clear(); this.queuedData.clear(); this.importError = null; this.holdEnrichmentWrites = false; this.releaseEnrichmentWrites = null; this.setProfileEnabledCalls = []; this.setProfileEnabledError = null; this.holdSetProfileEnabled = false; this.setProfileEnabledReleasers = []; this.refreshProfileCalls = []; this.refreshProfileError = null; this.refreshProfileStaysStale = false; this.instanceRates = {}; this.setInstanceRateCalls = []; this.setInstanceTerminalCalls = []; this.githubAccounts = []; this.setGithubAccountCalls = []; },
};

mock.module("@/api", () => ({
  api: {
    // Two instances, so the cards' instance chip and "Move to" control render in tests. Previews
    // on by default (RepoFeatures.previews) — a row with a repo absent from this list (e.g. "nopreview"
    // in tests) reads as previews-disabled, since there's no config entry to say otherwise.
    config: async () => { if (apiFake.holdConfig) await new Promise<void>((r) => { apiFake.releaseConfig = r; }); return ({ repos: [{ name: "r", baseBranch: "main", hasRemote: false, features: { previews: true } }], staleHours: 24, agentProviders: ["claude", "codex", "cursor"], apiPort: 8787, instance: "laptop", instances: ["cloud"], instanceUrls: { cloud: "http://100.64.0.5:8787" }, instanceHourlyUsd: { ...apiFake.instanceRates } }); },
    githubAccounts: async () => ({ accounts: apiFake.githubAccounts }),
    inbox: async (q: { before?: string; source?: string; person?: string; unread?: boolean; muted?: boolean } = {}) => {
      apiFake.inboxCalls.push(q);
      const page = apiFake.inboxData ?? { rows: [], facets: { sources: [], people: [], unread: 0, muted: 0 }, older: null };
      const { filterInbox } = await import("../shared/inbox");
      return { ...page, rows: filterInbox(page.rows, q) };
    },
    inboxThread: async (c: string) => {
      const t = apiFake.inboxThreads.get(c);
      if (!t) throw new Error("no such conversation");
      return t;
    },
    threadLinks: async () => ({ links: apiFake.threadLinksData }),
    // The inbox's actions mutate inboxData the way the bridge's tables would.
    inboxReply: async (eventId: string, text: string) => {
      apiFake.inboxActions.push(["reply", eventId, text]);
      if (apiFake.inboxReplyError) throw new Error(apiFake.inboxReplyError);
      return { eventId: "reply-1", delivery: 1 };
    },
    inboxRead: async (ids: string[], read = true) => {
      apiFake.inboxActions.push(["read", ids, read]);
      if (apiFake.inboxData) apiFake.inboxData = { ...apiFake.inboxData, rows: apiFake.inboxData.rows.map((r) => ids.includes(r.id) ? { ...r, read } : r) };
      for (const [k, t] of apiFake.inboxThreads) apiFake.inboxThreads.set(k, { ...t, unread: read ? t.unread.filter((id) => !ids.includes(id)) : t.unread });
      return { ok: true as const };
    },
    inboxMute: async (eventId: string, muted: boolean) => { apiFake.inboxActions.push(["mute", eventId, muted]); return { ok: true as const }; },
    inboxLink: async (eventId: string, repo: string, branch: string) => { apiFake.inboxActions.push(["link", eventId, repo, branch]); return {}; },
    setGithubAccount: async (login: string, fields: { name?: string; email?: string }) => {
      apiFake.setGithubAccountCalls.push({ login, ...fields });
      apiFake.githubAccounts = apiFake.githubAccounts.map((a) => a.login === login ? { ...a, configured: { ...a.configured, ...fields }, name: fields.name || a.name, email: fields.email || a.email } : a);
      return { accounts: apiFake.githubAccounts };
    },
    setInstanceTerminal: async (instance: string, on: boolean) => { apiFake.setInstanceTerminalCalls.push({ instance, on }); return { ok: true as const }; },
    setInstanceRate: async (instance: string, hourlyUsd: number | null) => {
      apiFake.setInstanceRateCalls.push({ instance, hourlyUsd });
      if (hourlyUsd === null) delete apiFake.instanceRates[instance]; else apiFake.instanceRates[instance] = hourlyUsd;
      return { ok: true as const };
    },
    usage: async () => {
      if (apiFake.holdUsage) await new Promise<void>((resolve) => { apiFake.releaseUsage = () => { apiFake.holdUsage = false; resolve(); }; });
      return apiFake.usageData;
    },
    setProfileEnabled: async (name: string, enabled: boolean, instance?: string) => {
      apiFake.setProfileEnabledCalls.push({ name, enabled, instance });
      if (apiFake.holdSetProfileEnabled) await new Promise<void>((resolve) => apiFake.setProfileEnabledReleasers.push(resolve));
      if (apiFake.setProfileEnabledError) throw new Error(apiFake.setProfileEnabledError);
      const profiles = apiFake.usageData?.profiles?.map((p) => p.name === name ? { ...p, state: enabled ? "ok" : "disabled" } : p);
      if (profiles) apiFake.usageData = { ...apiFake.usageData!, profiles };
      return { profiles };
    },
    refreshProfile: async (name: string, instance?: string) => {
      apiFake.refreshProfileCalls.push({ name, instance });
      if (apiFake.refreshProfileError) throw new Error(apiFake.refreshProfileError);
      const nextState = apiFake.refreshProfileStaysStale ? "token stale — refreshes on next launch" : "ok";
      const profiles = apiFake.usageData?.profiles?.map((p) => p.name === name ? { ...p, state: nextState } : p);
      if (profiles) apiFake.usageData = { ...apiFake.usageData!, profiles };
      return { profiles };
    },
    notifications: async (since?: number) => { apiFake.notificationFetches.push(since); return apiFake.notificationsData.filter((n) => !since || Number(n.createdAt) > since); },
    notificationsRead: async (ids: number[] | "all") => { apiFake.notificationCalls.push({ verb: "read", ids }); return { ok: true, changed: 0 }; },
    agents: async () => apiFake.agentsData ?? [...apiFake.worktrees.values()].map((w) => ({ ...w, agentStatus: "running" as const })),
    prs: async () => {
      if (apiFake.holdPrs) await new Promise<void>((resolve) => { apiFake.releasePrs = () => { apiFake.holdPrs = false; resolve(); }; });
      if (apiFake.prsError) throw new Error(apiFake.prsError);
      return apiFake.prsData;
    },
    mergedPrs: async () => [],
    reviewSignal: async (repo: string, n: number) => {
      apiFake.reviewSignalCalls.push(`${repo}#${n}`);
      return { prAuthor: apiFake.reviewSignalAuthor, threads: apiFake.reviewEvidenceData, comments: apiFake.prCommentsData };
    },
    reviewEvidence: async () => { if (apiFake.reviewEvidenceError) throw new Error(apiFake.reviewEvidenceError); return apiFake.reviewEvidenceData; },
    // Mirrors the server's `since` filter so the seen-at bookkeeping is exercised end to end.
    prComments: async (_repo: string, _n: number, since?: string) => apiFake.prCommentsData.filter((c) => !since || c.createdAt > since),
    settleConflict: async (_repo: string, branch: string) => { apiFake.settleCalls.push(branch); return apiFake.settleResult; },
    ciEvidence: async () => { if (apiFake.ciEvidenceError) throw new Error(apiFake.ciEvidenceError); return apiFake.ciEvidenceData; },
    merge: async (_repo: string, pr: number) => { apiFake.calls.push(`merge:${pr}`); if (apiFake.mergeError) throw new Error(apiFake.mergeError); return { ok: true }; },
    autoMerge: async (_repo: string, pr: number) => { apiFake.calls.push(`autoMerge:${pr}`); return { ok: true }; },
    mergeWhenGreen: async (_repo: string, pr: number, branch?: string) => { apiFake.calls.push(`mergeWhenGreen:${pr}:${branch}`); return { text: "Queued" }; },
    markReady: async (_repo: string, pr: number) => { apiFake.calls.push(`markReady:${pr}`); return { ok: true }; },
    convertToDraft: async (_repo: string, pr: number) => { apiFake.calls.push(`convertToDraft:${pr}`); return { ok: true }; },
    disableAutoMerge: async (_repo: string, pr: number) => { apiFake.calls.push(`disableAutoMerge:${pr}`); return { ok: true }; },
    addPreviewLabel: async (_repo: string, pr: number) => { apiFake.calls.push(`addPreviewLabel:${pr}`); return { ok: true }; },
    closePr: async (_repo: string, pr: number) => { apiFake.calls.push(`closePr:${pr}`); return { ok: true }; },
    mergeLocal: async (_repo: string, branch: string) => { apiFake.calls.push(`mergeLocal:${branch}`); return { ok: true }; },
    promote: async (_repo: string, input: { provider: AgentProvider; task?: string; sessionId?: string; outcome?: AgentOutcome; body?: string }) => {
      apiFake.promotions.push(input); return { number: 42, url: "https://example.test/42" };
    },
    createWorktree: (_repo: string, _prompt: string, provider: AgentProvider = "claude", instance?: string) => {
      apiFake.titleProviders.push(provider);
      apiFake.createWorktreeCalls.push({ repo: _repo, instance });
      return new Promise((resolve) => { apiFake.pending = (v) => { apiFake.worktrees.set(v.branch, { branch: v.branch, worktreePath: v.worktreePath }); resolve(v); }; });
    },
    runAgent: async (_worktree: string, prompt: string, provider: AgentProvider = "claude", options: { model?: string; instance?: string } = {}) => {
      apiFake.calls.push("runAgent"); apiFake.agentLaunches.push({ key: _worktree, prompt, provider, model: options.model, instance: options.instance }); return { status: "ok" };
    },
    uploadAttachments: async () => apiFake.uploadAttachmentsResult,
    discardWorktree: async (_repo: string, _wt: string, branch?: string) => {
      apiFake.calls.push(`discard:${branch}`); if (branch) apiFake.worktrees.delete(branch); return { ok: true };
    },
    preview: async (repo: string, key: string, _worktree: string, instance?: string, branch?: string) => {
      apiFake.calls.push(`preview:${key}`); apiFake.previewCalls.push({ key, instance });
      // As the bridge does (verbs.startPreview): the starting instance records the placement.
      if (branch) {
        const k = `${repo}::${branch}`;
        apiFake.enrichmentData.set(k, { ...apiFake.enrichmentData.get(k), previewInstance: { instance: instance ?? "laptop", key, startedAt: new Date().toISOString() } });
      }
      return apiFake.previewSvcs;
    },
    previewMaster: async (repo: string) => {
      apiFake.calls.push(`previewMaster:${repo}`);
      if (apiFake.previewMasterError) throw new Error(apiFake.previewMasterError);
      return { worktreePath: `/wt/${repo}-main`, svcs: apiFake.previewSvcs };
    },
    previewStop: async (key: string, instance?: string) => {
      apiFake.calls.push(`previewStop:${key}`); apiFake.previewStopCalls.push({ key, instance });
      if (apiFake.previewStopError) throw new Error(apiFake.previewStopError);
      apiFake.previewsData = apiFake.previewsData.filter((p) => p.key !== key);
      // …and the stop clears it (db.clearPreviewPlacement).
      for (const [k, v] of apiFake.enrichmentData) {
        if ((v.previewInstance as { key?: string } | undefined)?.key === key) { const { previewInstance: _, ...rest } = v; apiFake.enrichmentData.set(k, rest); }
      }
      return { ok: true };
    },
    previewStatus: async (key: string, instance?: string) => { apiFake.previewStatusCalls.push({ key, instance }); return apiFake.previewSvcs; },
    previews: async () => { if (apiFake.previewsError) throw new Error(apiFake.previewsError); return apiFake.previewsData; },
    summary: async (_repo: string, worktree: string, base?: string) => { apiFake.calls.push(`summary:${worktree}:${base ?? ""}`); return apiFake.summaryData; },
    localDiff: async () => ({ diff: apiFake.diffText }),
    prDetail: async (_repo: string, n: number) => {
      apiFake.calls.push(`prDetail:${n}`);
      if (apiFake.holdPrDetail) await new Promise<void>((r) => { apiFake.releasePrDetail = () => { apiFake.holdPrDetail = false; r(); }; });
      if (apiFake.prDetailError) throw new Error(apiFake.prDetailError);
      return {
      number: n, title: `PR ${n}`, url: `https://example.test/${n}`, head: "sticky-1", base: "main", author: "me",
      additions: 1, deletions: 0, changedFiles: 1, state: "OPEN", checks: [], reviews: [], comments: [],
      ...apiFake.prDetailData,
      };
    },
    prDiff: async () => ({ diff: apiFake.diffText }),
    adopt: async (_repo: string, branch: string, instance?: string) => {
      apiFake.adoptCalls.push({ repo: _repo, branch, instance });
      const worktreePath = `/wt/${branch}`; apiFake.worktrees.set(branch, { branch, worktreePath }); return { branch, worktreePath };
    },
    enrichment: async (repo: string) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of apiFake.enrichmentData) {
        const sep = k.indexOf("::");
        if (k.slice(0, sep) === repo) out[k.slice(sep + 2)] = v;
      }
      return out;
    },
    suggestTitle: async (_repo: string, b: { provider: AgentProvider; prompt?: string; pr?: number; branch?: string; worktreePath?: string }) => {
      apiFake.suggestTitleCalls.push(b); return { title: apiFake.suggestTitleReply };
    },
    rename: async (_repo: string, b: { branch: string; title: string; pr?: number }) => {
      apiFake.renames.push(b); return { ok: true as const };
    },
    patchEnrichment: async (repo: string, branch: string, fields: Record<string, unknown>) => {
      if (apiFake.holdEnrichmentWrites) {
        await new Promise<void>((resolve) => { apiFake.releaseEnrichmentWrites = () => { apiFake.holdEnrichmentWrites = false; resolve(); }; });
      }
      const k = `${repo}::${branch}`;
      const current = { ...(apiFake.enrichmentData.get(k) ?? {}) };
      // null is the wire encoding for "delete this key" (JSON.stringify drops undefined).
      for (const [f, v] of Object.entries(fields)) { if (v === null) delete current[f]; else current[f] = v; }
      apiFake.enrichmentData.set(k, current);
      return { ok: true as const };
    },
    importEnrichment: async (entries: { repo: string; branch: string; fields: Record<string, unknown> }[]) => {
      if (apiFake.importError) throw new Error(apiFake.importError);
      let imported = 0;
      for (const e of entries) {
        const k = `${e.repo}::${e.branch}`;
        if (apiFake.enrichmentData.has(k)) continue;
        // Keep transcript in the blob (guard + handoff read it) AND surface it as turns (Chat tab).
        apiFake.enrichmentData.set(k, { ...e.fields });
        const transcript = (e.fields ?? {}).transcript;
        if (Array.isArray(transcript)) apiFake.turnsData.set(k, transcript);
        imported++;
      }
      return { imported };
    },
    turns: async (repo: string, branch: string) => apiFake.turnsData.get(`${repo}::${branch}`) ?? [],
    // The bridge's /api/shots: workstreamShots over the same turns.
    shots: async (repo: string, branch: string) => workstreamShots((apiFake.turnsData.get(`${repo}::${branch}`) ?? []) as AgentTurn[]),
    // Pages over turnsData in its stored order (oldest first); the cursor is the index of a page's
    // oldest turn, so a test can seed hundreds of turns and watch the chat walk back through them.
    turnPage: async (repo: string, branch: string, opts: { limit: number; before?: string }) => {
      apiFake.turnPageCalls.push({ branch, ...opts });
      const all = (apiFake.turnsData.get(`${repo}::${branch}`) ?? []) as unknown[];
      const end = opts.before === undefined ? all.length : Number(opts.before);
      const start = Math.max(0, end - opts.limit);
      const page = { turns: structuredClone(all.slice(start, end)), older: start > 0 ? String(start) : null, ...(apiFake.turnPageDbUnavailable ? { dbUnavailable: true } : {}) };
      if (apiFake.holdTurnPages) await new Promise<void>((resolve) => apiFake.heldTurnPages.push(resolve));
      return page;
    },
    // The tab's one live stream (stubbed EventSource in happydom.ts) plus the chats' catch-up.
    eventsUrl: () => "/api/events",
    queued: async (_repo: string, branch: string) => apiFake.queuedData.get(branch) ?? [],
    cancelQueued: async (_repo: string, id: number) => {
      for (const [b, list] of apiFake.queuedData) apiFake.queuedData.set(b, (list as { id: number }[]).filter((m) => m.id !== id));
      return { ok: true as const };
    },
    turnSteps: async (_repo: string, _branch: string, runId: string, since: number) => {
      const all = (apiFake.turnStepsData.get(runId) ?? []) as { seq: number; step: unknown }[];
      const fresh = all.filter((s) => s.seq > since);
      return {
        steps: fresh.map((s) => s.step),
        seq: fresh.length ? fresh[fresh.length - 1]!.seq : since,
        finished: apiFake.turnFinished.has(runId),
      };
    },
    stopAgent: async (key: string) => { apiFake.stopped.push(key); return { ok: true as const }; },
    compact: async (repo: string, branch: string) => {
      apiFake.calls.push(`compact:${repo}:${branch}`);
      if (apiFake.compactError) throw new Error(apiFake.compactError);
      return { runId: "run-compact" };
    },
    healthHistory: async (instance: string, hours?: number) => {
      apiFake.healthHistoryCalls.push({ instance, hours });
      if (apiFake.holdHealthHistory) await new Promise<void>((resolve) => { apiFake.releaseHealthHistory = () => { apiFake.holdHealthHistory = false; resolve(); }; });
      return apiFake.healthHistoryData;
    },
    health: async (instance?: string) => apiFake.healthData ?? { instance: instance ?? "cloud", hostname: "orca-box", cores: 4, cpuPct: 12, load1: 0.5, load5: 0.4, memUsedGb: 3.1, memTotalGb: 15.3, disk: { usedGb: 11, totalGb: 145 }, uptimeS: 90000, rate: { hourlyUsd: 0.2331, source: "estimate", instanceType: "m7i.xlarge", region: "eu-west-2" }, month: { usd: 5.52, upHours: 23.68, since: 0 }, at: Date.now() },
    orchestrator: async () => apiFake.orchestratorState,
    orchestratorModel: async (model: string) => { apiFake.orchestratorState = { ...apiFake.orchestratorState, model }; return { ok: true as const }; },
    orchestratorMessage: async (text: string, attachments: string[] = []) => {
      const delay = apiFake.orchestratorMessageDelays.shift();
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (apiFake.orchestratorMessageError) throw new Error(apiFake.orchestratorMessageError);
      // A busy orchestrator queues the message behind its wake (the bridge's own queue), never refuses it.
      apiFake.orchestratorMessages.push({ text, attachments }); return { status: apiFake.orchestratorState.running ? "queued" as const : "running" as const };
    },
    handoff: async (_repo: string, branch: string, content: string) => {
      apiFake.handoffs.push({ branch, content }); return { path: `/state/handoff/${branch}.md` };
    },
    slack: async (repo: string, text: string) => {
      apiFake.slackSends.push({ repo, text });
      if (!apiFake.slackPosted) throw new Error("Slack post failed: not_authed");
      return { ok: true as const };
    },
    claude: async (_repo: string, key: string, prompt: string) => {
      apiFake.calls.push(`claude:${key}`); apiFake.claudePrompts.push(prompt);
      if (apiFake.claudeError) throw new Error(apiFake.claudeError);
      if (apiFake.holdClaude) await holdLaunch();
      return { status: "ok" };
    },
    agent: async (_repo: string, key: string, prompt: string, options: { provider?: AgentProvider; resume?: string; history?: unknown[]; handoffFrom?: AgentProvider; model?: string } = {}) => {
      apiFake.calls.push(`agent:${key}`); apiFake.claudePrompts.push(prompt);
      apiFake.agentLaunches.push({ key, prompt, provider: options.provider ?? "claude", resume: options.resume, history: options.history, handoffFrom: options.handoffFrom, model: options.model });
      if (apiFake.agentQueued) return { status: "queued" as const, queued: apiFake.agentQueued };
      if (apiFake.claudeError) throw new Error(apiFake.claudeError);
      if (apiFake.holdClaude) await holdLaunch();
      return { status: "ok" };
    },
  },
}));
