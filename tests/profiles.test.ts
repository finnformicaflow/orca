// Claude account profiles (server/profiles.ts): a profile is a CLAUDE_CONFIG_DIR, the next run goes
// to whichever login has headroom, and a native session follows a switch by file copy — so an
// account change is lossless rather than a bounded-transcript handoff. Real filesystem for the copy,
// a real Postgres for the config round trip, a fake `claude` on PATH for the launch environment.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { copySession, keychainService, pickProfile, profilesOf, projectSlug } from "../server/profiles";
import { invalidateConfig, loadConfig, parseConfigDocument, saveConfigDocument } from "../server/config";
import * as db from "../server/db";
import * as agent from "../server/agent";
import { freshSchema, type TestDb } from "./pg";
import type { ClaudeUsage } from "../server/usage";

const usage = (fiveHour: number, sevenDay = 0): ClaudeUsage => ({
  fiveHour: { utilization: fiveHour, resetsAt: null }, sevenDay: { utilization: sevenDay, resetsAt: null }, extra: null,
});

test("no configured profiles means the CLI's default login, and no switching", () => {
  expect(profilesOf(undefined)).toEqual([{ name: "default", configDir: join(homedir(), ".claude") }]);
  expect(profilesOf([])).toHaveLength(1);
  expect(profilesOf([{ name: "work", configDir: "/p/work" }])).toEqual([{ name: "work", configDir: "/p/work" }]);
});

test("the Keychain service name matches the CLI's own derivation for a custom config dir", () => {
  // Read out of claude 2.1.263: bare name for the default dir, else "-" + sha256(dir)[0:8].
  expect(keychainService(join(homedir(), ".claude"))).toBe("Claude Code-credentials");
  const dir = "/Users/me/.claude-work";
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  expect(keychainService(dir)).toBe(`Claude Code-credentials-${hash}`);
});

test("the next run stays on the session's owner until it runs low, then takes the freest login", () => {
  const profiles = [
    { name: "personal", usage: usage(85, 40) },
    { name: "work", usage: usage(10, 70) },
    { name: "spare", usage: usage(10, 20) },
  ];
  // Owner has headroom under the threshold → stay (a resume there is free).
  expect(pickProfile(profiles, "personal", 90)).toBe("personal");
  // Owner crossed the threshold → lowest five-hour, weekly breaks the tie.
  expect(pickProfile(profiles, "personal", 80)).toBe("spare");
  // No owner yet (first run of a conversation) → freest login.
  expect(pickProfile(profiles, undefined, 90)).toBe("spare");
  // Unknown usage (not logged in / endpoint down) never beats a known one; an owner with unknown
  // usage is kept rather than bounced on a guess.
  expect(pickProfile([{ name: "a", usage: null }, { name: "b", usage: usage(95) }], undefined, 90)).toBe("b");
  expect(pickProfile([{ name: "a", usage: null }, { name: "b", usage: usage(5) }], "a", 90)).toBe("a");
  expect(pickProfile([{ name: "a", usage: null }, { name: "b", usage: null }], undefined, 90)).toBe("a");
});

