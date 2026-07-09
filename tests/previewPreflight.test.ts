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

/** The `{ [ -x node_modules/.bin/nest ] || chmod +x …; }` sub-expression out of the real command. */
function nestGuard(): string {
  const cmd = config.repos.find((r) => r.name === "branch-demo")?.previewServices.find((s) => s.name === "backend")?.command;
  const m = cmd?.match(/\{ \[ -x node_modules\/\.bin\/nest \][^}]*\}/);
  if (!m) throw new Error("nest chmod guard not found in branch-demo backend command");
  return m[0];
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
