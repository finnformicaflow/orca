import type { ChangeSummary } from "../../server/git";
import type { PrDetail, PrSummary } from "../../server/gh";

export type LiveAgent = {
  branch: string;
  worktreePath: string;
  agentStatus: "idle" | "running" | "done" | "error";
  agentError?: string;
};

export type PreviewSvc = { name: string; port: number; url: string; open: boolean; running: boolean };

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(res);

async function res(r: Response) {
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `${r.status}`);
  return data;
}

export const api = {
  config: (): Promise<{ portRange: [number, number]; baseBranch: string; staleHours: number; slackChannel?: string }> =>
    fetch("/api/config").then(res),
  createWorktree: (title: string): Promise<{ branch: string; worktreePath: string }> =>
    post("/api/workstreams", { title }),
  summary: (worktree: string): Promise<ChangeSummary> =>
    fetch(`/api/summary?worktree=${encodeURIComponent(worktree)}`).then(res),
  promote: (b: { worktreePath: string; branch: string; title: string }): Promise<{ number: number; url: string }> =>
    post("/api/promote", b),
  agents: (): Promise<LiveAgent[]> => fetch("/api/agents").then(res),
  prs: (): Promise<PrSummary[]> => fetch("/api/prs").then(res),
  prDetail: (n: number): Promise<PrDetail> => fetch(`/api/prs/${n}`).then(res),
  prDiff: (n: number): Promise<{ diff: string }> => fetch(`/api/prs/${n}/diff`).then(res),
  merge: (pr: number, worktreePath?: string): Promise<{ ok: true }> => post("/api/merge", { pr, worktreePath }),
  preview: (key: string, worktree: string): Promise<PreviewSvc[]> => post("/api/preview", { key, worktree }),
  previewStatus: (key: string): Promise<PreviewSvc[]> => fetch(`/api/preview?key=${encodeURIComponent(key)}`).then(res),
  previewStop: (key: string): Promise<{ ok: true }> => post("/api/preview/stop", { key }),
  discardWorktree: (worktreePath: string): Promise<{ ok: true }> => post("/api/worktrees/remove", { worktreePath }),
  runAgent: (worktreePath: string, prompt: string): Promise<{ status: string }> =>
    post("/api/agents/run", { worktreePath, prompt }),
  claude: (key: string, prompt: string, worktree?: string): Promise<{ status: string }> =>
    post("/api/claude", { key, prompt, worktree }),
};
