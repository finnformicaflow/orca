import type { ChangeSummary } from "../../server/git";
import type { MergedPr, PrDetail, PrSummary, ReviewPr } from "../../server/gh";

export type LiveAgent = {
  branch: string;
  worktreePath: string;
  agentStatus: "idle" | "running" | "done" | "error";
  agentError?: string;
  agentResult?: string;
  agentStartedAt?: number;
  sessionId?: string;
  mergeClean?: "clean" | "conflict";
};

export type PreviewSvc = { name: string; port: number; url: string; open: boolean; running: boolean; ready: boolean; error?: string; startedAt: number };

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(res);

async function res(r: Response) {
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `${r.status}`);
  return data;
}

export type RepoInfo = { name: string; baseBranch: string; slackChannel?: string; hasRemote: boolean };
const q = (repo: string, extra = "") => `?repo=${encodeURIComponent(repo)}${extra}`;

export const api = {
  config: (): Promise<{ repos: RepoInfo[]; staleHours: number }> => fetch("/api/config").then(res),
  createWorktree: (repo: string, prompt: string): Promise<{ branch: string; worktreePath: string; title: string }> =>
    post("/api/workstreams", { repo, prompt }),
  summary: (repo: string, worktree: string): Promise<ChangeSummary> =>
    fetch(`/api/summary${q(repo, `&worktree=${encodeURIComponent(worktree)}`)}`).then(res),
  promote: (repo: string, b: { worktreePath: string; branch: string; title: string; draft?: boolean; addPreviewLabel?: boolean }): Promise<{ number: number; url: string }> =>
    post("/api/promote", { repo, ...b }),
  markReady: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/ready", { repo, pr }),
  autoMerge: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/auto-merge", { repo, pr }),
  convertToDraft: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/draft", { repo, pr }),
  adopt: (repo: string, branch: string): Promise<{ branch: string; worktreePath: string }> => post("/api/worktrees/adopt", { repo, branch }),
  agents: (repo: string): Promise<LiveAgent[]> => fetch(`/api/agents${q(repo)}`).then(res),
  prs: (repo: string): Promise<PrSummary[]> => fetch(`/api/prs${q(repo)}`).then(res),
  mergedPrs: (repo: string): Promise<MergedPr[]> => fetch(`/api/prs/merged${q(repo)}`).then(res),
  reviewPrs: (repo: string): Promise<ReviewPr[]> => fetch(`/api/prs/review${q(repo)}`).then(res),
  prDetail: (repo: string, n: number): Promise<PrDetail> => fetch(`/api/prs/${n}${q(repo)}`).then(res),
  prDiff: (repo: string, n: number): Promise<{ diff: string }> => fetch(`/api/prs/${n}/diff${q(repo)}`).then(res),
  localDiff: (repo: string, worktree: string): Promise<{ diff: string }> =>
    fetch(`/api/diff${q(repo, `&worktree=${encodeURIComponent(worktree)}`)}`).then(res),
  merge: (repo: string, pr: number, worktreePath?: string): Promise<{ ok: true }> => post("/api/merge", { repo, pr, worktreePath }),
  closePr: (repo: string, pr: number, worktreePath?: string, branch?: string): Promise<{ ok: true }> =>
    post("/api/prs/close", { repo, pr, worktreePath, branch }),
  mergeLocal: (repo: string, branch: string, worktreePath?: string): Promise<{ ok: true }> => post("/api/merge-local", { repo, branch, worktreePath }),
  addPreviewLabel: (repo: string, pr: number): Promise<{ ok: true }> => post("/api/prs/label", { repo, pr }),
  preview: (repo: string, key: string, worktree: string): Promise<PreviewSvc[]> => post("/api/preview", { repo, key, worktree }),
  previewStatus: (key: string): Promise<PreviewSvc[]> => fetch(`/api/preview?key=${encodeURIComponent(key)}`).then(res),
  previewStop: (key: string): Promise<{ ok: true }> => post("/api/preview/stop", { key }),
  discardWorktree: (repo: string, worktreePath: string, branch?: string, deleteBranch?: boolean): Promise<{ ok: true }> =>
    post("/api/worktrees/remove", { repo, worktreePath, branch, deleteBranch }),
  runAgent: (worktreePath: string, prompt: string): Promise<{ status: string }> =>
    post("/api/agents/run", { worktreePath, prompt }),
  claude: (repo: string, key: string, prompt: string, worktree?: string, resume?: string): Promise<{ status: string }> =>
    post("/api/claude", { repo, key, prompt, worktree, resume }),
  uploadAttachments: async (files: File[]): Promise<string[]> => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return (await fetch("/api/attachments", { method: "POST", body: form }).then(res)).paths;
  },
};
