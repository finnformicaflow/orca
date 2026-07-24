// The Orca-hosted preview dep self-heal (scripts/preview-deps.sh): reinstall a worktree's node_modules
// ONLY when it's missing/partial or has drifted from its lockfile, so a stale CoW clone (main behind a
// branch's dep bump — e.g. ai v6→v7) self-heals without a full install on every preview start. Driven
// hermetically with a fake `npm` on PATH (like the gh shim) so no real install runs. See orca.config's
// `previewDeps`.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/preview-deps.sh");
const T0 = new Date("2020-01-01T00:00:00Z");
const T1 = new Date("2020-01-02T00:00:00Z"); // strictly later than T0

// A project dir + a fake `npm` that records it ran (touches .npm-ran) instead of installing anything.
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "orca-pdeps-"));
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npm"), `#!/usr/bin/env bash\ntouch "${dir}/.npm-ran"\n`, { mode: 0o755 });
  return dir;
}
const run = (dir: string): Promise<number> =>
  Bun.spawn(["bash", SCRIPT, "."], { cwd: dir, env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" }).exited;
const installed = (dir: string) => existsSync(join(dir, ".npm-ran"));

async function project(dir: string, { marker }: { marker?: Date | null } = {}) {
  await writeFile(join(dir, "package.json"), "{}\n");
  await writeFile(join(dir, "package-lock.json"), "{}\n");
  await utimes(join(dir, "package-lock.json"), T1, T1); // lockfile at T1
  await mkdir(join(dir, "node_modules"), { recursive: true });
  if (marker !== null) {
    const m = join(dir, "node_modules/.orca-deps-ok");
    await writeFile(m, "");
    await utimes(m, marker ?? T0, marker ?? T0);
  }
}

test("no package.json → fails loudly (wrong dir / unprovisioned)", async () => {
  const dir = await scratch();
  expect(await run(dir)).not.toBe(0);
});

test("in sync (marker newer than lockfile) → fast path, no install", async () => {
  const dir = await scratch();
  await project(dir, { marker: T1 }); // marker == lockfile time, so lock is NOT newer
  expect(await run(dir)).toBe(0);
  expect(installed(dir)).toBe(false); // npm never ran
});

test("lockfile newer than the marker (a stale clone / dep bump) → reinstall", async () => {
  const dir = await scratch();
  await project(dir, { marker: T0 }); // marker older than the T1 lockfile → drift
  expect(await run(dir)).toBe(0);
  expect(installed(dir)).toBe(true);
});

test("missing marker (a fresh clone that never installed here) → reinstall", async () => {
  const dir = await scratch();
  await project(dir, { marker: null });
  expect(await run(dir)).toBe(0);
  expect(installed(dir)).toBe(true);
});
