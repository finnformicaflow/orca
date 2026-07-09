// Launches a headless `claude -p` (JSON output) and tracks its status + session id, so the
// UI can show done/error and "Copy CLI" can resume the exact conversation (mid-run too, since
// we choose the session id up front). Keyed by an arbitrary string: worktree path for
// feature/fix runs, `slack:…` for repo-level. The subprocess handle is kept so we can kill it.
import { retryTitle } from "./title";

export type RunState = { status: "idle" | "running" | "done" | "error"; error?: string; sessionId?: string; result?: string; startedAt?: number; finishedAt?: number };
type Run = RunState & { proc?: Bun.Subprocess };

const runs = new Map<string, Run>();

export function launch(key: string, cwd: string, prompt: string, resume?: string): void {
  // Resume an existing session (follow-up) so the agent keeps prior context, else start fresh.
  const sessionId = resume ?? crypto.randomUUID();
  const idArgs = resume ? ["--resume", resume] : ["--session-id", sessionId];
  const startedAt = Date.now();
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--permission-mode", "bypassPermissions", ...idArgs, "--output-format", "json"],
    { cwd, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  runs.set(key, { status: "running", sessionId, proc, startedAt });
  void (async () => {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (runs.get(key)?.proc !== proc) return; // superseded (re-run) or stopped — don't clobber
    let result: string | undefined, isError = false;
    try {
      const j = JSON.parse(out.trim());
      result = j.result;
      isError = Boolean(j.is_error);
    } catch { /* non-JSON output (e.g. crash) */ }
    const finishedAt = Date.now();
    runs.set(key, code === 0 && !isError
      ? { status: "done", sessionId, result, startedAt, finishedAt }
      : { status: "error", sessionId, error: (err.trim() || result || `exit ${code}`).slice(0, 300), startedAt, finishedAt });
  })();
}

/** Feature/fix run inside a worktree — keyed by the worktree path. */
export const runAgent = (worktreePath: string, prompt: string) => launch(worktreePath, worktreePath, prompt);

/** Quick Haiku summary of a prompt into a 2–5 word title. Asks for JSON, validates it (zod), and
 *  refetches once if the reply doesn't parse to a valid title; null after that (caller falls back
 *  to titleFromPrompt). */
export function summarize(prompt: string): Promise<string | null> {
  const ask = async (): Promise<string> => {
    const proc = Bun.spawn(
      ["claude", "-p", `Respond with ONLY minified JSON: {"title":"<a 2-5 word Title Case name for this task>"}. No other text.\n\n${prompt}`, "--model", "haiku", "--output-format", "json"],
      { env: process.env, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return String(JSON.parse(out.trim()).result ?? "");
  };
  return retryTitle(ask, 2); // validate + refetch once on a bad reply
}

/** Kill and forget a run (e.g. on discard). */
export function stop(key: string): void {
  const r = runs.get(key);
  try { r?.proc?.kill(); } catch { /* already gone */ }
  runs.delete(key);
}

/** Kill a running agent by branch (via ps) — works even after a restart lost the handle. */
export async function killByBranch(branch: string): Promise<void> {
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,command="], { env: process.env, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split("\n")) {
      if (line.includes("claude -p") && line.includes(branch)) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (pid) try { process.kill(pid); } catch { /* already gone */ }
      }
    }
  } catch { /* ps unavailable */ }
}

/** Branches that currently have a live `claude -p` process (recovers status lost on restart). */
export async function detectRunning(branches: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  try {
    const proc = Bun.spawn(["ps", "-Ao", "command"], { env: process.env, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = out.split("\n").filter((l) => l.includes("claude -p"));
    for (const b of branches) if (b && lines.some((l) => l.includes(b))) found.add(b);
  } catch { /* ps unavailable */ }
  return found;
}

export const status = (key: string): RunState => {
  const r = runs.get(key);
  return r ? { status: r.status, error: r.error, sessionId: r.sessionId, result: r.result, startedAt: r.startedAt, finishedAt: r.finishedAt } : { status: "idle" };
};
