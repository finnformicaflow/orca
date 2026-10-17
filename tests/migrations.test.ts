// Migration identity is id + name (server/db.ts `planMigrations`). The incident this pins: two
// branches each appended "the next id"; one branch's 13 reached the shared database first, the runner
// (keyed on the id alone) skipped main's 13 as applied, and every metrics sample then failed on the
// missing `running_agents` column. Now a recorded name that isn't main's is reported, and the step is
// re-run if it is idempotent, or the bridge refuses to start if it is not.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../server/db";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
let prevDbUrl: string | undefined;
beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("migrations");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
});

/** Run `fn` against the schema with a plain connection — what another branch's runner would do. */
async function raw<T>(fn: (sql: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new Bun.SQL(pg.url);
  try { return await fn(sql); } finally { await sql.end(); }
}
const ledger = async () => (await db.open())`SELECT id, name FROM migration ORDER BY id`;
const hasRunningAgents = async () =>
  (await (await db.open())`SELECT 1 FROM information_schema.columns WHERE table_name = 'instance_metric' AND column_name = 'running_agents' AND table_schema = current_schema()`).length === 1;
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; logged: string[] }> {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try { return { result: await fn(), logged }; } catch (error) { return { error, logged }; } finally { console.error = orig; }
}

const numbered = () => db.MIGRATIONS.filter((s) => s.id != null);

test("a fresh database records every step under its name", async () => {
  const rows = await ledger();
  expect(rows.map((r: { id: number; name: string }) => [Number(r.id), r.name])).toEqual(numbered().map((s) => [s.id, s.name]));
  expect(await hasRunningAgents()).toBe(true);
  expect(db.migrationReport()).toMatchObject({ mismatches: [], refused: [], unknown: [] });
});

test("main's 13 recorded under another branch's name is reported loudly and re-run, healing the column", async () => {
  await db.open();
  await db.close();
  // The incident: a foreign 13 holds the id, and main's column never got added.
  await raw(async (sql) => {
    await sql`ALTER TABLE instance_metric DROP COLUMN running_agents`;
    await sql`UPDATE migration SET name = 'notification' WHERE id = 13`;
    await sql`INSERT INTO migration (id, applied_at, name) VALUES (99, 0, 'from-a-branch')`;
  });
  const { error, logged } = await captureErrors(() => db.open());
  expect(error).toBeUndefined();
  expect(logged.filter((l) => l.includes("MIGRATION MISMATCH"))).toEqual([
    `orca: MIGRATION MISMATCH — migration 13 is recorded as "notification" but this code's 13 is "instance-metric-running-agents" — not treated as applied; re-running it (idempotent)`,
  ]);
  expect(logged.some((l) => l.includes("migration 99") && l.includes("no such step"))).toBe(true);
  expect(await hasRunningAgents()).toBe(true);
  expect((await ledger()).find((r: { id: number }) => Number(r.id) === 13).name).toBe("instance-metric-running-agents");
  // /api/diagnostics carries the same verdict.
  expect(db.migrationReport()).toMatchObject({
    mismatches: [{ id: 13, recorded: "notification", expected: "instance-metric-running-agents", idempotent: true }],
    unknown: [{ id: 99, name: "from-a-branch" }],
  });
  await db.recordMetric({ cpuPct: 1, load1: 0, memUsedGb: 1, memTotalGb: 2, runningAgents: 3 });
  expect((await db.metricHistory(db.instanceName(), 1))[0]!.runningAgents).toBe(3);
});

test("a ledger from before names (the shared database today): unnamed idempotent steps re-run, the rest are stamped", async () => {
  await db.open();
  await db.close();
  await raw(async (sql) => {
    await sql`ALTER TABLE instance_metric DROP COLUMN running_agents`;
    await sql`ALTER TABLE migration DROP COLUMN name`;
  });
  const { error, logged } = await captureErrors(() => db.open());
  expect(error).toBeUndefined();
  expect(logged.filter((l) => l.includes("MISMATCH"))).toEqual([]); // no name isn't a conflict
  expect(await hasRunningAgents()).toBe(true);
  expect((await ledger()).map((r: { name: string }) => r.name)).toEqual(numbered().map((s) => s.name));
});

test("a mismatch on a step that isn't idempotent refuses to start, with instructions", async () => {
  await db.open();
  await db.close();
  await raw((sql) => sql`UPDATE migration SET name = 'someone-elses-3' WHERE id = 3`);
  const { error, logged } = await captureErrors(() => db.open());
  expect(error).toBeInstanceOf(db.MigrationRefused);
  const message = (error as Error).message;
  expect(message).toContain("refusing to start");
  expect(message).toContain(`migration 3 is recorded as "someone-elses-3" but this code's 3 is "repo-features-backfill"`);
  expect(message).toContain("UPDATE migration SET name");
  expect(message).toContain("bun run db:check");
  expect(logged.some((l) => l.includes("MIGRATION MISMATCH") && l.includes("migration 3"))).toBe(true);
});

