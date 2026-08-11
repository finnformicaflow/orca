// The agent's THOUGHT PROCESS for a run, persisted as it streams: one JSON step per line under
// `~/.orca/transcripts/<runId>.jsonl`. (History: the steps existed only as a 12-entry in-memory ring
// of one-line strings, dropped when the process exited — so the chat could never show *how* a turn
// reached its answer, only the answer, and a bridge restart lost even the live view.)
//
// This is NOT the provider's raw event stream: that is far larger, mostly tool output, and the
// provider already keeps it (`turn.raw_ref` points at its session). What's here is the normalized,
// bounded step list the chat renders — the same granularity you'd read in the CLI.
//
// Advisory, like the lease and ledger: a failed write must never break the run that produced it, and
// a missing/corrupt file degrades to "no steps", never an error.
import { appendFileSync, readFileSync, statSync, existsSync } from "fs";
import type { AgentStep } from "../shared/agent";
import { statePath } from "./state";

// Per-step caps keep one runaway tool result (a `cat` of a lockfile, a 10k-line test log) from
// dominating the file; the file cap bounds a pathological run overall. Sized from real runs: at
// 4k the output cap was clipping ~19 results in a 220-step run, which is exactly the "depth" the
// chat exists to show. A 220-step run is ~200KB, so there is ample headroom — the caps are a safety
// valve against one pathological step, not a budget.
const MAX_TEXT = 16_000;
const MAX_OUTPUT = 32_000;
const MAX_FILE = 64 * 1024 * 1024;

export const transcriptPath = (runId: string): string => statePath("transcripts", `${runId}.jsonl`);

const clip = (s: string | undefined, n: number): string | undefined =>
  s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}\n…(truncated)…` : s;

/** Trim a step to the per-field caps. Pure, so the bounding is testable without touching disk. */
export function boundStep(step: AgentStep): AgentStep {
  return { ...step, text: clip(step.text, MAX_TEXT), detail: clip(step.detail, MAX_TEXT), output: clip(step.output, MAX_OUTPUT) };
}

// Size is tracked in memory so the common append doesn't stat() on every line. A restart forgets it
// and re-stats once, which is exactly right — the cap is a safety valve, not an accounting record.
const sizes = new Map<string, number>();

/** Append steps to a run's transcript, returning what was written (bounded) so the caller can publish
 *  it to any open chat stream — this module stays pure persistence and knows nothing about branches.
 *  Never throws: a history write must not break the run. */
export function append(runId: string, steps: AgentStep[]): AgentStep[] {
  if (!steps.length) return [];
  try {
    const path = transcriptPath(runId);
    let size = sizes.get(runId) ?? (existsSync(path) ? statSync(path).size : 0);
    if (size >= MAX_FILE) return [];
    const bounded = steps.map(boundStep);
    const payload = `${bounded.map((s) => JSON.stringify(s)).join("\n")}\n`;
    appendFileSync(path, payload);
    size += Buffer.byteLength(payload);
    if (size >= MAX_FILE) {
      appendFileSync(path, `${JSON.stringify({ at: Date.now(), kind: "text", text: "…(transcript truncated: run exceeded the recorded-step limit)…" } satisfies AgentStep)}\n`);
    }
    sizes.set(runId, size);
    return bounded;
  } catch (e) {
    console.error("orca: transcript write failed", e);
    return [];
  }
}

/** A run's recorded steps, oldest first. `tail` returns only the last N. Missing file → []. */
export function read(runId: string, tail?: number): AgentStep[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath(runId), "utf8");
  } catch {
    return []; // no transcript (older run, non-claude provider, or never written) — not an error
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const wanted = tail === undefined ? lines : lines.slice(-tail);
  const steps: AgentStep[] = [];
  for (const line of wanted) {
    try { steps.push(JSON.parse(line) as AgentStep); } catch { /* a torn final line mid-write */ }
  }
  return steps;
}

/** Drop the in-memory size counter for a finished run (the file stays — it IS the history). */
export function forget(runId: string): void {
  sizes.delete(runId);
}
