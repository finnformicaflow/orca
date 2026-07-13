import { describe, expect, test } from "bun:test";
import { renderText, summarize } from "../server/diagnostics";
import type { LedgerEntry } from "../server/ledger";

const entries: LedgerEntry[] = [
  { at: 1, kind: "run", provider: "claude", action: "launch", mode: "fresh", status: "done", durationMs: 1000, outputTokens: 100 },
  { at: 2, kind: "run", provider: "claude", action: "ci", mode: "resume", status: "error", durationMs: 500, outputTokens: 20, evidenceChars: 800, errorKind: "nonzero-exit" },
  { at: 3, kind: "run", provider: "codex", action: "rerun", mode: "handoff", status: "done", durationMs: 700, outputTokens: 50, evidenceChars: 200 },
  { at: 4, kind: "pr-description", provider: "claude", status: "done", prDescriptionAvoided: true },
  { at: 5, kind: "pr-description", provider: "claude", status: "done", prDescriptionAvoided: false },
];
const gh = { ghCalls: 42, agentPolls: 17, uptimeMs: 60_000 };

describe("efficiency diagnostics", () => {
  test("aggregates by provider and action, and counts failures", () => {
    const d = summarize(entries, gh);
    expect(d.totalRuns).toBe(3); // pr-description rows aren't runs
    expect(d.byProvider.claude).toMatchObject({ runs: 2, failures: 1, outputTokens: 120 });
    expect(d.byProvider.codex).toMatchObject({ runs: 1, failures: 0 });
    expect(d.byAction.ci).toMatchObject({ runs: 1, failures: 1 });
  });

  test("reports continuation modes, rerun/failure rates, and evidence size", () => {
    const d = summarize(entries, gh);
    expect(d.modes).toEqual({ fresh: 1, resume: 1, reset: 0, handoff: 1 });
    expect(d.failureRate).toBeCloseTo(1 / 3);
    expect(d.rerunRate).toBeCloseTo(1 / 3);
    expect(d.avgEvidenceChars).toBe(500); // (800 + 200) / 2
  });

  test("reports PR-description calls avoided and raw GitHub-call counts", () => {
    const d = summarize(entries, gh);
    expect(d.prDescription).toEqual({ total: 2, avoided: 1 });
    expect(d.gh).toEqual(gh);
  });

  test("empty ledger reports zeroes, never NaN", () => {
    const d = summarize([], gh);
    expect(d.failureRate).toBe(0);
    expect(d.rerunRate).toBe(0);
    expect(d.avgEvidenceChars).toBe(0);
  });

  test("renders a terminal-friendly report", () => {
    const text = renderText(summarize(entries, gh));
    expect(text).toContain("3 runs");
    expect(text).toContain("By provider:");
    expect(text).toContain("42 gh calls");
    expect(text).toContain("1 avoided");
  });
});
