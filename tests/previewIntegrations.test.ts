// Integration config survives previews: per-repo env overrides reach every preview service, and
// `orca preview --promote-integrations` copies ONLY integration settings rows from a preview's
// database into the template future previews are cloned from. The promote tests run the real chain
// (preview.promote → preview-db.sh → promote-integrations.ts) against two THROWAWAY databases on
// the test Postgres — never a real preview, its registry, ports, or the dev databases.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigDocument } from "../server/config";
import { previewDbName, promote, serviceEnv } from "../server/preview";

const BASE = new URL(process.env.ORCA_TEST_DATABASE_URL || "postgres://localhost:5432/postgres");
const SCRIPT = join(import.meta.dir, "../scripts/preview-db.sh");
const SLOW = 30_000; // creating + dropping databases is seconds under a loaded full suite
const urlOf = (db: string) => { const u = new URL(BASE); u.pathname = `/${db}`; return u.toString(); };

let admin: Bun.SQL;
let worktree: string;
let source: string; // named as Orca names this worktree's preview database
const template = `orcatest_tmpl_${process.pid}`;

// A tenant schema shaped like branch-demo's: integration tables beside user data.
const schema = (extraCol: boolean) => `
  CREATE SCHEMA acme;
  CREATE TABLE acme."user" (id uuid PRIMARY KEY, email text);
  CREATE TABLE acme.linear_integration (id uuid PRIMARY KEY, api_key text, team_ids jsonb,
    created_by_id uuid REFERENCES acme."user"(id)${extraCol ? ", added_by_branch text" : ""});
  CREATE TABLE acme.jira_integration (id uuid PRIMARY KEY, base_url text);
  CREATE TABLE acme.integration_activity (id uuid PRIMARY KEY, note text);
  CREATE TABLE acme.user_jira_auth (id uuid PRIMARY KEY, token text);
  INSERT INTO acme."user" VALUES ('00000000-0000-0000-0000-00000000000a', 'a@x');`;

async function fresh(db: string, sql: string) {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${db}"`);
  const c = new Bun.SQL(urlOf(db));
  await c.unsafe(sql);
  await c.end();
}

beforeAll(async () => {
  admin = new Bun.SQL(BASE.toString());
  worktree = await mkdtemp(join(tmpdir(), "orca-promote-"));
  source = previewDbName(worktree);
  // What preview-db.sh reads from the worktree's backend/.env: credentials and the template's name.
  await writeFile(join(worktree, ".env"), [
    `DB_HOST=${BASE.hostname}`, `DB_PORT=${BASE.port || 5432}`, `DB_MASTER_USER=${decodeURIComponent(BASE.username) || "postgres"}`,
    `PGPASSWORD=${decodeURIComponent(BASE.password)}`, `PREVIEW_TEMPLATE_DB=${template}`,
  ].join("\n"));
}, SLOW);

afterAll(async () => {
  for (const db of [source, template]) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
  await admin.end();
}, SLOW);

test("I1 env overrides: a repo's previewEnv is validated and wins over the bridge's env", () => {
  const repo = { name: "r", repoPath: "/r", worktreeRoot: "/r/w", baseBranch: "main" };
  expect(parseConfigDocument({ repos: [{ ...repo, previewEnv: { LINEAR_API_BASE_URL: "https://api.linear.app/graphql" } }] }).errors).toEqual([]);
  expect(parseConfigDocument({ repos: [{ ...repo, previewEnv: { "BAD-NAME": "x" } }] }).errors[0]).toContain("previewEnv");
  expect(parseConfigDocument({ repos: [{ ...repo, previewEnv: { N: 1 } }] }).errors[0]).toContain("previewEnv");
  expect(serviceEnv({ PATH: "/bin", LINEAR_API_BASE_URL: "old" }, { LINEAR_API_BASE_URL: "new" })).toEqual({ PATH: "/bin", LINEAR_API_BASE_URL: "new" });
});

test("I2 promote copies only integration settings rows, upserting into the template", async () => {
  await fresh(template, schema(false) + `
    INSERT INTO acme.linear_integration VALUES ('00000000-0000-0000-0000-000000000001', 'stale', '[]', NULL),
                                               ('00000000-0000-0000-0000-000000000002', 'kept', '[]', NULL);`);
  await fresh(source, schema(true) + `
    INSERT INTO acme.linear_integration VALUES ('00000000-0000-0000-0000-000000000001', 'fresh', '["T1"]', '00000000-0000-0000-0000-00000000000a', 'x'),
                                               ('00000000-0000-0000-0000-000000000003', 'new', '[]', NULL, 'y');
    INSERT INTO acme.jira_integration VALUES ('00000000-0000-0000-0000-000000000004', 'https://acme.atlassian.net');
    INSERT INTO acme.integration_activity VALUES ('00000000-0000-0000-0000-000000000005', 'log');
    INSERT INTO acme.user_jira_auth VALUES ('00000000-0000-0000-0000-000000000006', 'per-user');
    INSERT INTO acme."user" VALUES ('00000000-0000-0000-0000-00000000000b', 'b@x');`);

  const r = await promote(worktree, `bash '${SCRIPT}' promote-integrations {db}`);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("acme.linear_integration: 2 rows");
  expect(r.output).toContain("acme.jira_integration: 1 row");
  expect(r.output).not.toContain("fresh"); // counts, never values (the rows hold API keys)

  const t = new Bun.SQL(urlOf(template));
  const linear = await t`SELECT api_key, team_ids FROM acme.linear_integration ORDER BY id`;
  expect(linear.map((x: { api_key: string }) => x.api_key)).toEqual(["fresh", "kept", "new"]); // updated, untouched, added
  expect(linear[0].team_ids).toEqual(["T1"]); // jsonb survives the trip
  expect((await t`SELECT count(*)::int AS n FROM acme.jira_integration`)[0].n).toBe(1);
  // Not integration settings: activity logs, per-user credentials and users are never copied.
  expect((await t`SELECT count(*)::int AS n FROM acme.integration_activity`)[0].n).toBe(0);
  expect((await t`SELECT count(*)::int AS n FROM acme.user_jira_auth`)[0].n).toBe(0);
  expect((await t`SELECT count(*)::int AS n FROM acme."user"`)[0].n).toBe(1);
  await t.end();
}, SLOW);

test("I3 promote is all-or-nothing: a row the template can't hold changes nothing", async () => {
  await fresh(template, schema(false));
  await fresh(source, schema(false) + `
    INSERT INTO acme."user" VALUES ('00000000-0000-0000-0000-00000000000b', 'b@x');
    INSERT INTO acme.jira_integration VALUES ('00000000-0000-0000-0000-000000000004', 'https://acme.atlassian.net');
    INSERT INTO acme.linear_integration VALUES ('00000000-0000-0000-0000-000000000001', 'k', '[]', '00000000-0000-0000-0000-00000000000b');`);

  const r = await promote(worktree, `bash '${SCRIPT}' promote-integrations {db}`);
  expect(r.ok).toBe(false);
  expect(r.output).toContain("acme.linear_integration"); // says which table, not which values
  const t = new Bun.SQL(urlOf(template));
  expect((await t`SELECT count(*)::int AS n FROM acme.jira_integration`)[0].n).toBe(0); // the earlier table rolled back too
  await t.end();
}, SLOW);

test("I4 promote refuses a source outside Orca's preview namespace", async () => {
  // preview-db.sh's orca_* guard: `{db}` can never name the template or the dev database.
  const r = await promote(worktree, `bash '${SCRIPT}' promote-integrations ${template}`);
  expect(r.ok).toBe(false);
  expect(r.output).toContain("refusing");
}, SLOW);
