// The durable chat history. Unlike the leases and the ledger (advisory operational state), this IS
// app state — a deliberate reversal of the original "no DB" rule, made once the conversation became
// something worth keeping rather than a cache of the last run.
//
// Why it exists: an agent's response lived only in `runs` (an in-memory Map in server/agent.ts) until
// a browser poll happened to collect it. A bridge restart, a closed tab, or simply a fast follow-up
// overwriting the map entry before the next 8s poll all destroyed the turn permanently. The fix is to
// write the turn where the data already is — at launch, and again at exit.
//
// Retention is the point. Nothing is deleted: a finished workstream is ARCHIVED, so the conversations
// most worth chaining from (the ones whose branches got merged and reaped) survive. Turn granularity
// is prompt + final response + structured outcome — what you'd feed a model — not the provider's raw
// event stream, which is far larger, mostly tool output, and already kept by the provider itself.
// `raw_ref` points back at that deep transcript for anything that needs it later.
//
// Contains prompts and responses in plaintext, so it lives in the state dir (never a worktree, so it
// can't leak into a diff or PR) and is created 0600.
import { Database } from "bun:sqlite";
import { chmodSync } from "fs";
import { statePath } from "./state";
import type { AgentOutcome, AgentProvider, AgentTurn } from "../shared/agent";

export type TurnStatus = "running" | "done" | "error";

const SCHEMA = `
CREATE TABLE workstream (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
-- Only ONE live workstream per (repo, branch). Archived rows are exempt, so a branch name can be
-- reused after its predecessor is merged without colliding with the dead one's history.
CREATE UNIQUE INDEX workstream_live ON workstream(repo, branch) WHERE archived_at IS NULL;

CREATE TABLE turn (
  id INTEGER PRIMARY KEY,
  workstream_id INTEGER NOT NULL REFERENCES workstream(id),
  run_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT,
  structured TEXT,
  session_id TEXT,
  raw_ref TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX turn_ws ON turn(workstream_id, started_at);
`;

let handle: Database | null = null;
let handlePath: string | null = null;

/** Lazily open (and migrate) the DB. Lazy so ORCA_STATE_DIR can be set after import — and so a test
 *  that repoints it gets a fresh database rather than the previous one's handle. */
export function db(): Database {
  const path = statePath("orca.db");
  if (handle && handlePath === path) return handle;
  handle?.close();
  handle = new Database(path, { create: true });
  handlePath = path;
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA foreign_keys = ON");
  migrate(handle);
  // Prompts and responses in plaintext — keep it owner-only.
  for (const suffix of ["", "-wal", "-shm"]) {
    try { chmodSync(path + suffix, 0o600); } catch { /* WAL sidecars may not exist yet */ }
  }
  return handle;
}

/** Schema versioning via SQLite's own `user_version` — the whole migration system a single-user
 *  local DB needs. Add a numbered step; never edit an existing one. */
function migrate(d: Database): void {
  const version = (d.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < 1) {
    d.transaction(() => {
      d.exec(SCHEMA);
      d.exec("PRAGMA user_version = 1");
    })();
  }
}

/** Close the handle (tests, so a repointed state dir opens cleanly). */
export function close(): void {
  handle?.close();
  handle = null;
  handlePath = null;
}

// ---- workstreams ----

/** The id of the live workstream for (repo, branch), creating it if absent. Stable across branch
 *  renames and archival — this is the id future features (links, summaries) reference. */
export function workstreamId(repo: string, branch: string): number {
  const found = db().query("SELECT id FROM workstream WHERE repo = ? AND branch = ? AND archived_at IS NULL")
    .get(repo, branch) as { id: number } | null;
  if (found) return found.id;
  const created = db().query("INSERT INTO workstream (repo, branch, created_at) VALUES (?, ?, ?) RETURNING id")
    .get(repo, branch, Date.now()) as { id: number };
  return created.id;
}

/** The client's enrichment fields, stored as one opaque JSON blob per workstream. Deliberately NOT
 *  columns: the shape is the client's (`Enrichment` in web/src/store.ts) and grows regularly, and a
 *  column per field would mean a migration per field for no query we actually run. SQLite's
 *  `json_extract` covers reading individual fields if a later feature needs to. */
export type Fields = Record<string, unknown>;

/** Every live workstream in a repo, keyed by branch. Archived ones are excluded — they're history,
 *  not board state. */
export function enrichment(repo: string): Record<string, Fields> {
  const rows = db().query("SELECT branch, data FROM workstream WHERE repo = ? AND archived_at IS NULL AND branch IS NOT NULL")
    .all(repo) as { branch: string; data: string }[];
  const out: Record<string, Fields> = {};
  for (const r of rows) {
    try { out[r.branch] = JSON.parse(r.data) as Fields; } catch { out[r.branch] = {}; }
  }
  return out;
}

/** Merge `fields` into a workstream's blob, creating it if absent. `null` (or `undefined`) deletes
 *  that key — the client's patch semantics use `undefined` to clear a field (e.g. `followSig`), and
 *  JSON.stringify drops undefined keys entirely, so deletion travels over the wire as null. */
export function patchEnrichment(repo: string, branch: string, fields: Fields): void {
  const id = workstreamId(repo, branch);
  const row = db().query("SELECT data FROM workstream WHERE id = ?").get(id) as { data: string };
  let current: Fields = {};
  try { current = JSON.parse(row.data) as Fields; } catch { /* corrupt blob → start clean */ }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) delete current[k]; else current[k] = v;
  }
  db().query("UPDATE workstream SET data = ? WHERE id = ?").run(JSON.stringify(current), id);
}

