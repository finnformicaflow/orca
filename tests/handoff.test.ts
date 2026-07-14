// The interactive cross-provider handoff seed must land in the operational state dir — never a
// worktree — so it can't leak into a diff or PR (see CLAUDE.md), and branch slashes must be safe in
// the filename. Exercises the real writer against an isolated ORCA_STATE_DIR.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("writeHandoffFile persists the seed under the state dir with a filesystem-safe name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-state-"));
  const prev = process.env.ORCA_STATE_DIR;
  process.env.ORCA_STATE_DIR = dir;
  try {
    const { writeHandoffFile } = await import("../server/state");
    const path = writeHandoffFile("myrepo", "feature/x", "HELLO CONTEXT");
    expect(path.startsWith(dir)).toBe(true);
    expect(path).toContain(`${join("handoff", "myrepo--feature-x.md")}`); // slash sanitized to a dash
    expect(readFileSync(path, "utf8")).toBe("HELLO CONTEXT");
  } finally {
    if (prev === undefined) delete process.env.ORCA_STATE_DIR;
    else process.env.ORCA_STATE_DIR = prev;
  }
});
