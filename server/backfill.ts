// Recovering a run whose Orca instance died mid-flight.
//
// Orca writes a turn at launch and completes it in the exit handler. If the bridge is killed in
// between — a deploy, a crash, a `--watch` reload — the CLI keeps working (that is deliberate: agents
// outlive the bridge) but the reader transcribing it and the handler recording its outcome both die
// with the process. The turn is then closed as an error at the next startup, with a stump of a
// transcript and no answer, even though the work happened and was committed.
//
// The provider kept everything. Claude writes every session to
// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, and `turn.raw_ref` holds that session id. So
// an interrupted turn can be reconstructed rather than written off.
//
// Claude only, deliberately: Codex and Cursor store sessions differently, and a wrong guess here
// would fabricate history — which is worse than admitting a run was interrupted.
import { readFileSync, readdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseAgentOutcome, type AgentStep } from "../shared/agent";
import { claudeSteps } from "./agent";
import * as transcript from "./transcript";

/** Where Claude keeps its sessions. `CLAUDE_CONFIG_DIR` is the CLI's own override, so honouring it
 *  means Orca looks wherever the agent actually wrote — and gives tests somewhere to write. */
const claudeRoot = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Claude encodes a session's working directory into its project directory name by replacing every
 *  non-alphanumeric run with a dash (so `/a/b-c` and `/a/b/c` can collide — hence we still match on
 *  the session FILE, which is a uuid). */
export function projectDir(worktreePath: string): string {
  return join(claudeRoot(), "projects", worktreePath.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** Find a session's transcript file. Prefers the directory the run's worktree maps to, then falls
 *  back to scanning — a worktree that has since been removed still has its session on disk. */
export function findSessionFile(sessionId: string, worktreePath?: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined; // not a claude session id
  if (worktreePath) {
    const direct = join(projectDir(worktreePath), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  const root = join(claudeRoot(), "projects");
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return undefined; }
  for (const d of dirs) {
    const candidate = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The steps and final response recorded in a Claude session file.
 *
 *  The events are the same shape the live stream emits, so the SAME mapping is reused — a session
 *  file replayed here produces exactly what watching it live would have. */
export function readSession(path: string): { steps: AgentStep[]; response?: string } {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return { steps: [] }; }
  const steps: AgentStep[] = [];
  let response: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    steps.push(...claudeSteps(event));
    // The session file has no `result` event; the answer is the last thing the assistant said.
    const e = event as { type?: string; message?: { content?: unknown } };
    if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
      const text = (e.message.content as Array<Record<string, unknown>>)
        .map((b) => (b?.type === "text" ? String(b.text ?? "") : ""))
        .join("").trim();
      if (text) response = text;
    }
  }
  return { steps, response };
}

export type BackfillResult = { steps: number; response?: string; outcome?: ReturnType<typeof parseAgentOutcome> };

/** Reconstruct an interrupted run from the provider's own session file: append whatever steps we
 *  never recorded, and recover its final answer. Returns undefined when there is nothing to recover
 *  (no session file, or we already have everything).
 *
 *  Advisory throughout — a failed recovery leaves the turn exactly as it was. */
export async function backfillRun(runId: string, sessionId?: string, worktreePath?: string): Promise<BackfillResult | undefined> {
  if (!sessionId) return undefined;
  const path = findSessionFile(sessionId, worktreePath);
  if (!path) return undefined;
  try {
    const { steps, response } = readSession(path);
    const have = (await transcript.numbered(runId)).length;
    // The session is authoritative and ordered; anything past what we recorded is what we missed.
    const missing = steps.slice(have);
    if (missing.length) await transcript.append(runId, missing);
    if (!missing.length && !response) return undefined;
    return { steps: missing.length, response, outcome: response ? parseAgentOutcome(response) : undefined };
  } catch (e) {
    console.error("orca: backfill failed", e);
    return undefined;
  }
}
