// The Orca-hosted per-preview Postgres helper (scripts/preview-db.sh) guards its inputs BEFORE any
// psql call — so these run hermetically (no live DB): it must refuse bad identifiers, refuse to touch
// anything outside its own `orca_` namespace (a bad {db} can never hit the shared dev DB), and fail
// loudly when the worktree isn't provisioned (no .env). See orca.config's `previewDb`.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/preview-db.sh");

async function run(args: string[], cwd: string): Promise<number> {
  const p = Bun.spawn(["bash", SCRIPT, ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  return p.exited;
}

test("preview-db.sh refuses bad/dangerous names before touching Postgres", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-pdb-"));
  await writeFile(join(dir, ".env"), "PGPASSWORD=x\n"); // present, so we're past the provisioning guard

  expect(await run(["create"], dir)).not.toBe(0);            // missing db name → usage error
  expect(await run(["create", "Orca_Bad"], dir)).not.toBe(0); // uppercase → not a valid identifier
  expect(await run(["create", "orca_a;drop"], dir)).not.toBe(0); // injection chars → rejected
  expect(await run(["create", "branch_demo"], dir)).not.toBe(0); // valid ident but NOT orca_* → refused
  expect(await run(["drop", "branch_demo"], dir)).not.toBe(0);   // same guard on drop
  expect(await run(["frobnicate", "orca_x"], dir)).not.toBe(0);  // unknown subcommand
});

test("preview-db.sh skips ALTER on invalid databases so a re-run can reap them", async () => {
  // An interrupted clone leaves an INVALID database (pg datconnlimit = -2) that only DROP can clear;
  // ALTER on it raises a FATAL that kills the session before the DROP runs. The drop path must gate
  // its ALLOW_CONNECTIONS false on `datconnlimit <> -2`, or every re-run loops on the same failure.
  const script = await readFile(SCRIPT, "utf8");
  expect(script).toContain("datconnlimit <> -2");
});

test("preview-db.sh fails loudly when the worktree isn't provisioned (no .env)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-pdb-noenv-"));
  // Valid orca_ name, so it clears the name guards and reaches the .env check.
  expect(await run(["create", "orca_feature_ab12cd"], dir)).not.toBe(0);
});
