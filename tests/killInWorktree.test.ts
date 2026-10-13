import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agent from "../server/agent";
import { pidAlive } from "../server/lease";

// The orchestrator's wakes died with exit 143 right after it merged a PR: reaping the merged
// worktree killed every headless agent whose ARGV mentioned the branch, and the orchestrator's
// prompt (its board) is in its argv. A worktree's agents are now found by their cwd.
const procs: Bun.Subprocess[] = [];
afterEach(() => { for (const p of procs.splice(0)) try { p.kill(9); } catch { /* gone */ } });

/** A process that `ps` shows as `claude -p <prompt…> 60`, running in `cwd`. */
function fakeAgent(cwd: string, prompt: string): Bun.Subprocess {
  const p = Bun.spawn(["bash", "-c", `exec -a "claude -p ${prompt}" sleep 60`], { cwd, stdout: "ignore", stderr: "ignore" });
  procs.push(p);
  return p;
}

describe("killInWorktree", () => {
  test("kills the agent running in the worktree, never one that only mentions its branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-kill-"));
    const wt = join(root, "wt", "feat-reaped");
    const orch = join(root, "orchestrator");
    mkdirSync(join(wt, "web"), { recursive: true });
    mkdirSync(orch);
    const worker = fakeAgent(join(wt, "web"), "fix feat-reaped");
    const orchestrator = fakeAgent(orch, "board: feat-reaped merged");
    const sibling = fakeAgent(root, "feat-reaped-2 work"); // a prefix-sharing path is not inside
    await Bun.sleep(150);
    expect(agent.cwdInWorktree(agent.processCwd(worker.pid), wt)).toBe(true);

    await agent.killInWorktree(wt);
    await worker.exited;
    expect(worker.signalCode).toBe("SIGTERM");
    expect(pidAlive(orchestrator.pid)).toBe(true);
    expect(pidAlive(sibling.pid)).toBe(true);
  });

  test("cwdInWorktree is a path prefix on a separator, not a string prefix", () => {
    expect(agent.cwdInWorktree("/w/feat", "/w/feat")).toBe(true);
    expect(agent.cwdInWorktree("/w/feat/web", "/w/feat/")).toBe(true);
    expect(agent.cwdInWorktree("/w/feat-2", "/w/feat")).toBe(false);
    expect(agent.cwdInWorktree(undefined, "/w/feat")).toBe(false);
  });
});
