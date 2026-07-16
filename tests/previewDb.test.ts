// Per-preview Postgres isolation: each preview gets its own database via a `{db}` placeholder Orca
// substitutes into the preview command (create-from-snapshot + migrate), and an onStop hook that
// drops that database on teardown (Discard / preview-stop) — but NOT on the reap-before-restart.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewDbName, start, stop } from "../server/preview";

test("previewDbName is deterministic, unique per worktree, and a valid Postgres/MikroORM identifier", () => {
  const a = previewDbName("/dev/branch-demo/.worktrees/views-storage-migration-ab12cd");
  const b = previewDbName("/dev/branch-demo/.worktrees/review-filters-99ffee");

  const IDENT = /^[a-z][a-z0-9_]{0,62}$/; // MikroORM's DB_NAME rule; ≤63 for Postgres
  expect(a).toMatch(IDENT);
  expect(b).toMatch(IDENT);
  expect(a).toContain("views_storage_migration"); // readable slug of the branch
  expect(a).not.toBe(b); // different worktrees → different DBs
  expect(previewDbName("/dev/branch-demo/.worktrees/views-storage-migration-ab12cd")).toBe(a); // stable
  // Same slug, different full path → the hash keeps them distinct (no accidental shared DB).
  expect(previewDbName("/a/feat-x")).not.toBe(previewDbName("/b/feat-x"));
});

test("{db} is substituted into the command, and onStop runs ONLY on teardown", async () => {
  const key = await mkdtemp(join(tmpdir(), "orca-previewdb-"));
  await writeFile(join(key, "seed"), "ready");
  const db = previewDbName(key);
  const service = {
    name: "backend",
    command: `printf '%s' '{db}' > cmd.out`,      // runs with cwd=key
    onStop: `printf '%s' '{db}' > stop.out`,      // the drop-database hook
  };

  // --- reap (teardown=false): onStop must NOT fire ---
  await start(key, key, [service], [20000, 30000]);
  for (let i = 0; i < 20 && !existsSync(join(key, "cmd.out")); i++) await Bun.sleep(25);
  expect(await readFile(join(key, "cmd.out"), "utf8")).toBe(db); // {db} resolved in the command
  stop(key); // plain reap
  expect(existsSync(join(key, "stop.out"))).toBe(false); // a restart must not drop the DB

  // --- teardown=true: onStop fires with {db} resolved ---
  await start(key, key, [service], [20000, 30000]);
  stop(key, true);
  expect(await readFile(join(key, "stop.out"), "utf8")).toBe(db); // dropped by name on teardown
});
