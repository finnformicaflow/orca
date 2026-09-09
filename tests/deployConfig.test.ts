// Deployment hygiene: the things a fresh box trips over. Every ORCA_* variable the server reads is
// documented in .env.example (so a setting can't exist only in someone's head), the instance name
// falls back to the real hostname rather than a shell variable systemd never exports, and the
// systemd unit runs the same entrypoint package.json does.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { instanceName } from "../server/db";

const root = join(import.meta.dir, "..");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
});

test("every ORCA_* variable the server reads is documented in .env.example", () => {
  const read = new Set<string>();
  for (const f of [...files(join(root, "server")), join(root, "orca.config.ts")]) {
    for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.(ORCA_[A-Z_]+)/g)) read.add(m[1]!);
  }
  read.delete("ORCA_CLAUDE_USAGE_URL"); // test-only override, deliberately undocumented
  const documented = new Set([...readFileSync(join(root, ".env.example"), "utf8").matchAll(/^#?\s*(ORCA_[A-Z_]+)=/gm)].map((m) => m[1]!));
  expect([...read].filter((v) => !documented.has(v))).toEqual([]);
});

test("the instance name defaults to the machine's hostname, not a shell variable", () => {
  const prev = process.env.ORCA_INSTANCE;
  delete process.env.ORCA_INSTANCE;
  try {
    expect(instanceName()).toBe(hostname());
    expect(instanceName()).not.toBe("local");
    process.env.ORCA_INSTANCE = "cloud";
    expect(instanceName()).toBe("cloud");
  } finally {
    if (prev === undefined) delete process.env.ORCA_INSTANCE; else process.env.ORCA_INSTANCE = prev;
  }
});

test("the systemd unit starts the same entrypoint as `bun run server`", () => {
  const unit = readFileSync(join(root, "deploy", "orca.service"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const entry = pkg.scripts.server!.replace(/^bun run /, "");
  expect(unit).toContain(`ExecStart=/home/orca/.bun/bin/bun run ${entry}`);
  expect(unit).toContain("KillSignal=SIGTERM"); // the "deploy, not Ctrl-C" signal the bridge distinguishes
});