test("every step named uniquely, ids strictly increasing, and an idempotent step is IF NOT EXISTS throughout", () => {
  // checkSteps: unique names, numbered steps increasing (16 is a gap — #152 held it, then moved to a
  // named step) and frozen at LAST_NUMBERED_ID, named steps YYYYMMDD-slug, idempotent, in name order.
  expect(db.checkSteps(db.MIGRATIONS)).toEqual([]);
  for (const step of db.MIGRATIONS.filter((s) => s.idempotent)) {
    const statements = step.sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
    for (const st of statements) {
      // …or a backfill that only fills NULLs, so a re-run touches nothing it already wrote.
      expect(`${db.stepLabel(step)}: ${st}`).toMatch(/^[\w-]+: (CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS |ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS |UPDATE (\S+) .* AND \S+ IS NULL$)/i);
    }
  }
});

test("re-running every step on a migrated database is harmless", async () => {
  await db.open();
  await db.close();
  await raw((sql) => sql`UPDATE migration SET name = NULL`);
  const { error } = await captureErrors(() => db.open());
  expect(error).toBeUndefined();
  expect(db.migrationReport()!.run.map((s) => s.id)).toEqual(numbered().filter((s) => s.idempotent).map((s) => s.id));
  expect(db.migrationReport()!.stamp.map((s) => s.id)).toEqual([3]);
});

test("planMigrations: pending, matching, foreign and unknown ids", () => {
  const steps: db.MigrationStep[] = [
    { id: 1, name: "a", idempotent: true, sql: "" },
    { id: 2, name: "b", idempotent: false, sql: "" },
    { id: 3, name: "c", idempotent: true, sql: "" },
    { id: 4, name: "d", idempotent: true, sql: "" },
  ];
  const plan = db.planMigrations(steps, [{ id: 1, name: "a" }, { id: 2, name: "x" }, { id: 3, name: "y" }, { id: 7, name: null }]);
  expect(plan.run.map((s) => s.id)).toEqual([3, 4]);
  expect(plan.refused.map((m) => m.id)).toEqual([2]);
  expect(plan.mismatches.map((m) => m.id)).toEqual([2, 3]);
  expect(plan.unknown).toEqual([{ id: 7, name: null }]);
});

test("under bun test, only an orca_test_ schema may be migrated — never the shared database a worktree's .env names", async () => {
  expect(db.testDatabaseRefusal("postgres://box:5432/orca")).toContain("refusing to open a non-test database");
  expect(db.testDatabaseRefusal(pg.url)).toBeUndefined();
  expect(db.testDatabaseRefusal("postgres://box:5432/orca", "production")).toBeUndefined();
  process.env.ORCA_DATABASE_URL = "postgres://127.0.0.1:1/orca";
  await expect(db.open()).rejects.toThrow("refusing to open a non-test database");
});

