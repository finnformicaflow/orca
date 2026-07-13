// Bounded run ledger — the observability half of the operational-state dir. Every completed agent
// run and every PR-description request appends one small record: what ran, how long, how many
// tokens, which continuation mode, how big the evidence was, whether a model call was avoided. It is
// the raw material for /api/diagnostics, which is how we tell whether the token/efficiency work
// actually paid off.
//
// It stores COUNTS AND SIZES ONLY — never prompts, responses, logs, or secrets. `errorKind` is a
// coarse category, not the error text. Bounded two ways: at most MAX_ENTRIES rows, and nothing older
// than RETENTION_MS. Advisory like the leases: a failed write drops a record, it never blocks a run.
import { statePath, writeJsonSync, readJsonSync } from "./state";
import type { AgentProvider } from "../shared/agent";

/** How a continuation run reused (or didn't) prior context — mirrors the store's launch decision. */
export type RunMode = "fresh" | "resume" | "reset" | "handoff";

export type LedgerEntry = {
  at: number;
  kind: "run" | "pr-description";
  provider: AgentProvider;
  action?: string; // run only: launch | followup | conflict | ci | review | rerun | agent
  mode?: RunMode; // run only
  status: "done" | "error";
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  evidenceChars?: number; // size of CI/review evidence handed to the agent
  prDescriptionAvoided?: boolean; // pr-description: a fresh full-context model call was avoided
  errorKind?: string; // coarse category, never the raw message
};

const MAX_ENTRIES = 500;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const LEDGER_FILE = () => statePath("ledger.json");

const fresh = (): LedgerEntry[] => {
  const cutoff = Date.now() - RETENTION_MS;
  return (readJsonSync<LedgerEntry[]>(LEDGER_FILE()) ?? []).filter((e) => e && e.at >= cutoff);
};

let entries: LedgerEntry[] = fresh();

/** Append one record and persist (bounded by count + age). Never throws. */
export function record(entry: Omit<LedgerEntry, "at"> & { at?: number }): void {
  const cutoff = Date.now() - RETENTION_MS;
  entries = [...entries.filter((e) => e.at >= cutoff), { at: Date.now(), ...entry }].slice(-MAX_ENTRIES);
  try { writeJsonSync(LEDGER_FILE(), entries); } catch { /* observability only — drop the record */ }
}

/** Everything currently retained, oldest → newest. */
export function all(): LedgerEntry[] {
  return entries;
}

/** Reset in memory and on disk (tests + a manual wipe). */
export function clear(): void {
  entries = [];
  try { writeJsonSync(LEDGER_FILE(), entries); } catch { /* ignore */ }
}
