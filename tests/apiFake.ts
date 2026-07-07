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
  reset() { this.worktrees.clear(); this.pending = null; this.calls = []; this.summaryData = null; this.prsData = []; this.agentsData = null; },
};

mock.module("@/api", () => ({
  api: {
    config: async () => ({ repos: [{ name: "r", baseBranch: "main", hasRemote: false }], staleHours: 24 }),
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
    previewStop: async () => ({ ok: true }),
    previewStatus: async () => [],
    summary: async () => apiFake.summaryData,
  },
}));
