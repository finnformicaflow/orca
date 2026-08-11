// One-shot import of the pre-Postgres chat history (`~/.orca/orca.db`) into Postgres.
//
// "Nothing is deleted" is the DB's founding rule, so switching engines must not quietly drop the
// conversations already recorded — the merged-and-reaped ones are exactly the ones worth chaining
// from later. Idempotent: rows are keyed by their original `run_id` / (repo, branch), so re-running
// imports nothing twice. The SQLite file is never modified, so this is safe to run and re-run.
//
//   bun run scripts/import-sqlite-history.ts            # imports from ~/.orca/orca.db
//   bun run scripts/import-sqlite-history.ts <path.db>  # or an explicit file
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as db from "../server/db";

const source = process.argv[2] || join(process.env.ORCA_STATE_DIR || join(homedir(), ".orca"), "orca.db");
if (!existsSync(source)) {
  console.log(`orca: nothing to import — no SQLite history at ${source}`);
  process.exit(0);
}

const old = new Database(source, { readonly: true });
const sql = await db.open();
const user = db.currentUser();

const workstreams = old.query("SELECT * FROM workstream").all() as {
  id: number; repo: string; branch: string | null; data: string; created_at: number; archived_at: number | null;
}[];
const turns = old.query("SELECT * FROM turn").all() as {
  workstream_id: number; run_id: string; provider: string; status: string; prompt: string;
  response: string | null; structured: string | null; session_id: string | null; raw_ref: string | null;
  started_at: number; finished_at: number | null;
}[];

const parse = (raw: string | null): unknown => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

// Old id → new id, so turns land under the workstream they belonged to.
const idMap = new Map<number, number>();
let importedWorkstreams = 0;

for (const w of workstreams) {
  if (!w.branch) continue; // a workstream with no branch renders nothing and chains to nothing
  const existing = await sql`
    SELECT id FROM workstream
    WHERE user_id = ${user} AND repo = ${w.repo} AND branch = ${w.branch}
      AND (archived_at IS NULL) = ${w.archived_at === null}`;
  if (existing.length) {
    idMap.set(w.id, Number(existing[0].id));
    continue;
  }
  const created = await sql`
    INSERT INTO workstream (user_id, repo, branch, data, created_at, archived_at)
    VALUES (${user}, ${w.repo}, ${w.branch}, ${parse(w.data) ?? {}}, ${w.created_at}, ${w.archived_at})
    RETURNING id`;
  idMap.set(w.id, Number(created[0].id));
  importedWorkstreams++;
}

let importedTurns = 0;
for (const t of turns) {
  const workstreamId = idMap.get(t.workstream_id);
  if (!workstreamId) continue; // its workstream had no branch
  const inserted = await sql`
    INSERT INTO turn (workstream_id, user_id, run_id, provider, status, prompt, response, structured,
                      session_id, raw_ref, started_at, finished_at)
    VALUES (${workstreamId}, ${user}, ${t.run_id}, ${t.provider}, ${t.status}, ${t.prompt},
            ${t.response}, ${parse(t.structured)}, ${t.session_id}, ${t.raw_ref},
            ${t.started_at}, ${t.finished_at})
    ON CONFLICT (run_id) DO NOTHING
    RETURNING id`;
  if (inserted.length) importedTurns++;
}

old.close();
await db.close();
console.log(
  `orca: imported ${importedWorkstreams} workstream(s) and ${importedTurns} turn(s) from ${source}` +
  `\norca: the SQLite file is untouched — keep it until you've confirmed the history reads correctly.`,
);
