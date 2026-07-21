import type { LaunchReceipt, RunMeta } from "../../server/agent";
import type { ChangeSummary } from "../../server/git";
import type { CiFailureEvidence, MergedPr, PrDetail, PrSummary, ReviewThreadEvidence } from "../../server/gh";
import type { Usage } from "../../server/usage";
import type { AgentOutcome, AgentProvider, AgentTurn } from "../../shared/agent";
import type { SyncResult } from "./workstream";

export type LiveAgent = {
  branch: string;
  worktreePath: string;
  agentStatus: "idle" | "running" | "done" | "error";
  agentError?: string;
  agentResult?: string;
  agentOutcome?: AgentOutcome;
  agentMeta?: RunMeta;
  agentStartedAt?: number;
  agentFinishedAt?: number;
  agentProvider?: AgentProvider;
  agentRunId?: string;
  agentPrompt?: string;
  sessionId?: string;
  mergeClean?: "clean" | "conflict";
  tmux?: boolean; // a live interactive tmux terminal exists for this worktree
};

export type PreviewSvc = { name: string; port: number; url: string; open: boolean; running: boolean; ready: boolean; error?: string; startedAt: number };

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(res);

async function res(r: Response) {
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `${r.status}`);
  return data;
}

export type RepoInfo = { name: string; baseBranch: string; slackChannel?: string; hasRemote: boolean; prLabels?: { name: string; default?: boolean }[] };
const q = (repo: string, extra = "") => `?repo=${encodeURIComponent(repo)}${extra}`;

