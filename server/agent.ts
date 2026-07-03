// Launches a headless `claude -p` and tracks its status. No streaming (see the plan) —
// Orca reports running/done/error; code changes surface via the git change-summary poll.
// Runs are keyed by an arbitrary string: a worktree path for feature/fix runs, or e.g.
// `slack:1234` for repo-level actions. So every button is just "run Claude with prompt X".
export type RunState = { status: "idle" | "running" | "done" | "error"; error?: string };

const runs = new Map<string, RunState>();

export function launch(key: string, cwd: string, prompt: string): void {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--permission-mode", "bypassPermissions"],
    { cwd, env: process.env, stdout: "ignore", stderr: "pipe" },
  );
  runs.set(key, { status: "running" });
  void (async () => {
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    runs.set(key, code === 0 ? { status: "done" } : { status: "error", error: err.trim().slice(0, 300) });
  })();
}

/** Feature/fix run inside a worktree — keyed by the worktree path. */
export const runAgent = (worktreePath: string, prompt: string) => launch(worktreePath, worktreePath, prompt);

export const status = (key: string): RunState => runs.get(key) ?? { status: "idle" };
