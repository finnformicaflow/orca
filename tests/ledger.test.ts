import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ledger from "../server/ledger";
import { runMode, type LaunchOptions } from "../server/agent";

beforeAll(() => { process.env.ORCA_STATE_DIR = mkdtempSync(join(tmpdir(), "orca-ledger-")); });
beforeEach(() => ledger.clear());

describe("run mode inference", () => {
  test("maps launch options to resume / reset / handoff / fresh", () => {
    const mode = (o: LaunchOptions) => runMode(o);
    expect(mode({ provider: "claude", resume: "c-1" })).toBe("resume");
    expect(mode({ provider: "claude", handoffFrom: "claude", history: [] })).toBe("reset"); // same provider, portable reset
    expect(mode({ provider: "codex", handoffFrom: "claude" })).toBe("handoff"); // cross-provider
    expect(mode({ provider: "claude" })).toBe("fresh");
  });
});

describe("bounded run ledger", () => {
  test("records runs and PR-description calls and reads them back", () => {
    ledger.record({ kind: "run", provider: "claude", action: "ci", mode: "resume", status: "done", durationMs: 1200, outputTokens: 40, evidenceChars: 512 });
    ledger.record({ kind: "pr-description", provider: "claude", status: "done", prDescriptionAvoided: true });
    expect(ledger.all()).toHaveLength(2);
    expect(ledger.all()[0]).toMatchObject({ kind: "run", action: "ci", mode: "resume", outputTokens: 40 });
    expect(ledger.all().every((e) => typeof e.at === "number")).toBe(true);
  });

  test("persists to disk atomically so a restart recovers the records", () => {
    ledger.record({ kind: "run", provider: "codex", action: "launch", mode: "fresh", status: "error", errorKind: "nonzero-exit" });
    const onDisk = JSON.parse(readFileSync(join(process.env.ORCA_STATE_DIR!, "ledger.json"), "utf8"));
    expect(onDisk.at(-1)).toMatchObject({ provider: "codex", status: "error", errorKind: "nonzero-exit" });
  });

  test("caps at the size limit, dropping the oldest", () => {
    for (let i = 0; i < 520; i++) ledger.record({ kind: "run", provider: "claude", action: "launch", mode: "fresh", status: "done", durationMs: i });
    const entries = ledger.all();
    expect(entries).toHaveLength(500);
    expect(entries[0]!.durationMs).toBe(20); // 0..19 dropped
    expect(entries.at(-1)!.durationMs).toBe(519);
  });

  test("stores only counts and sizes — never prompt or response text", () => {
    ledger.record({ kind: "run", provider: "claude", action: "review", mode: "handoff", status: "done", evidenceChars: 2048 });
    const blob = JSON.stringify(ledger.all());
    expect(blob).not.toContain("prompt");
    expect(blob).not.toContain("response");
  });
});