test("bun run db:check prints applied vs expected and exits 1 when a start would be refused", async () => {
  await db.open();
  await db.close();
  const check = () => {
    const p = Bun.spawnSync(["bun", "run", "scripts/db-check.ts"], { env: { ...process.env, ORCA_DATABASE_URL: pg.url }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  let r = check();
  expect(r.code).toBe(0);
  expect(r.out).toContain("13  instance-metric-running-agents");
  expect(r.out).toContain("result: up to date");

  await raw((sql) => sql`UPDATE migration SET name = 'notification' WHERE id = 13`);
  r = check();
  expect(r.code).toBe(0);
  expect(r.out).toContain(`MISMATCH: migration 13 is recorded as "notification"`);

  await raw((sql) => sql`UPDATE migration SET name = 'other' WHERE id = 3`);
  r = check();
  expect(r.code).toBe(1);
  expect(r.out).toContain("REFUSE to start");
});

// 2026-10-13: #132's `notification` table already existed on the shared database (an unmerged
// branch's bridge had created it under another id), its step was a plain CREATE TABLE, and both
// bridges crashed at boot on "relation already exists". Every step must be re-runnable.
test("every step is idempotent: marked so, and no bare CREATE TABLE / INDEX", () => {
  for (const s of db.MIGRATIONS) {
    // A pure data backfill (3) may be one-shot; anything that creates or alters schema must re-run cleanly.
    if (/\b(CREATE|ALTER)\b/.test(s.sql)) expect({ id: db.stepLabel(s), idempotent: s.idempotent }).toEqual({ id: db.stepLabel(s), idempotent: true });
    expect({ id: db.stepLabel(s), bare: s.sql.match(/CREATE (UNIQUE )?(TABLE|INDEX) (?!IF NOT EXISTS)/g) ?? [] }).toEqual({ id: db.stepLabel(s), bare: [] });
  }
});

test("a table a foreign branch already created does not crash the runner: its step is a no-op and gets recorded", async () => {
  await raw(async (sql) => {
    // The shape #132's branch created — same as main's 15, but no migration row for it.
    await sql.unsafe(db.MIGRATIONS.find((s) => s.name === "notification")!.sql);
  });
  const rows = await ledger();
  expect(rows.map((r: { id: number; name: string }) => r.name)).toContain("notification");
  expect(db.migrationReport()).toMatchObject({ refused: [] });
});

// ---- named steps: no integer to collide on ----
// Parallel branches each took "the next id" (16/17/18 had to be reserved by hand). Every step after
// LAST_NUMBERED_ID is identified by a YYYYMMDD-slug name, recorded in `migration_named`, and pending
// named steps apply in name order — so two branches that never coordinated land in one stable order.

const step = (name: string, table: string): db.MigrationStep =>
  ({ name, idempotent: true, sql: `CREATE TABLE IF NOT EXISTS ${table} (id INT)` });
// Two branches, cut the same day from main, each adding one step without knowing of the other.
const fromA = step("29991013-placeholder-a", "branch_a");
const fromB = step("29991014-placeholder-b", "branch_b");
const namedLedger = async () => (await db.open())`SELECT name FROM migration_named ORDER BY applied_at, name`;
const hasTable = async (t: string) => (await (await db.open())`SELECT to_regclass(${t}) AS t`)[0].t !== null;
// A fixture name guaranteed not to collide with a real step's — derived from the real list, so these
// tests can't silently start colliding again the way "attachment"/16 did once #152 landed for real.
const realStepNames = new Set(db.MIGRATIONS.map((s) => s.name));
// The real named steps (no id) — on a database with no named ledger yet, they apply first, in order.
const realNamed = db.MIGRATIONS.filter((s) => s.id === undefined).map((s) => s.name);
const placeholderName = (base: string): string => {
  let name = base;
  while (realStepNames.has(name)) name += "-x";
  return name;
};

/** A database as the shared one is today: every real numbered step applied, nothing named yet. */
async function sharedDatabaseBeforeNamedSteps() {
  await db.open();
  await db.close();
  await raw((sql) => sql`DROP TABLE migration_named`);
}

test("two branches' steps, merged in either order, apply in the same name order on a fully-numbered database", async () => {
  await sharedDatabaseBeforeNamedSteps();
  const recorded = await raw((sql) => db.recordedMigrations(sql));
  // The merged code holds both steps; whichever way the array came out of the merge, the plan is one order.
  const planAB = db.planMigrations([...db.MIGRATIONS, fromA, fromB], recorded);
  const planBA = db.planMigrations([...db.MIGRATIONS, fromB, fromA], recorded);
  expect(planAB.run.map(db.stepLabel)).toEqual([...realNamed, "29991013-placeholder-a", "29991014-placeholder-b"]);
  expect(planBA.run.map(db.stepLabel)).toEqual(planAB.run.map(db.stepLabel));
  // …and the gate catches the array that disagrees with apply order.
  expect(db.checkSteps([...db.MIGRATIONS, fromB, fromA])).toEqual([
    `named step "29991013-placeholder-a" sorts before "29991014-placeholder-b" above it — named steps apply in name order; re-date it, or move it above if it doesn't depend on that step`,
  ]);

  // Applied for real: B merges and deploys first, then A lands. Neither needed to know the other's number.
  await raw((sql) => db.applyMigrations(sql, [...db.MIGRATIONS, fromB]));
  await raw((sql) => db.applyMigrations(sql, [...db.MIGRATIONS, fromA, fromB]));
  expect(await hasTable("branch_a")).toBe(true);
  expect(await hasTable("branch_b")).toBe(true);
  expect((await namedLedger()).map((r: { name: string }) => r.name).sort()).toEqual([...realNamed, "29991013-placeholder-a", "29991014-placeholder-b"].sort());
  // The numbered ledger is untouched by named steps.
  expect((await ledger()).map((r: { id: number }) => Number(r.id))).toEqual(numbered().map((s) => s.id));
  // A further start is a no-op.
  await raw((sql) => db.applyMigrations(sql, [...db.MIGRATIONS, fromA, fromB]));
  expect(db.migrationReport()).toMatchObject({ run: [], mismatches: [], refused: [], unknown: [] });
});

test("a step a branch once applied under a numbered id outside today's range just re-runs as its named step", async () => {
  await sharedDatabaseBeforeNamedSteps();
  // #152's test database before the rebase: its step recorded under a numbered id instead of its
  // name. The id just has to be one this code never uses — LAST_NUMBERED_ID is frozen, so one past it
  // can never become real.
  const foreignId = db.LAST_NUMBERED_ID + 1;
  await raw(async (sql) => {
    await sql.unsafe(fromA.sql);
    await sql`INSERT INTO migration (id, applied_at, name) VALUES (${foreignId}, 0, ${placeholderName("attachment")})`;
  });
  const { error, logged } = await captureErrors(() => raw((sql) => db.applyMigrations(sql, [...db.MIGRATIONS, fromA])));
  expect(error).toBeUndefined();
  expect(logged.some((l) => l.includes(`migration ${foreignId}`) && l.includes("no such step"))).toBe(true);
  expect((await namedLedger()).map((r: { name: string }) => r.name).filter((n: string) => !realNamed.includes(n))).toEqual(["29991013-placeholder-a"]);
});

test("an older bridge (numbered ledger only) is unaffected by the named ledger", async () => {
  await raw((sql) => db.applyMigrations(sql, [...db.MIGRATIONS, fromA]));
  // What an older main reads: `migration` alone — no row it can't parse, nothing unknown.
  const plan = db.planMigrations(numbered(), (await ledger()).map((r: { id: number; name: string }) => ({ id: Number(r.id), name: r.name })));
  expect(plan).toMatchObject({ run: [], unknown: [], mismatches: [] });
});

test("checkSteps refuses a new numbered step, a bad name, and a non-idempotent named step", async () => {
  const name = placeholderName("attachment");
  expect(db.checkSteps([...db.MIGRATIONS, { id: db.LAST_NUMBERED_ID + 1, name, idempotent: true, sql: "" }]))
    .toContain(`step ${db.LAST_NUMBERED_ID + 1} ("${name}"): numbered steps are frozen at ${db.LAST_NUMBERED_ID} — drop the id and name it YYYYMMDD-slug`); // (and, after a real named step, out of order too)
  expect(db.checkSteps([...db.MIGRATIONS, { name, idempotent: true, sql: "" }])).toEqual([`named step "${name}" must be YYYYMMDD-slug`]);
  expect(db.checkSteps([...db.MIGRATIONS, { ...fromA, idempotent: false }])).toEqual([`named step "29991013-placeholder-a" must be idempotent`]);
  expect(db.checkSteps([...db.MIGRATIONS, fromA, fromA])).toEqual([`duplicate migration name "29991013-placeholder-a"`]);
  await expect(raw((sql) => db.applyMigrations(sql, [...db.MIGRATIONS, { id: db.LAST_NUMBERED_ID + 1, name: "x", idempotent: true, sql: "" }]))).rejects.toThrow("frozen");
});

test("18 tags the orchestrator's turns with their source — reports alone are the agents', anything you said is yours", async () => {
  await db.open();
  const at = Date.now();
  const add = (branch: string, runId: string, instruction: string | undefined, prompt = "p") =>
    db.startTurn({ repo: branch === "orchestrator" ? "@orca" : "r", branch, runId, provider: "claude", instruction, prompt, startedAt: at });
  await add("orchestrator", "reports", "[worker finished] r/a — done\nOutcome: ok\n\n[worker finished] r/b — error\nResponse: boom");
  await add("orchestrator", "mixed", "[worker finished] r/a — done\nOutcome: ok\n\ncarry on");
  await add("orchestrator", "typed", "ship the cache");
  await add("orchestrator", "legacy", undefined, "You are Orca's orchestrator\n\n## New\n[worker finished] r/c — done\nOutcome: ok");
  await add("feature", "worker", "[worker finished] looks like one but is a worker's own turn");
  // A row the bridge wrote with its source (after this step) is never rewritten.
  await db.startTurn({ repo: "@orca", branch: "orchestrator", runId: "written", provider: "claude", instruction: "[worker finished] r/d — done", prompt: "p", startedAt: at, source: "human" });

  await (await db.open()).unsafe(db.MIGRATIONS.find((m) => m.id === 18)!.sql); // the backfill, re-run: idempotent
  const sourceOf = async (branch: string) =>
    Object.fromEntries((await db.turns(branch === "orchestrator" ? "@orca" : "r", branch)).map((t) => [t.id, t.source]));
  expect(await sourceOf("orchestrator")).toEqual({ reports: "agents", mixed: "human", typed: "human", legacy: "agents", written: "human" });
  expect(await sourceOf("feature")).toEqual({ worker: undefined });
  expect(db.MIGRATIONS.find((m) => m.id === 18)).toMatchObject({ name: "turn-source", idempotent: true });
});
