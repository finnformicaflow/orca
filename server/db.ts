// The durable chat history. Unlike the leases and the ledger (advisory operational state), this IS
// app state — a deliberate reversal of the original "no DB" rule, made once the conversation became
// something worth keeping rather than a cache of the last run.
//
// Why it exists: an agent's response lived only in `runs` (an in-memory Map in server/agent.ts) until
// a browser poll happened to collect it. A bridge restart, a closed tab, or simply a fast follow-up
// overwriting the map entry before the next 8s poll all destroyed the turn permanently. The fix is to
// write the turn where the data already is — at launch, and again at exit.
//
// POSTGRES, not SQLite: the database is becoming the shared source of truth for more than one Orca
// instance (a cloud box and a laptop, each executing its own worktrees against one database), which a
// file on one host cannot be. `Bun.SQL` ships with the runtime, so this costs no dependency. The API
// is async throughout — see `recordTurn` in agent.ts for how the one fire-and-forget caller keeps its
// synchronous signature.
//
// EVERY table carries `user_id` from the first migration. There is no auth yet (see `currentUser`)
// and exactly one user, but retrofitting row-level scoping later would mean revisiting every query in
// the codebase — so the column goes in now, while it is free.
//
// Retention is the point. Nothing is deleted: a finished workstream is ARCHIVED, so the conversations
// most worth chaining from (the ones whose branches got merged and reaped) survive. Turn granularity
// is prompt + final response + structured outcome — what you'd feed a model — not the provider's raw
// event stream, which is far larger, mostly tool output, and already kept by the provider itself.
// `raw_ref` points back at that deep transcript for anything that needs it later.
//
// Contains prompts and responses in plaintext: keep the database off the public internet (it is
// reached over the tailnet) and never inside a worktree, so it can't leak into a diff or PR.
import type { AgentOutcome, AgentProvider, AgentTurn } from "../shared/agent";
import * as bus from "./bus";

export type TurnStatus = "running" | "done" | "error" | "stopped";

/** Whose data this request touches. A constant until auth exists: the MVP has exactly one user, but
 *  every query is already scoped by it, so adding real identity later replaces THIS function and
 *  nothing else. (Tailscale can supply the identity when that time comes.) */
export function currentUser(): string {
  return process.env.ORCA_USER || "me";
}

/** Where the database lives. Local dev and the deployed instance differ only by this string. */
const databaseUrl = (): string => process.env.ORCA_DATABASE_URL || "postgres://localhost:5432/orca";

let handle: Bun.SQL | null = null;
let handleUrl: string | null = null;
let ready: Promise<void> | null = null;

/** The connection pool, migrated on first use. Lazy so ORCA_DATABASE_URL can be set after import —
 *  and so a test that repoints it gets a fresh pool rather than the previous one's. */
export function db(): Bun.SQL {
  const url = databaseUrl();
  if (handle && handleUrl === url) return handle;
  void handle?.end();
  handle = new Bun.SQL(url);
  handleUrl = url;
  ready = migrate(handle);
  return handle;
}

/** The pool, with migrations applied. Every query goes through this. */
export async function open(): Promise<Bun.SQL> {
  const sql = db();
  await ready;
  return sql;
}

/** Close the pool (tests, so a repointed database opens cleanly). */
export async function close(): Promise<void> {
  const closing = handle;
  handle = null;
  handleUrl = null;
  ready = null;
  await closing?.end().catch(() => {});
}

// Numbered, append-only steps recorded in `migration`. Never edit an existing step — add another.
// (SQLite's `PRAGMA user_version` did this job before; Postgres needs the table, but the discipline
// is identical, and deliberately not a migration framework.)
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE workstream (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL,
        archived_at BIGINT
      );
      -- Only ONE live workstream per (user, repo, branch). Archived rows are exempt, so a branch name
      -- can be reused after its predecessor is merged without colliding with the dead one's history.
      CREATE UNIQUE INDEX workstream_live ON workstream (user_id, repo, branch)
        WHERE archived_at IS NULL;

      CREATE TABLE turn (
        id BIGSERIAL PRIMARY KEY,
        workstream_id BIGINT NOT NULL REFERENCES workstream(id),
        user_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT,
        structured JSONB,
        session_id TEXT,
        raw_ref TEXT,
        started_at BIGINT NOT NULL,
        finished_at BIGINT
      );
      CREATE INDEX turn_ws ON turn (workstream_id, started_at);
    `,
  },
];

async function migrate(sql: Bun.SQL): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS migration (id INT PRIMARY KEY, applied_at BIGINT NOT NULL)`;
  const applied = new Set((await sql`SELECT id FROM migration`).map((r: { id: number }) => Number(r.id)));
  for (const step of MIGRATIONS) {
    if (applied.has(step.id)) continue;
    // One transaction per step: a half-applied migration is the single failure mode that would need a
    // human, so make it impossible rather than recoverable.
    await sql.begin(async (tx: Bun.SQL) => {
      await tx.unsafe(step.sql);
      await tx`INSERT INTO migration (id, applied_at) VALUES (${step.id}, ${Date.now()})`;
    });
  }
}

