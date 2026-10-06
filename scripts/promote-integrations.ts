// Promote a preview database's integration settings into the preview TEMPLATE database, so an
// integration configured once on a preview is in every preview cloned after it. Called by
// preview-db.sh `promote-integrations` (which loads the worktree .env for credentials); the copy
// itself is here so it is testable against throwaway databases.
//
// Which rows: every row of every table, in any schema, whose name matches PREVIEW_INTEGRATION_TABLES
// (a regex, default `_integration$` — branch-demo's per-tenant `linear_integration`,
// `jira_integration`, `git_hub_integration`, `git_lab_integration`, …), found by inspecting the
// source schema at run time. Nothing else: not the activity logs, OAuth state, per-user credentials
// or project connections beside them, and never a whole database.
//
// How: upsert on the target table's primary key, over the columns both sides have (a previewed
// branch may have added columns the template lacks). Nothing is deleted from the template. All
// tables go in ONE transaction, so a failure (e.g. a row's `created_by_id` naming a user the
// template doesn't have) promotes nothing. Output names tables and row counts, never values —
// the rows hold API keys.
import { SQL } from "bun";

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export type Promoted = { table: string; rows: number; skipped?: string };

type Conn = string | { hostname: string; port: number; username: string; password: string; database: string };

export async function promoteIntegrations(source: Conn, target: Conn, pattern = "_integration$"): Promise<Promoted[]> {
  const src = new SQL(source as string);
  const dst = new SQL(target as string);
  try {
    const tables: { s: string; t: string }[] = await src`
      SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_name ~ ${pattern}
        AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`;
    const out: Promoted[] = [];
    const work: { table: string; sql: string; json: string; rows: number }[] = [];
    for (const { s, t } of tables) {
      const table = `${s}.${t}`;
      const cols = async (db: SQL): Promise<string[]> => (await db`
        SELECT column_name AS c FROM information_schema.columns
        WHERE table_schema = ${s} AND table_name = ${t} ORDER BY ordinal_position`).map((r: { c: string }) => r.c);
      const theirs = new Set(await cols(dst));
      if (!theirs.size) { out.push({ table, rows: 0, skipped: "not in the template" }); continue; }
      const shared = (await cols(src)).filter((c: string) => theirs.has(c));
      const pk: string[] = (await dst`
        SELECT a.attname AS c FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = ${`${q(s)}.${q(t)}`}::regclass AND i.indisprimary`).map((r: { c: string }) => r.c);
      if (!pk.length || !pk.every((c: string) => shared.includes(c))) { out.push({ table, rows: 0, skipped: "no shared primary key" }); continue; }
      const list = shared.map(q).join(", ");
      const [{ json, n }] = await src.unsafe(`SELECT coalesce(json_agg(r), '[]')::text AS json, count(*)::int AS n FROM (SELECT ${list} FROM ${q(s)}.${q(t)}) r`);
      if (!n) { out.push({ table, rows: 0 }); continue; }
      const rest = shared.filter((c: string) => !pk.includes(c));
      // json_populate_recordset casts every value to the TARGET's column types (jsonb, uuid, timestamptz…).
      const sql = `INSERT INTO ${q(s)}.${q(t)} (${list}) SELECT ${list} FROM json_populate_recordset(null::${q(s)}.${q(t)}, $1::text::json) `
        + `ON CONFLICT (${pk.map(q).join(", ")}) DO ${rest.length ? `UPDATE SET ${rest.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ")}` : "NOTHING"}`;
      work.push({ table, sql, json, rows: n });
    }
    await dst.begin(async (tx) => {
      for (const w of work) {
        try { await tx.unsafe(w.sql, [w.json]); } catch (e) { throw new Error(`${w.table}: ${(e as Error).message}`); }
      }
    });
    return [...out, ...work.map(({ table, rows }) => ({ table, rows }))].sort((a, b) => a.table.localeCompare(b.table));
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}

// CLI: bun promote-integrations.ts <source-db> <template-db>, with DB_HOST/DB_PORT/DB_MASTER_USER/
// PGPASSWORD in the environment (preview-db.sh exports them from the worktree .env).
if (import.meta.main) {
  const [source, template] = process.argv.slice(2);
  if (!source || !template || source === template) { console.error("Usage: promote-integrations.ts <source-db> <template-db> (different databases)"); process.exit(1); }
  // An options object, not a URL: a password with URL-special characters breaks URL parsing.
  const conn = (database: string) => ({
    hostname: process.env.DB_HOST || "localhost", port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_MASTER_USER || "postgres", password: process.env.PGPASSWORD ?? "", database,
  });
  try {
    const res = await promoteIntegrations(conn(source), conn(template), process.env.PREVIEW_INTEGRATION_TABLES || undefined);
    const copied = res.filter((r) => r.rows);
    for (const r of copied) console.log(`${r.table}: ${r.rows} row${r.rows === 1 ? "" : "s"}`);
    for (const r of res.filter((r) => r.skipped)) console.log(`${r.table}: skipped (${r.skipped})`);
    console.log(copied.length ? `Promoted integration settings from ${source} into ${template}.` : `No integration rows in ${source}; ${template} unchanged.`);
  } catch (e) {
    console.error(`Promote failed, ${template} unchanged: ${(e as Error).message}`);
    process.exit(1);
  }
}
