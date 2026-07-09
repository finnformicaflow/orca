// The branch-demo backend preview runs against a shared node_modules that every worktree symlinks.
// An `npm install` into that tree sometimes lands @nestjs/cli's bin/nest.js without its execute bit,
// so `npx nest` dies with "Permission denied" in EVERY worktree. The backend preview command carries
// a self-heal guard for this; this test runs the ACTUAL guard (pulled from orca.config, so it can't
// drift) against a scratch node_modules and asserts it restores the bit — and is a no-op when healthy.
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "../orca.config";

const backendCmd = () => {
  const cmd = config.repos.find((r) => r.name === "branch-demo")?.previewServices.find((s) => s.name === "backend")?.command;
  if (!cmd) throw new Error("branch-demo backend command not found");
  return cmd;
};

/** The `{ [ -x node_modules/.bin/nest ] || chmod +x …; }` sub-expression out of the real command. */
function nestGuard(): string {
  const m = backendCmd().match(/\{ \[ -x node_modules\/\.bin\/nest \][^}]*\}/);
  if (!m) throw new Error("nest chmod guard not found in branch-demo backend command");
  return m[0];
}

/** The `find node_modules … -exec rm -rf {} +` staging-dir sweep out of the real command. */
function stagingSweep(): string {
  const m = backendCmd().match(/find -E node_modules[^&]*rm -rf \{\} \+/);
  if (!m) throw new Error("staging-dir sweep not found in branch-demo backend command");
  return m[0];
}

/** The `{ bash scripts/migrate-local.sh || { … } || { … }; }` retry block out of the real command. */
function migrateRetry(): string {
  const m = backendCmd().match(/\{ bash scripts\/migrate-local\.sh[\s\S]*?migrate-local\.sh; \}; \}/);
  if (!m) throw new Error("migrate retry block not found in branch-demo backend command");
  return m[0];
}

/** Run the real retry block with `migrate-local.sh` swapped for a command that fails until its
 *  Nth call (counter file), and sleeps zeroed. Returns the overall exit code. */
async function runRetryWithFlaky(succeedsOnAttempt: number): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "orca-retry-"));
  const cf = join(dir, "count");
  const flaky = join(dir, "flaky.sh");
  await writeFile(flaky, `#!/bin/bash\nc=$(cat "${cf}" 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > "${cf}"\n[ "$c" -ge ${succeedsOnAttempt} ]\n`);
  await chmod(flaky, 0o755);
  const script = migrateRetry()
    .replaceAll("bash scripts/migrate-local.sh", `bash ${flaky}`)
    .replaceAll("sleep 3", "sleep 0").replaceAll("sleep 5", "sleep 0");
  const p = Bun.spawn(["bash", "-c", script], { stdout: "ignore", stderr: "ignore" });
  return p.exited;
}

/** Scratch node_modules with a `.bin/nest` symlink → @nestjs/cli/bin/nest.js at the given mode. */
async function scratchTree(mode: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-nest-"));
  await mkdir(join(dir, "node_modules/@nestjs/cli/bin"), { recursive: true });
  await mkdir(join(dir, "node_modules/.bin"), { recursive: true });
  const target = join(dir, "node_modules/@nestjs/cli/bin/nest.js");
  await writeFile(target, "#!/usr/bin/env node\n");
  await chmod(target, mode);
  await symlink("../@nestjs/cli/bin/nest.js", join(dir, "node_modules/.bin/nest"));
  return dir;
}

const isExec = async (p: string) => Boolean((await stat(p)).mode & 0o111);

test("backend preflight self-heals a nest bin that lost its execute bit", async () => {
  const dir = await scratchTree(0o644); // stripped, as a bad npm install leaves it
  const nest = join(dir, "node_modules/@nestjs/cli/bin/nest.js");
  expect(await isExec(nest)).toBe(false);
  const p = Bun.spawn(["bash", "-c", nestGuard()], { cwd: dir, stderr: "ignore" });
  expect(await p.exited).toBe(0);
  expect(await isExec(nest)).toBe(true);
});

test("backend preflight is a no-op when the nest bin is already executable", async () => {
  const dir = await scratchTree(0o755);
  const nest = join(dir, "node_modules/@nestjs/cli/bin/nest.js");
  const p = Bun.spawn(["bash", "-c", nestGuard()], { cwd: dir, stderr: "ignore" });
  expect(await p.exited).toBe(0);
  expect(await isExec(nest)).toBe(true);
});

test("staging-dir sweep removes orphaned npm scratch dirs but keeps real packages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-staging-"));
  await mkdir(join(dir, "node_modules/@types/.compression-8Z3tFSKG"), { recursive: true }); // npm scratch
  await mkdir(join(dir, "node_modules/@types/compression"), { recursive: true }); // real package
  await mkdir(join(dir, "node_modules/.bin"), { recursive: true }); // must survive (no -<random> suffix)
  await writeFile(join(dir, "node_modules/.package-lock.json"), "{}"); // must survive
  const p = Bun.spawn(["bash", "-c", stagingSweep()], { cwd: dir, stderr: "ignore" });
  expect(await p.exited).toBe(0);
  const exists = (rel: string) => stat(join(dir, rel)).then(() => true, () => false);
  expect(await exists("node_modules/@types/.compression-8Z3tFSKG")).toBe(false);
  expect(await exists("node_modules/@types/compression")).toBe(true);
  expect(await exists("node_modules/.bin")).toBe(true);
  expect(await exists("node_modules/.package-lock.json")).toBe(true);
});

test("migrate retry rides out a transient failure (succeeds by the 3rd attempt)", async () => {
  expect(await runRetryWithFlaky(1)).toBe(0); // succeeds first try
  expect(await runRetryWithFlaky(2)).toBe(0); // fails once, retry succeeds
  expect(await runRetryWithFlaky(3)).toBe(0); // fails twice, third succeeds
});

test("migrate retry still surfaces a genuine failure (all 3 attempts fail → non-zero)", async () => {
  expect(await runRetryWithFlaky(4)).not.toBe(0); // never succeeds within 3 tries
});