// ---- workstreams ----

/** The id of the live workstream for (user, repo, branch), creating it if absent. Stable across
 *  branch renames and archival — this is the id future features (links, summaries) reference. */
export async function workstreamId(repo: string, branch: string): Promise<number> {
  const sql = await open();
  const user = currentUser();
  const found = await sql`
    SELECT id FROM workstream
    WHERE user_id = ${user} AND repo = ${repo} AND branch = ${branch} AND archived_at IS NULL`;
  if (found.length) return Number(found[0].id);
  const created = await sql`
    INSERT INTO workstream (user_id, repo, branch, created_at)
    VALUES (${user}, ${repo}, ${branch}, ${Date.now()}) RETURNING id`;
  return Number(created[0].id);
}

/** The client's enrichment fields, stored as one opaque JSON blob per workstream. Deliberately NOT
 *  columns: the shape is the client's (`Enrichment` in web/src/store.ts) and grows regularly, and a
 *  column per field would mean a migration per field for no query we actually run. */
export type Fields = Record<string, unknown>;

/** Every live workstream in a repo, keyed by branch. Archived ones are excluded — they're history,
 *  not board state. */
export async function enrichment(repo: string): Promise<Record<string, Fields>> {
  const sql = await open();
  const rows = await sql`
    SELECT branch, data FROM workstream
    WHERE user_id = ${currentUser()} AND repo = ${repo} AND archived_at IS NULL AND branch IS NOT NULL`;
  const out: Record<string, Fields> = {};
  for (const r of rows as { branch: string; data: Fields }[]) out[r.branch] = r.data ?? {};
  return out;
}

/** Merge `fields` into a workstream's blob, creating it if absent. `null` (or `undefined`) deletes
 *  that key — the client's patch semantics use `undefined` to clear a field (e.g. `followSig`), and
 *  JSON.stringify drops undefined keys entirely, so deletion travels over the wire as null. */
export async function patchEnrichment(repo: string, branch: string, fields: Fields): Promise<void> {
  const sql = await open();
  const id = await workstreamId(repo, branch);
  const rows = await sql`SELECT data FROM workstream WHERE id = ${id}`;
  const current: Fields = (rows[0]?.data as Fields) ?? {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) delete current[k]; else current[k] = v;
  }
  await sql`UPDATE workstream SET data = ${current} WHERE id = ${id}`;
}

/** One-shot adoption of a browser's existing localStorage enrichment. Only fills workstreams that
 *  have no data yet, so re-running it can't overwrite anything the DB already owns. */
export async function importEnrichment(entries: { repo: string; branch: string; fields: Fields }[]): Promise<number> {
  const sql = await open();
  let imported = 0;
  for (const e of entries) {
    if (!e.repo || !e.branch) continue;
    const id = await workstreamId(e.repo, e.branch);
    const rows = await sql`SELECT data FROM workstream WHERE id = ${id}`;
    if (Object.keys((rows[0]?.data as Fields) ?? {}).length) continue; // already owned by the DB
    // Keep `transcript` IN the blob, exactly as persistAgentEnrichment keeps writing it going
    // forward. The store's resume guard and cross-provider handoff both read enrich.transcript, so
    // stripping it on migration would blind them for any card mid-flight at upgrade time.
    await sql`UPDATE workstream SET data = ${e.fields ?? {}} WHERE id = ${id}`;
    imported++;
  }
  return imported;
}

// ---- turns ----

type TurnRow = {
  run_id: string; provider: string; status: string; prompt: string; response: string | null;
  structured: AgentOutcome | null; session_id: string | null;
  started_at: string | number; finished_at: string | number | null;
};

const toTurn = (r: TurnRow): AgentTurn => ({
  id: r.run_id,
  provider: r.provider as AgentProvider,
  prompt: r.prompt,
  response: r.response ?? "",
  structured: r.structured ?? undefined,
  sessionId: r.session_id ?? undefined,
  failed: r.status === "error" ? true : undefined,
  stopped: r.status === "stopped" ? true : undefined,
  startedAt: Number(r.started_at),
  finishedAt: r.finished_at === null || r.finished_at === undefined ? undefined : Number(r.finished_at),
});

