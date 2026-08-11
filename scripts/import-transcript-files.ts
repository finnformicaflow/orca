// One-shot import of the pre-Postgres step transcripts (`~/.orca/transcripts/*.jsonl`) into the
// `turn_step` table.
//
// The steps were JSONL files under the state dir, which is right for one machine and wrong for two:
// a transcript on the cloud box's disk cannot be read by a board open on the laptop. Moving them into
// the database must not lose the conversations already recorded.
//
// Idempotent: (run_id, seq) is unique, so re-running imports nothing twice. The files are never
// modified — keep them until you've confirmed the conversations read correctly.
//
//   bun run scripts/import-transcript-files.ts
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as db from "../server/db";
import type { AgentStep } from "../shared/agent";

const dir = join(process.env.ORCA_STATE_DIR || join(homedir(), ".orca"), "transcripts");

let files: string[];
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
} catch {
  console.log(`orca: nothing to import — no transcripts at ${dir}`);
  process.exit(0);
}

await db.open();
let runs = 0;
let steps = 0;

for (const file of files) {
  const runId = file.replace(/\.jsonl$/, "");
  const parsed: AgentStep[] = [];
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { parsed.push(JSON.parse(line) as AgentStep); } catch { /* a torn final line */ }
  }
  if (!parsed.length) continue;
  // Start at whatever the run already has, so a partially-imported run tops up rather than colliding.
  const startSeq = await db.nextStepSeq(runId);
  if (startSeq > parsed.length) continue; // already fully imported
  const written = await db.appendSteps(runId, startSeq, parsed.slice(startSeq - 1) as unknown as db.Fields[]);
  if (written) { runs++; steps += written; }
}

await db.close();
console.log(
  `orca: imported ${steps} step(s) across ${runs} run(s) from ${dir}` +
  `\norca: the files are untouched — keep them until the conversations read correctly.`,
);
