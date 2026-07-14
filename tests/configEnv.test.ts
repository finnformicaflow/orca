// orca.config resolves every repo path against ORCA_DEV_ROOT and must fail loudly when it's unset,
// rather than silently defaulting to a wrong base dir. Exercised in a subprocess so we control the
// env the config module sees at import time (the in-process import is cached + preloaded).
import { test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const IMPORT_CONFIG = "await import('./orca.config.ts')";

async function importConfig(env: Record<string, string | undefined>) {
  const proc = Bun.spawn(["bun", "-e", IMPORT_CONFIG], { cwd: ROOT, env, stdout: "ignore", stderr: "pipe" });
  return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
}

test("orca.config fails loudly when ORCA_DEV_ROOT is unset", async () => {
  const { ORCA_DEV_ROOT: _drop, ...bare } = process.env;
  const { code, stderr } = await importConfig(bare);
  expect(code).not.toBe(0);
  expect(stderr).toContain("ORCA_DEV_ROOT");
});

test("orca.config loads when ORCA_DEV_ROOT is set", async () => {
  const { code } = await importConfig({ ...process.env, ORCA_DEV_ROOT: `${process.env.HOME}/Documents` });
  expect(code).toBe(0);
});
