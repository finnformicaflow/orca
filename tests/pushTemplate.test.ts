// `orca preview --push-to-template`: a preview's whole database becomes the template every later
// preview clones, and its integration env vars go back to the source env file. Runs the real
// pg_dump/psql chain against THROWAWAY databases and temp files — never a real preview, its
// registry, the dev template database, or a real env file.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewDbName } from "../server/preview";
import { applyEnv, envDiff, mask, pushToTemplate } from "../server/pushTemplate";

const BASE = new URL(process.env.ORCA_TEST_DATABASE_URL || "postgres://localhost:5432/postgres");
const SLOW = 60_000;
const urlOf = (db: string) => { const u = new URL(BASE); u.pathname = `/${db}`; return u.toString(); };
const template = `pushtest_tmpl_${process.pid}`;
const SECRET = "lin_api_supersecretvalue123";

let admin: Bun.SQL, root: string, repoPath: string, worktree: string, backupDir: string, preview: string;
const sourceEnv = () => readFileSync(join(repoPath, "backend/.env"), "utf8");
const notes = async (db: string) => { const c = new Bun.SQL(urlOf(db)); try { return (await c`SELECT note FROM acme.t ORDER BY note`).map((r: { note: string }) => r.note); } finally { await c.end(); } };
const ours = async (): Promise<string[]> => (await admin`SELECT datname FROM pg_database WHERE datname LIKE ${`pushtest_tmpl_${process.pid}%`} OR datname = ${preview}`).map((r: { datname: string }) => r.datname as string);

async function fresh(db: string, note: string) {
  await admin.unsafe(`CREATE DATABASE "${db}"`);
  const c = new Bun.SQL(urlOf(db));
  await c.unsafe(`CREATE SCHEMA acme; CREATE TABLE acme.t (note text); INSERT INTO acme.t VALUES ('${note}')`);
  await c.end();
}

beforeAll(async () => {
  admin = new Bun.SQL(BASE.toString());
  root = mkdtempSync(join(tmpdir(), "orca-push-"));
  repoPath = join(root, "repo"); worktree = join(root, "wt"); backupDir = join(root, "backups");
  preview = previewDbName(worktree);
  for (const d of [repoPath, worktree]) mkdirSync(join(d, "backend"), { recursive: true });
  const conn = [`DB_HOST=${BASE.hostname}`, `DB_PORT=${BASE.port || 5432}`, `DB_MASTER_USER=${decodeURIComponent(BASE.username) || "postgres"}`,
    `PGPASSWORD=${decodeURIComponent(BASE.password)}`, `PREVIEW_TEMPLATE_DB=${template}`];
  writeFileSync(join(repoPath, "backend/.env"), [...conn, "LINEAR_API_BASE_URL=https://old.example", "KEEP=1", ""].join("\n"));
  // The preview's copy, edited on the preview: a new key, a changed URL, and a non-integration change.
  writeFileSync(join(worktree, "backend/.env"), [...conn, "LINEAR_API_BASE_URL='https://api.linear.app/graphql'", "KEEP=2", `LINEAR_API_KEY=${SECRET}`, ""].join("\n"));
  for (const db of await ours()) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await fresh(template, "old template");
  await fresh(preview, "configured on preview");
}, SLOW);

afterAll(async () => {
  for (const db of await ours()) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await admin.end();
}, SLOW);

test("PT1: the env diff copies integration variables only, writes them as the preview has them, and never prints a value", () => {
  const { changes, skipped } = envDiff("A_LINEAR_URL=x\nLINEAR_API_KEY=\"k1\"\nKEEP=2\nSAME_GITHUB=1\n", "A_LINEAR_URL=y\nKEEP=1\nSAME_GITHUB=1\nONLY_SOURCE=1\n");
  expect(changes.map((c) => c.key)).toEqual(["A_LINEAR_URL", "LINEAR_API_KEY"]);
  expect(skipped).toEqual(["KEEP"]);
  expect(applyEnv("# top\nA_LINEAR_URL=y\nKEEP=1\n", changes, "note")).toBe("# top\nA_LINEAR_URL=x\nKEEP=1\n\n# note\nLINEAR_API_KEY=\"k1\"\n");
  expect(mask(SECRET)).not.toContain(SECRET.slice(2, 6));
});

test("PT2: without --confirm it prints the plan and the masked diff, and changes nothing", async () => {
  const before = sourceEnv();
  const out = await pushToTemplate({ worktree, repoPath, envFile: "backend/.env", confirm: false, backupDir });
  expect(out).toContain(`replace ${template} with a whole copy of the preview database ${preview}`);
  expect(out).toContain("+ LINEAR_API_KEY=");
  expect(out).toContain("~ LINEAR_API_BASE_URL:");
  expect(out).toContain("not copied (not integration-related): KEEP");
  expect(out).not.toContain(SECRET);
  expect(out).not.toContain("api.linear.app");
  expect(sourceEnv()).toBe(before);
  expect(await notes(template)).toEqual(["old template"]);
}, SLOW);

test("PT3: --confirm refuses while the template has connections, then swaps it, keeps a backup, writes the env, and the printed restore works", async () => {
  const held = new Bun.SQL(urlOf(template));
  await held`SELECT 1`;
  await expect(pushToTemplate({ worktree, repoPath, envFile: "backend/.env", confirm: true, backupDir })).rejects.toThrow(/refusing: \d+ connection\(s\) open on pushtest_tmpl_/);
  await held.end();
  expect(await notes(template)).toEqual(["old template"]);

  // The preview stays connected throughout: it is read, never touched.
  const live = new Bun.SQL(urlOf(preview));
  await live`SELECT 1`;
  const before = sourceEnv();
  const now = new Date("2026-10-06T12:34:56Z");
  const out = await pushToTemplate({ worktree, repoPath, envFile: "backend/.env", confirm: true, backupDir, now });
  expect([...await live`SELECT note FROM acme.t`]).toEqual([{ note: "configured on preview" }]);
  await live.end();
  expect(out).not.toContain(SECRET);

  const backup = `${template}_bak_20261006123456`;
  expect(await notes(template)).toEqual(["configured on preview"]);
  expect(await notes(backup)).toEqual(["old template"]);
  expect(await notes(preview)).toEqual(["configured on preview"]);
  expect((await ours()).filter((d) => d.includes("_push_"))).toEqual([]); // no temp db left behind

  const env = sourceEnv();
  expect(env).toContain("LINEAR_API_BASE_URL='https://api.linear.app/graphql'");
  expect(env).toContain(`LINEAR_API_KEY=${SECRET}`);
  expect(env).toContain("KEEP=1");
  const kept = out.match(/cp '([^']+)'/)![1]!;
  expect(readFileSync(kept, "utf8")).toBe(before);

  // The printed restore command, run as printed, brings the old template back.
  const restore = out.split("\n").find((l) => l.includes("RENAME TO") && l.includes(backup))!.trim();
  const p = Bun.spawn(["sh", "-c", restore], { env: { ...process.env, PGPASSWORD: decodeURIComponent(BASE.password) }, stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(0);
  expect(await notes(template)).toEqual(["old template"]);
  expect(existsSync(kept)).toBe(true);
}, SLOW);
