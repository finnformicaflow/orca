// The agent's THOUGHT PROCESS for a run, persisted as it streams: one row per step in `turn_step`.
//
// (History: the steps existed only as a 12-entry in-memory ring of one-line strings, dropped when the
// process exited — so the chat could never show *how* a turn reached its answer, only the answer.
// They then became JSONL files under the state dir, which fixed durability but not location: a
// transcript on the cloud box's disk cannot be read by a board open on the laptop, so opening that
// conversation showed nothing. Once the database is the source of truth for more than one instance,
// the steps have to live there too, or "the same conversation from either machine" isn't true.)
//
// This is NOT the provider's raw event stream: that is far larger, mostly tool output, and the
// provider already keeps it (`turn.raw_ref` points at its session). What's here is the normalized,
// bounded step list the chat renders — the same granularity you'd read in the CLI.
//
// Advisory, like the lease and ledger: a failed write must never break the run that produced it, and
// an unreadable transcript degrades to "no steps", never an error.
import type { AgentStep } from "../shared/agent";
import * as db from "./db";

// Per-step caps keep one runaway tool result (a `cat` of a lockfile, a 10k-line test log) from
// dominating a conversation; the per-run cap bounds a pathological run overall. Sized from real runs:
// at 4k the output cap was clipping ~19 results in a 220-step run, which is exactly the "depth" the
// chat exists to show. A run of that size is ~200KB of JSON — the caps are a safety valve against one
// pathological step, not a budget.
const MAX_TEXT = 16_000;
const MAX_OUTPUT = 32_000;
const MAX_STEPS = 5_000;

const clip = (s: string | undefined, n: number): string | undefined =>
  s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}\n…(truncated)…` : s;

/** Trim a step to the per-field caps. Pure, so the bounding is testable without touching a database. */
export function boundStep(step: AgentStep): AgentStep {
  return { ...step, text: clip(step.text, MAX_TEXT), detail: clip(step.detail, MAX_TEXT), output: clip(step.output, MAX_OUTPUT) };
}

// The next sequence number per run, read from the database once and then tracked here — so the common
// append is one insert rather than an insert plus a MAX() scan. A restart forgets it and re-reads,
// which is exactly right: the unique (run_id, seq) index makes a re-read collide rather than
// duplicate.
const nextSeq = new Map<string, number>();

/** Append steps to a run's transcript, returning what was written (bounded) so the caller can publish
 *  it to any open chat stream — this module knows nothing about branches. Never throws: a history
 *  write must not break the run. */
export async function append(runId: string, steps: AgentStep[]): Promise<AgentStep[]> {
  if (!steps.length) return [];
  try {
    let seq = nextSeq.get(runId) ?? await db.nextStepSeq(runId);
    if (seq > MAX_STEPS) return [];
    const bounded = steps.map(boundStep);
    await db.appendSteps(runId, seq, bounded as unknown as db.Fields[]);
    seq += bounded.length;
    if (seq > MAX_STEPS) {
      await db.appendSteps(runId, seq, [{ at: Date.now(), kind: "text", text: "…(transcript truncated: run exceeded the recorded-step limit)…" } as unknown as db.Fields]);
      seq++;
    }
    nextSeq.set(runId, seq);
    return bounded;
  } catch (e) {
    console.error("orca: transcript write failed", e);
    return [];
  }
}

/** A run's recorded steps, oldest first. `tail` returns only the last N; `afterSeq` only what's newer
 *  than a sequence number the caller already has. Missing/unreadable → []. */
export async function read(runId: string, tail?: number): Promise<AgentStep[]> {
  return (await numbered(runId, { tail })).map((r) => r.step);
}

/** As `read`, but keeping each step's sequence number — a chat stream watching a run on ANOTHER
 *  instance polls with the last seq it saw and gets only what's new. */
export async function numbered(runId: string, opts: { tail?: number; afterSeq?: number } = {}): Promise<{ seq: number; step: AgentStep }[]> {
  try {
    const rows = await db.steps(runId, opts);
    return rows.map((r) => ({ seq: r.seq, step: r.step as unknown as AgentStep }));
  } catch (e) {
    console.error("orca: transcript read failed", e);
    return [];
  }
}

/** Drop the in-memory sequence counter for a finished run (the rows stay — they ARE the history). */
export function forget(runId: string): void {
  nextSeq.delete(runId);
}