test("a native session follows an account switch by copying its transcript into the other profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "orca-profiles-"));
  try {
    const from = join(root, "personal"), to = join(root, "work");
    const cwd = "/Users/me/dev/app/.worktrees/feat-x";
    expect(projectSlug(cwd)).toBe("-Users-me-dev-app--worktrees-feat-x"); // the CLI's rule, verified against a real ~/.claude/projects
    const src = join(from, "projects", projectSlug(cwd));
    await mkdir(join(src, "sess-1", "subagents"), { recursive: true });
    await writeFile(join(src, "sess-1.jsonl"), '{"type":"user"}\n');
    await writeFile(join(src, "sess-1", "subagents", "a.jsonl"), "{}\n");

    expect(await copySession(from, to, cwd, "sess-1")).toBe(true);
    const dst = join(to, "projects", projectSlug(cwd));
    expect(await readFile(join(dst, "sess-1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
    expect((await stat(join(dst, "sess-1", "subagents", "a.jsonl"))).isFile()).toBe(true);
    // The source stays — the old profile can still resume it if usage swings back.
    expect((await stat(join(src, "sess-1.jsonl"))).isFile()).toBe(true);

    // Nothing to copy → false, so the caller falls back to the portable transcript instead of
    // resuming into "No conversation found".
    expect(await copySession(from, to, cwd, "sess-missing")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- config round trip (real Postgres) ----
let pg: TestDb;
let prevDbUrl: string | undefined;
let prevDevRoot: string | undefined;
beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  prevDevRoot = process.env.ORCA_DEV_ROOT;
  pg = await freshSchema("profiles");
  process.env.ORCA_DATABASE_URL = pg.url;
  process.env.ORCA_DEV_ROOT = "/machine-a/dev";
  await db.close();
  invalidateConfig();
});
afterEach(async () => {
  await agent.flushHistory();
  await db.close();
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
  if (prevDevRoot === undefined) delete process.env.ORCA_DEV_ROOT; else process.env.ORCA_DEV_ROOT = prevDevRoot;
  invalidateConfig();
});

const doc = (over: Record<string, unknown> = {}) => ({
  repos: [{ name: "app", repoPath: "${ORCA_DEV_ROOT}/app", worktreeRoot: "${ORCA_DEV_ROOT}/app/.worktrees", baseBranch: "main" }],
  portRange: [30000, 40000], staleHours: 24,
  ...over,
});

test("profiles are validated, stored as portable paths, and expanded per machine", async () => {
  const bad = parseConfigDocument(doc({ claudeProfiles: [{ name: "a", configDir: "/x" }, { name: "a" }], profileSwitchPct: 150 }));
  expect(bad.errors).toContain('claudeProfiles[1].name "a" is duplicated');
  expect(bad.errors).toContain("claudeProfiles[1].configDir is required");
  expect(bad.errors).toContain("profileSwitchPct must be a percentage between 1 and 100");

  const good = parseConfigDocument(doc({
    claudeProfiles: [{ name: "personal", configDir: "~/.claude" }, { name: "work", configDir: "${ORCA_DEV_ROOT}/../.claude-work" }],
    profileSwitchPct: 80,
  }));
  expect(good.errors).toEqual([]);
  await saveConfigDocument(good.config!);
  const cfg = await loadConfig();
  expect(cfg.profileSwitchPct).toBe(80);
  expect(cfg.claudeProfiles?.map((p) => p.name)).toEqual(["personal", "work"]);
  expect(cfg.claudeProfiles?.[0]?.configDir).toBe(join(homedir(), ".claude"));
  expect(cfg.claudeProfiles?.[1]?.configDir).toBe("/machine-a/dev/../.claude-work");
});

test("a run launched on a profile gets that profile's CLAUDE_CONFIG_DIR and records it on its turn", async () => {
  const state = await mkdtemp(join(tmpdir(), "orca-state-"));
  const shim = await mkdtemp(join(tmpdir(), "orca-claude-"));
  // The fake CLI reports the config dir it was given, the way the real one would read its login from it.
  await writeFile(join(shim, "claude"), `#!/bin/sh\nprintf '{"result":"dir=%s","is_error":false}' "$CLAUDE_CONFIG_DIR"\n`);
  await chmod(join(shim, "claude"), 0o755);
  const prevPath = process.env.PATH, prevState = process.env.ORCA_STATE_DIR;
  process.env.PATH = `${shim}:${prevPath}`;
  process.env.ORCA_STATE_DIR = state;
  const wt = join(state, "wt");
  await mkdir(wt);
  try {
    await agent.runAgent(wt, "hello", { repo: "r", branch: "feat", provider: "claude", profile: "work", configDir: "/profiles/work" });
    while (agent.status(wt).status === "running") await new Promise((r) => setTimeout(r, 25));
    for (let i = 0; i < 200 && !(await db.turns("r", "feat"))[0]?.finishedAt; i++) await new Promise((r) => setTimeout(r, 25));
    const [turn] = await db.turns("r", "feat");
    expect(turn?.response).toBe("dir=/profiles/work");
    expect(agent.status(wt).meta?.profile).toBe("work");
  } finally {
    process.env.PATH = prevPath;
    if (prevState === undefined) delete process.env.ORCA_STATE_DIR; else process.env.ORCA_STATE_DIR = prevState;
    agent.stop(wt);
    await rm(shim, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
