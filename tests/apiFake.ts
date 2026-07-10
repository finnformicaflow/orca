// A shared, test-controllable fake of the browser api layer (web/src/api.ts), installed as a bun
// test PRELOAD (see bunfig.toml). The store binds `api` and reads config exactly once at module
// load, and other test files import the store (via Board) before any single test's setup runs — so
// the mock has to beat every import, which only a preload guarantees. Tests drive it through the
// exported `apiFake` handle. Files that never call the browser api are unaffected; server tests
// don't import this module at all.
import { mock } from "bun:test";

export const apiFake = {
  worktrees: new Map<string, { branch: string; worktreePath: string }>(),
  // Held resolver for createWorktree, so a test can assert the optimistic card while the "server"
  // is still working, then hand back a real branch.
  pending: null as null | ((v: { branch: string; worktreePath: string; title: string }) => void),
  calls: [] as string[],
  // Diffstat served by api.summary (the card polls it) — tests set this before mounting a card.
  summaryData: null as null | { files: unknown[]; commits: unknown[]; additions: number; deletions: number },
  // Open PRs served by api.prs (the board's source of truth) — tests set this before mounting.
  prsData: [] as unknown[],
  // Override for api.agents: when set, returned verbatim (lets a test drive a done run with a result).
  agentsData: null as null | unknown[],
  // Preview services served by api.previewMaster (on start) + api.previewStatus (the poll) — tests set
  // these to drive the Test-master menu through its ready state.
  previewSvcs: [] as unknown[],
  // When set, api.previewMaster rejects with it — the failed-start path (Retry + Log popover).
  previewMasterError: null as null | string,
  // Running previews served by api.previews (the running-previews menu) — keyed by worktree path.
  previewsData: [] as { key: string; svcs: unknown[] }[],
  // When set, api.previews rejects with it — the unreachable-endpoint path (e.g. a self-preview
  // whose bridge predates the /api/previews route and 404s).
  previewsError: null as null | string,
  // Prompts passed to api.claude (active-following fires agent actions through it) — tests assert
  // which action ran by matching the prompt text.
  claudePrompts: [] as string[],
  // When set, api.claude rejects with it — the failed-launch path (e.g. optimistic follow-up reopen).
  claudeError: null as null | string,
  // When true, api.claude blocks until releaseClaude() — lets a test assert the in-flight state
  // (e.g. the Follow up button's spinner) while the launch is still running.
  holdClaude: false,
  releaseClaude: null as null | (() => void),
  // Claude usage served by api.usage (the header meter) — null hides the widget (default).
  usageData: null as null | { fiveHour: { utilization: number; resetsAt: string | null }; sevenDay: { utilization: number; resetsAt: string | null }; extra?: { usedMinor: number; limitMinor: number; currency: string; exponent: number; utilization: number } | null },
  reset() { this.worktrees.clear(); this.pending = null; this.calls = []; this.summaryData = null; this.prsData = []; this.agentsData = null; this.previewSvcs = []; this.previewMasterError = null; this.previewsData = []; this.previewsError = null; this.claudePrompts = []; this.claudeError = null; this.holdClaude = false; this.releaseClaude = null; this.usageData = null; },
};

mock.module("@/api", () => ({
  api: {
    config: async () => ({ repos: [{ name: "r", baseBranch: "main", hasRemote: false }], staleHours: 24 }),
    usage: async () => apiFake.usageData,
    agents: async () => apiFake.agentsData ?? [...apiFake.worktrees.values()].map((w) => ({ ...w, agentStatus: "running" as const })),
    prs: async () => apiFake.prsData,
    mergedPrs: async () => [],
    createWorktree: () =>
      new Promise((resolve) => { apiFake.pending = (v) => { apiFake.worktrees.set(v.branch, { branch: v.branch, worktreePath: v.worktreePath }); resolve(v); }; }),
    runAgent: async () => { apiFake.calls.push("runAgent"); return { status: "ok" }; },
    uploadAttachments: async () => [],
    discardWorktree: async (_repo: string, _wt: string, branch?: string) => {
      apiFake.calls.push(`discard:${branch}`); if (branch) apiFake.worktrees.delete(branch); return { ok: true };
    },
    previewMaster: async (repo: string) => {
      apiFake.calls.push(`previewMaster:${repo}`);
      if (apiFake.previewMasterError) throw new Error(apiFake.previewMasterError);
      return { worktreePath: `/wt/${repo}-main`, svcs: apiFake.previewSvcs };
    },
    previewStop: async (key: string) => { apiFake.calls.push(`previewStop:${key}`); apiFake.previewsData = apiFake.previewsData.filter((p) => p.key !== key); return { ok: true }; },
    previewStatus: async () => apiFake.previewSvcs,
    previews: async () => { if (apiFake.previewsError) throw new Error(apiFake.previewsError); return apiFake.previewsData; },
    summary: async () => apiFake.summaryData,
    adopt: async (_repo: string, branch: string) => {
      const worktreePath = `/wt/${branch}`; apiFake.worktrees.set(branch, { branch, worktreePath }); return { branch, worktreePath };
    },
    claude: async (_repo: string, key: string, prompt: string) => {
      apiFake.calls.push(`claude:${key}`); apiFake.claudePrompts.push(prompt);
      if (apiFake.claudeError) throw new Error(apiFake.claudeError);
      if (apiFake.holdClaude) await new Promise<void>((resolve) => { apiFake.releaseClaude = resolve; });
      return { status: "ok" };
    },
  },
}));