/** Record a turn the moment its run launches, so a run whose bridge dies is visible as an
 *  interrupted turn instead of vanishing. Keyed by runId, so a fast follow-up can't overwrite the
 *  previous turn the way the in-memory map (keyed by worktree path) did. */
export async function startTurn(input: {
  repo: string; branch: string; runId: string; provider: AgentProvider;
  prompt: string; sessionId?: string; startedAt: number;
}): Promise<void> {
  const sql = await open();
  const id = await workstreamId(input.repo, input.branch);
  await sql`
    INSERT INTO turn (workstream_id, user_id, run_id, provider, status, prompt, session_id, raw_ref, started_at)
    VALUES (${id}, ${currentUser()}, ${input.runId}, ${input.provider}, 'running', ${input.prompt},
            ${input.sessionId ?? null}, ${input.sessionId ?? null}, ${input.startedAt})
    ON CONFLICT (run_id) DO NOTHING`;
  bus.publish({ kind: "turn", runId: input.runId, repo: input.repo, branch: input.branch });
}

/** Complete the turn started by `startTurn`. The session id is re-supplied because Codex and Cursor
 *  only reveal theirs mid-run. */
export async function finishTurn(runId: string, input: {
  status: TurnStatus; response?: string; structured?: AgentOutcome;
  sessionId?: string; finishedAt: number;
}): Promise<void> {
  const sql = await open();
  // Return the owning branch in the same round trip, so the bus event can be addressed to the chat
  // stream watching it without a second lookup on a hot path.
  const rows = await sql`
    WITH updated AS (
      UPDATE turn SET
        status = ${input.status},
        response = ${input.response ?? null},
        structured = ${input.structured ?? null},
        session_id = COALESCE(${input.sessionId ?? null}, session_id),
        raw_ref = COALESCE(${input.sessionId ?? null}, raw_ref),
        finished_at = ${input.finishedAt}
      WHERE run_id = ${runId}
      RETURNING workstream_id
    )
    SELECT w.repo, w.branch FROM updated JOIN workstream w ON w.id = updated.workstream_id`;
  const owner = rows[0] as { repo: string; branch: string | null } | undefined;
  if (owner?.branch) bus.publish({ kind: "turn", runId, repo: owner.repo, branch: owner.branch });
}

/** Close out turns left `running` by a process that is no longer alive — a bridge killed mid-run
 *  writes the turn at launch and never reaches its exit handler, so the turn renders `▋ working…`
 *  forever. Call at startup with the run ids that still hold a live lease; everything else is an
 *  orphan. Returns how many were closed. */
export async function reconcileRunning(liveRunIds: Set<string>): Promise<number> {
  const sql = await open();
  const stuck = await sql`SELECT run_id FROM turn WHERE user_id = ${currentUser()} AND status = 'running'`;
  const orphans = (stuck as { run_id: string }[]).filter((t) => !liveRunIds.has(t.run_id));
  for (const { run_id } of orphans) {
    await finishTurn(run_id, { status: "error", response: "The bridge stopped before this run finished.", finishedAt: Date.now() });
  }
  return orphans.length;
}

/** The (repo, branch) a run's turn belongs to, or undefined if the runId is unknown. */
export async function turnOwner(runId: string): Promise<{ repo: string; branch: string } | undefined> {
  const sql = await open();
  const rows = await sql`
    SELECT w.repo, w.branch FROM turn t JOIN workstream w ON w.id = t.workstream_id
    WHERE t.run_id = ${runId} AND t.user_id = ${currentUser()}`;
  const row = rows[0] as { repo: string; branch: string | null } | undefined;
  return row?.branch ? { repo: row.repo, branch: row.branch } : undefined;
}

/** Every turn for a branch's live workstream, oldest→newest. */
export async function turns(repo: string, branch: string): Promise<AgentTurn[]> {
  const sql = await open();
  const rows = await sql`
    SELECT t.* FROM turn t JOIN workstream w ON w.id = t.workstream_id
    WHERE w.user_id = ${currentUser()} AND w.repo = ${repo} AND w.branch = ${branch}
      AND w.archived_at IS NULL
    ORDER BY t.started_at, t.id`;
  return (rows as TurnRow[]).map(toTurn);
}

/** Mark a workstream finished without deleting anything — merged/discarded branches keep their
 *  history so future features can summarise and chain from them. */
export async function archive(repo: string, branch: string): Promise<void> {
  const sql = await open();
  await sql`
    UPDATE workstream SET archived_at = ${Date.now()}
    WHERE user_id = ${currentUser()} AND repo = ${repo} AND branch = ${branch} AND archived_at IS NULL`;
}
