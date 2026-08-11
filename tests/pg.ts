// A throwaway Postgres schema per test file, so the suite exercises the SAME engine the app runs on.
// (The alternative — keeping SQLite for tests — would mean maintaining two SQL dialects, where the
// tests stop proving the thing that actually ships.)
//
// Isolation is by schema, not by database: `CREATE SCHEMA` + a connection whose `search_path` points
// at it is near-instant, where creating a database per file costs hundreds of ms. The schema is
// dropped afterwards, so a crashed run leaves at most one stray `orca_test_*` schema.
//
// Point ORCA_TEST_DATABASE_URL at any Postgres; it defaults to a local one.
const BASE_URL = process.env.ORCA_TEST_DATABASE_URL || "postgres://localhost:5432/postgres";

let counter = 0;

export type TestDb = { url: string; drop: () => Promise<void> };

/** Create an isolated schema and return a URL scoped to it. Call `drop()` when the file is done. */
export async function freshSchema(label = "t"): Promise<TestDb> {
  // Unique per (process, file, call) — Math.random is unavailable in some runtimes we target, and a
  // counter plus the pid is enough for tests that never run twice in one process.
  const name = `orca_test_${process.pid}_${label.replace(/[^a-z0-9]+/gi, "")}_${++counter}`.toLowerCase();
  const admin = new Bun.SQL(BASE_URL);
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${name}`);
  const url = `${BASE_URL}${BASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${name}`)}`;
  return {
    url,
    drop: async () => {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}
