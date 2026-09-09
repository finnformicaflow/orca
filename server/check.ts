// The verification gate: after a run that committed, Orca runs the repo's own check command in the
// worktree and records the result on the turn. "Claude stops when the work looks done. Without a
// check it can run, 'looks done' is the only signal" — so the check is Orca's, deterministic, not
// the agent's self-report in the outcome's Verification section. The output tail is kept as the
// evidence a fix follow-up is given.
import { agentEnv } from "./agent";
import type { TurnCheck } from "../shared/agent";

const OUTPUT_TAIL = 4_000; // chars of combined output kept on the turn — enough for a failing test's name and assertion
const TIMEOUT_MS = 10 * 60_000;

/** Run `command` through `sh -lc` in `cwd`; never throws. */
export async function runCheck(cwd: string, command: string): Promise<TurnCheck> {
  const startedAt = Date.now();
  const proc = Bun.spawn(["sh", "-lc", command], { cwd, env: agentEnv(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const combined = `${out}${err}`.trim();
  return {
    command,
    ok: code === 0,
    exitCode: code,
    output: combined.length > OUTPUT_TAIL ? `…${combined.slice(-OUTPUT_TAIL)}` : combined,
    durationMs: Date.now() - startedAt,
  };
}