export const api = {
  config: (): Promise<{ repos: RepoInfo[]; staleHours: number; agentProviders: AgentProvider[]; apiPort: number }> => fetch("/api/config").then(res),
  usage: (): Promise<Usage | null> => fetch("/api/usage").then(res),
  createWorktree: (repo: string, prompt: string, provider: AgentProvider): Promise<{ branch: string; worktreePath: string; title: string }> =>
    post("/api/workstreams", { repo, prompt, provider }),
  summary: (repo: string, worktree: string): Promise<ChangeSummary> =>
    fetch(`/api/summary${q(repo, `&worktree=${encodeURIComponent(worktree)}`)}`).then(res),
  promote: (repo: string, b: { worktreePath: string; branch: string; title: string; provider: AgentProvider; task?: string; sessionId?: string; outcome?: AgentOutcome; body?: string; draft?: boolean; labels?: string[] }): Promise<{ number: number; url: string }> =>
    post("/api/promote", { repo, ...b }),
  markReady: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/ready", { repo, pr }),
  autoMerge: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/auto-merge", { repo, pr }),
  disableAutoMerge: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/disable-auto-merge", { repo, pr }),
  convertToDraft: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/draft", { repo, pr }),
  adopt: (repo: string, branch: string): Promise<{ branch: string; worktreePath: string }> => post("/api/worktrees/adopt", { repo, branch }),
  handoff: (repo: string, branch: string, content: string): Promise<{ path: string }> => post("/api/handoff", { repo, branch, content }),
  // The durable enrichment + chat history (server/db.ts) — what localStorage used to hold.
  enrichment: (repo: string): Promise<Record<string, Record<string, unknown>>> => fetch(`/api/enrichment${q(repo)}`).then(res),
  patchEnrichment: (repo: string, branch: string, fields: Record<string, unknown>): Promise<{ ok: true }> =>
    post("/api/enrichment", { repo, branch, fields }),
  importEnrichment: (entries: { repo: string; branch: string; fields: Record<string, unknown> }[]): Promise<{ imported: number }> =>
    post("/api/enrichment/import", { entries }),
  turns: (repo: string, branch: string): Promise<AgentTurn[]> =>
    fetch(`/api/turns${q(repo, `&branch=${encodeURIComponent(branch)}`)}`).then(res),
  ensureTerminal: (repo: string, b: { branch: string; worktreePath: string; provider: AgentProvider; sessionId?: string; fresh?: boolean; seedFile?: string }): Promise<{ name: string }> =>
    post("/api/terminal/ensure", { repo, ...b }),
  slack: (repo: string, text: string): Promise<{ ok: true }> => post("/api/slack", { repo, text }),
  agents: (repo: string): Promise<LiveAgent[]> => fetch(`/api/agents${q(repo)}`).then(res),
  prs: (repo: string): Promise<PrSummary[]> => fetch(`/api/prs${q(repo)}`).then(res),
  mergedPrs: (repo: string): Promise<MergedPr[]> => fetch(`/api/prs/merged${q(repo)}`).then(res),
  prDetail: (repo: string, n: number): Promise<PrDetail> => fetch(`/api/prs/${n}${q(repo)}`).then(res),
  prDiff: (repo: string, n: number): Promise<{ diff: string }> => fetch(`/api/prs/${n}/diff${q(repo)}`).then(res),
  reviewEvidence: (repo: string, n: number): Promise<ReviewThreadEvidence[]> => fetch(`/api/prs/${n}/review-evidence${q(repo)}`).then(res),
  ciEvidence: (repo: string, n: number): Promise<CiFailureEvidence[]> => fetch(`/api/prs/${n}/ci-evidence${q(repo)}`).then(res),
  localDiff: (repo: string, worktree: string): Promise<{ diff: string }> =>
    fetch(`/api/diff${q(repo, `&worktree=${encodeURIComponent(worktree)}`)}`).then(res),
  merge: (repo: string, pr: number, worktreePath?: string): Promise<{ ok: true }> => post("/api/merge", { repo, pr, worktreePath }),
  closePr: (repo: string, pr: number, worktreePath?: string, branch?: string): Promise<{ ok: true }> =>
    post("/api/prs/close", { repo, pr, worktreePath, branch }),
  mergeLocal: (repo: string, branch: string, worktreePath?: string): Promise<{ ok: true }> => post("/api/merge-local", { repo, branch, worktreePath }),
  addPreviewLabel: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/label", { repo, pr }),
  preview: (repo: string, key: string, worktree: string): Promise<PreviewSvc[]> => post("/api/preview", { repo, key, worktree }),
  previewMaster: (repo: string): Promise<{ worktreePath: string; svcs: PreviewSvc[] }> => post("/api/preview/master", { repo }),
  previewStatus: (key: string): Promise<PreviewSvc[]> => fetch(`/api/preview?key=${encodeURIComponent(key)}`).then(res),
  previews: (): Promise<{ key: string; svcs: PreviewSvc[] }[]> => fetch("/api/previews").then(res),
  previewStop: (key: string): Promise<{ ok: true }> => post("/api/preview/stop", { key }),
  syncWorktrees: (repo: string): Promise<SyncResult[]> => post("/api/worktrees/sync", { repo }),
  discardWorktree: (repo: string, worktreePath: string, branch?: string, deleteBranch?: boolean): Promise<{ ok: true }> =>
    post("/api/worktrees/remove", { repo, worktreePath, branch, deleteBranch }),
  runAgent: (worktreePath: string, prompt: string, provider: AgentProvider = "claude", options: { resume?: string; history?: AgentTurn[]; handoffFrom?: AgentProvider; branch?: string; action?: string; evidenceChars?: number } = {}): Promise<LaunchReceipt> =>
    post("/api/agents/run", { worktreePath, prompt, provider, ...options }),
  agent: (repo: string, key: string, prompt: string, options: { worktree?: string; provider?: AgentProvider; resume?: string; history?: AgentTurn[]; handoffFrom?: AgentProvider; branch?: string; action?: string; evidenceChars?: number } = {}): Promise<LaunchReceipt> =>
    post("/api/agent", { repo, key, prompt, ...options }),
  // Compatibility helper for existing callers/tests while agent actions migrate to `agent`.
  claude: (repo: string, key: string, prompt: string, worktree?: string, resume?: string): Promise<{ status: string }> =>
    post("/api/claude", { repo, key, prompt, worktree, resume }),
  uploadAttachments: async (files: File[]): Promise<string[]> => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return (await fetch("/api/attachments", { method: "POST", body: form }).then(res)).paths;
  },
};
