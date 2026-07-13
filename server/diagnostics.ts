// The payoff of the efficiency work, read back as numbers. Pure aggregation over the run ledger plus
// the process metrics — no IO, so it's testable without booting (same ethos as workstream.ts). The
// /api/diagnostics endpoint is a thin wrapper that hands it ledger.all() + metrics().
import type { LedgerEntry, RunMode } from "./ledger";

const MODES: RunMode[] = ["fresh", "resume", "reset", "handoff"];

type Tally = { runs: number; failures: number; durationMs: number; inputTokens: number; outputTokens: number };
const emptyTally = (): Tally => ({ runs: 0, failures: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 });
const add = (t: Tally, e: LedgerEntry) => {
  t.runs++;
  if (e.status === "error") t.failures++;
  t.durationMs += e.durationMs ?? 0;
  t.inputTokens += e.inputTokens ?? 0;
  t.outputTokens += e.outputTokens ?? 0;
};

export type Diagnostics = {
  totalRuns: number;
  failureRate: number; // 0..1
  rerunRate: number; // rerun actions / total runs
  byProvider: Record<string, Tally>;
  byAction: Record<string, Tally>;
  modes: Record<RunMode, number>;
  avgEvidenceChars: number; // over runs that carried evidence
  prDescription: { total: number; avoided: number };
  gh: { ghCalls: number; agentPolls: number; uptimeMs: number };
};

export function summarize(
  entries: LedgerEntry[],
  gh: { ghCalls: number; agentPolls: number; uptimeMs: number },
): Diagnostics {
  const runs = entries.filter((e) => e.kind === "run");
  const prs = entries.filter((e) => e.kind === "pr-description");
  const byProvider: Record<string, Tally> = {};
  const byAction: Record<string, Tally> = {};
  const modes: Record<RunMode, number> = { fresh: 0, resume: 0, reset: 0, handoff: 0 };
  let evidenceSum = 0, evidenceCount = 0, reruns = 0, failures = 0;
  for (const e of runs) {
    add((byProvider[e.provider] ??= emptyTally()), e);
    add((byAction[e.action ?? "other"] ??= emptyTally()), e);
    if (e.mode && MODES.includes(e.mode)) modes[e.mode]++;
    if (typeof e.evidenceChars === "number") { evidenceSum += e.evidenceChars; evidenceCount++; }
    if (e.action === "rerun") reruns++;
    if (e.status === "error") failures++;
  }
  return {
    totalRuns: runs.length,
    failureRate: runs.length ? failures / runs.length : 0,
    rerunRate: runs.length ? reruns / runs.length : 0,
    byProvider,
    byAction,
    modes,
    avgEvidenceChars: evidenceCount ? Math.round(evidenceSum / evidenceCount) : 0,
    prDescription: { total: prs.length, avoided: prs.filter((e) => e.prDescriptionAvoided).length },
    gh,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Terminal-friendly rendering — `curl -s localhost:8787/api/diagnostics?format=text`. */
export function renderText(d: Diagnostics): string {
  const row = (label: string, t: Tally) =>
    `  ${label.padEnd(10)} ${String(t.runs).padStart(4)} runs  ${pct(t.runs ? t.failures / t.runs : 0).padStart(4)} fail  ${k(t.outputTokens).padStart(7)} out  ${k(t.durationMs).padStart(7)}ms`;
  const lines = [
    `Orca efficiency — ${d.totalRuns} runs, ${pct(d.failureRate)} failed, ${pct(d.rerunRate)} reruns`,
    "",
    "By provider:",
    ...Object.entries(d.byProvider).map(([p, t]) => row(p, t)),
    "",
    "By action:",
    ...Object.entries(d.byAction).map(([a, t]) => row(a, t)),
    "",
    `Continuation: fresh ${d.modes.fresh}  resume ${d.modes.resume}  reset ${d.modes.reset}  handoff ${d.modes.handoff}`,
    `Avg evidence: ${k(d.avgEvidenceChars)} chars`,
    `PR descriptions: ${d.prDescription.total} total, ${d.prDescription.avoided} avoided a fresh model call`,
    `GitHub: ${d.gh.ghCalls} gh calls, ${d.gh.agentPolls} agent polls over ${Math.round(d.gh.uptimeMs / 1000)}s`,
  ];
  return lines.join("\n");
}