/** One-shot adoption of a browser's existing localStorage enrichment. Only fills workstreams that
 *  have no data yet, so re-running it can't overwrite anything the DB already owns. */
export function importEnrichment(entries: { repo: string; branch: string; fields: Fields }[]): number {
  let imported = 0;
  db().transaction(() => {
    for (const e of entries) {
      if (!e.repo || !e.branch) continue;
      const id = workstreamId(e.repo, e.branch);
      const row = db().query("SELECT data FROM workstream WHERE id = ?").get(id) as { data: string };
      if (row.data !== "{}") continue; // already owned by the DB — leave it alone
      const fields = (e.fields ?? {}) as Fields & { transcript?: AgentTurn[] };
      // Keep `transcript` IN the blob, exactly as persistAgentEnrichment keeps writing it going
      // forward. The store's resume guard and cross-provider handoff both read enrich.transcript, so
      // stripping it on migration would blind them for any card mid-flight at upgrade time — a card
      // stuck on a dead session would resume it and error, a mid-handoff card would lose its context.
      db().query("UPDATE workstream SET data = ? WHERE id = ?").run(JSON.stringify(fields), id);
      // AND copy it into the turn table so the Chat tab shows history that predates the DB. Redundant
      // with the blob, matching the steady state (server writes turns; the client mirrors transcript).
      for (const t of Array.isArray(fields.transcript) ? fields.transcript : []) {
        if (!t?.id) continue;
        adoptTurn(id, t);
      }
      imported++;
    }
  })();
  return imported;
}

/** Insert a turn already known to be complete (a migrated one). Ignores ids the DB has, so a repeat
 *  import — or a second browser carrying overlapping history — can't duplicate turns. */
function adoptTurn(workstreamId: number, t: AgentTurn): void {
  db().query(
    `INSERT INTO turn (workstream_id, run_id, provider, status, prompt, response, structured, session_id, raw_ref, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO NOTHING`,
  ).run(
    workstreamId, t.id, t.provider ?? "claude", t.failed ? "error" : "done",
    t.prompt ?? "", t.response ?? null, t.structured ? JSON.stringify(t.structured) : null,
    t.sessionId ?? null, t.sessionId ?? null, t.startedAt ?? 0, t.finishedAt ?? null,
  );
}

// ---- turns ----

type TurnRow = {
  run_id: string; provider: string; status: string; prompt: string; response: string | null;
  structured: string | null; session_id: string | null; started_at: number; finished_at: number | null;
};

const toTurn = (r: TurnRow): AgentTurn => ({
  id: r.run_id,
  provider: r.provider as AgentProvider,
  prompt: r.prompt,
  response: r.response ?? "",
  structured: r.structured ? JSON.parse(r.structured) as AgentOutcome : undefined,
  sessionId: r.session_id ?? undefined,
  failed: r.status === "error" ? true : undefined,
  startedAt: r.started_at,
  finishedAt: r.finished_at ?? undefined,
});

/** Record a turn the moment its run launches, so a run whose bridge dies is visible as an
 *  interrupted turn instead of vanishing. Keyed by runId, so a fast follow-up can't overwrite the
 *  previous turn the way the in-memory map (keyed by worktree path) did. */
export function startTurn(input: {
  repo: string; branch: string; runId: string; provider: AgentProvider;
  prompt: string; sessionId?: string; startedAt: number;
}): void {
  const id = workstreamId(input.repo, input.branch);
  db().query(
    `INSERT INTO turn (workstream_id, run_id, provider, status, prompt, session_id, raw_ref, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(run_id) DO NOTHING`,
  ).run(id, input.runId, input.provider, input.prompt, input.sessionId ?? null, input.sessionId ?? null, input.startedAt);
}

/** Complete the turn started by `startTurn`. The session id is re-supplied because Codex and Cursor
 *  only reveal theirs mid-run. */
export function finishTurn(runId: string, input: {
  status: "done" | "error"; response?: string; structured?: AgentOutcome;
  sessionId?: string; finishedAt: number;
}): void {
  db().query(
    `UPDATE turn SET status = ?, response = ?, structured = ?,
       session_id = COALESCE(?, session_id), raw_ref = COALESCE(?, raw_ref), finished_at = ?
     WHERE run_id = ?`,
  ).run(
    input.status, input.response ?? null,
    input.structured ? JSON.stringify(input.structured) : null,
    input.sessionId ?? null, input.sessionId ?? null, input.finishedAt, runId,
  );
}

/** Every turn for a branch's live workstream, oldest→newest. */
export function turns(repo: string, branch: string): AgentTurn[] {
  const rows = db().query(
    `SELECT t.* FROM turn t JOIN workstream w ON w.id = t.workstream_id
     WHERE w.repo = ? AND w.branch = ? AND w.archived_at IS NULL ORDER BY t.started_at, t.id`,
  ).all(repo, branch) as TurnRow[];
  return rows.map(toTurn);
}

/** Mark a workstream finished without deleting anything — merged/discarded branches keep their
 *  history so future features can summarise and chain from them. */
export function archive(repo: string, branch: string): void {
  db().query("UPDATE workstream SET archived_at = ? WHERE repo = ? AND branch = ? AND archived_at IS NULL")
    .run(Date.now(), repo, branch);
}
