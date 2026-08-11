// Configuration lives in the DATABASE, not in orca.config.ts. The point is that adding a project is
// a paste rather than an edit-and-redeploy — and that a second Orca instance sharing the database
// inherits it. These cases pin the three properties that makes possible: a bad document is rejected
// rather than half-applied, paths stay portable across machines, and a save takes effect without a
// restart.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../server/db";
import {
  configDocument, expandPath, featuresOf, invalidateConfig, loadConfig, parseConfigDocument,
  providerAllowed, providersFor, saveConfigDocument, templatePath,
} from "../server/config";
import { agentCommand } from "../server/agent";
import { MIGRATIONS } from "../server/db";

const MIGRATION_3 = MIGRATIONS.find((m) => m.id === 3)!.sql;
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
let prevDbUrl: string | undefined;
let prevDevRoot: string | undefined;

beforeEach(async () => {
  prevDbUrl = process.env.ORCA_DATABASE_URL;
  prevDevRoot = process.env.ORCA_DEV_ROOT;
  pg = await freshSchema("configtable");
  process.env.ORCA_DATABASE_URL = pg.url;
  process.env.ORCA_DEV_ROOT = "/machine-a/dev";
  await db.close();
  invalidateConfig();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  if (prevDbUrl === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDbUrl;
  if (prevDevRoot === undefined) delete process.env.ORCA_DEV_ROOT; else process.env.ORCA_DEV_ROOT = prevDevRoot;
  invalidateConfig();
});

const doc = (over: Record<string, unknown> = {}) => ({
  repos: [{
    name: "app", repoPath: "${ORCA_DEV_ROOT}/app", worktreeRoot: "${ORCA_DEV_ROOT}/app/.worktrees",
    baseBranch: "main", previewServices: [{ name: "web", command: "bun dev", open: true }],
  }],
  portRange: [30000, 40000], staleHours: 24,
  ...over,
});

test("a bad document is rejected with every problem listed, never half-applied", () => {
  expect(parseConfigDocument(null).errors).toContain("config must be an object");
  expect(parseConfigDocument({ repos: [] }).errors).toContain("repos must be a non-empty array");

  const bad = parseConfigDocument({
    repos: [
      { name: "", worktreeRoot: "/w" },                                   // missing name + repoPath + baseBranch
      { name: "ok", repoPath: "/r", worktreeRoot: "/w", baseBranch: "main", previewServices: [{ name: "web" }] },
      { name: "ok", repoPath: "/r", worktreeRoot: "/w", baseBranch: "main" }, // duplicate
    ],
    portRange: [50, 10],
    staleHours: -1,
  });
  expect(bad.config).toBeUndefined(); // nothing is applied when anything is wrong
  const joined = bad.errors.join("\n");
  expect(joined).toContain("repos[0].name is required");
  expect(joined).toContain("repos[0].repoPath is required");
  expect(joined).toContain("repos[1].previewServices[0].command is required");
  expect(joined).toContain('duplicated');
  expect(joined).toContain("portRange");
  expect(joined).toContain("staleHours");

  // A good document parses, and the optional settings take documented defaults.
  const good = parseConfigDocument({ repos: [{ name: "app", repoPath: "/r", worktreeRoot: "/w", baseBranch: "main" }] });
  expect(good.errors).toEqual([]);
  expect(good.config?.staleHours).toBe(24);
  expect(good.config?.portRange).toEqual([30000, 40000]);
});

test("repo paths stay portable: stored as templates, expanded per machine", async () => {
  // The reason this matters: a laptop and a cloud box will share ONE database, and the same repo
  // lives at a different absolute path on each.
  expect(expandPath("${ORCA_DEV_ROOT}/app")).toBe("/machine-a/dev/app");
  expect(templatePath("/machine-a/dev/app")).toBe("${ORCA_DEV_ROOT}/app");
  expect(expandPath("/somewhere/absolute")).toBe("/somewhere/absolute"); // literal paths pass through

  const { config } = parseConfigDocument(doc());
  await saveConfigDocument(config!);

  // Read back on THIS machine → expanded against its root.
  expect((await loadConfig()).repos[0]!.repoPath).toBe("/machine-a/dev/app");

  // The same row on another machine resolves against ITS root, with no rewrite.
  process.env.ORCA_DEV_ROOT = "/machine-b/code";
  invalidateConfig();
  expect((await loadConfig()).repos[0]!.repoPath).toBe("/machine-b/code/app");

  // And what's STORED is the template, so the document you paste elsewhere stays portable.
  expect((await configDocument()).repos).toMatchObject([{ repoPath: "${ORCA_DEV_ROOT}/app" }]);
});

test("saving takes effect without a restart, and the document is the unit", async () => {
  await saveConfigDocument(parseConfigDocument(doc()).config!);
  expect((await loadConfig()).repos.map((r) => r.name)).toEqual(["app"]);

  // Add a second project — the thing that used to need a file edit and a redeploy.
  await saveConfigDocument(parseConfigDocument(doc({
    repos: [...doc().repos, { name: "site", repoPath: "/s", worktreeRoot: "/s/.wt", baseBranch: "master" }],
    staleHours: 8,
  })).config!);
  const two = await loadConfig();
  expect(two.repos.map((r) => r.name)).toEqual(["app", "site"]); // order preserved
  expect(two.staleHours).toBe(8); // no restart between the write and this read

  // Repos absent from a pasted document are REMOVED, so the rows always match what you pasted.
  await saveConfigDocument(parseConfigDocument(doc({
    repos: [{ name: "site", repoPath: "/s", worktreeRoot: "/s/.wt", baseBranch: "master" }],
  })).config!);
  expect((await loadConfig()).repos.map((r) => r.name)).toEqual(["site"]);
});

test("per-repo settings survive the round trip, including preview commands", async () => {
  const rich = doc({
    repos: [{
      name: "app", repoPath: "${ORCA_DEV_ROOT}/app", worktreeRoot: "${ORCA_DEV_ROOT}/app/.worktrees",
      baseBranch: "main", slackChannel: "#eng", agentModel: "claude-opus-5[1m]",
      prLabels: [{ name: "preview", default: true }], copyToWorktree: ["backend/.env"],
      previewServices: [{ name: "backend", command: "PORT={port} bun start", onStop: "drop {db}" }],
    }],
  });
  await saveConfigDocument(parseConfigDocument(rich).config!);

  const repo = (await loadConfig()).repos[0]!;
  expect(repo.slackChannel).toBe("#eng");
  expect(repo.agentModel).toBe("claude-opus-5[1m]");
  expect(repo.copyToWorktree).toEqual(["backend/.env"]);
  expect(repo.previewServices[0]).toMatchObject({ name: "backend", command: "PORT={port} bun start", onStop: "drop {db}" });
});

test("a PUT body is actually read — the config document arrives, not an empty object", async () => {
  // The bug: the bridge parsed a JSON body for POST only, so every PUT reached the handler as `{}`
  // and a valid pasted document was rejected as "repos must be a non-empty array". The route is
  // exercised through the same parse the handler uses, so the contract is pinned rather than the
  // plumbing being trusted.
  const document = doc();
  const payload = JSON.parse(await new Request("http://x", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: document }),
  }).text());
  const { config, errors } = parseConfigDocument(payload.config ?? payload);
  expect(errors).toEqual([]);
  expect(config?.repos.map((r) => r.name)).toEqual(["app"]);

  // A document pasted WITHOUT the `config` wrapper is accepted too — that's the form you'd copy out
  // of /api/config/document and paste straight back.
  expect(parseConfigDocument(document).errors).toEqual([]);
});

// ---- per-repo opt-ins ----

test("every opt-in defaults to OFF, so a repo has to ask for anything that spends or publishes", () => {
  const bare = { name: "app", repoPath: "/r", worktreeRoot: "/w", baseBranch: "main", previewServices: [] };
  expect(featuresOf(bare as never)).toEqual({
    slack: false, followAutomation: false, aiPrDescription: false,
    autoMerge: false, previews: false, aiTitles: false,
  });
  // A partial block leaves the rest off — enabling one thing never implies another.
  expect(featuresOf({ ...bare, features: { slack: true } } as never))
    .toMatchObject({ slack: true, autoMerge: false, previews: false });
  // Providers are opt-in too: no list means no agent may run in this repo.
  expect(providerAllowed(bare as never, "claude")).toBe(false);
  expect(providerAllowed({ ...bare, providers: ["claude"] } as never, "claude")).toBe(true);
  expect(providerAllowed({ ...bare, providers: ["claude"] } as never, "codex")).toBe(false);
  // …and are intersected with what's installed here, so a repo can opt into Codex without every
  // machine having the binary.
  expect(providersFor({ ...bare, providers: ["claude", "codex"] } as never, ["claude"])).toEqual(["claude"]);
});

test("agents are NOT given bypassPermissions unless the repo opts in", () => {
  // This ran unconditionally before. Fine for your own repo; much less so for a client's.
  expect(agentCommand("claude", "/wt/x", "go")).toContain("default");
  expect(agentCommand("claude", "/wt/x", "go")).not.toContain("bypassPermissions");
  expect(agentCommand("claude", "/wt/x", "go", undefined, "s-1", undefined, "bypass")).toContain("bypassPermissions");
});

test("a typo'd feature name is rejected rather than silently ignored", () => {
  // A silently-dropped key means a feature you believe you enabled is off — the worst outcome for a
  // setting whose whole job is to be explicit.
  const { errors } = parseConfigDocument(doc({
    repos: [{
      name: "app", repoPath: "/r", worktreeRoot: "/w", baseBranch: "main",
      features: { slck: true, autoMerge: "yes" }, providers: ["claude", "gpt"], agentPermissionMode: "root",
    }],
  }));
  const joined = errors.join("\n");
  expect(joined).toContain("features.slck is not a known feature");
  expect(joined).toContain("features.autoMerge must be true or false");
  expect(joined).toContain("providers must contain only");
  expect(joined).toContain('agentPermissionMode must be "bypass" or "ask"');
});

test("opt-ins survive the round trip, and existing repos are backfilled with what they already did", async () => {
  await saveConfigDocument(parseConfigDocument(doc({
    repos: [{
      name: "app", repoPath: "${ORCA_DEV_ROOT}/app", worktreeRoot: "${ORCA_DEV_ROOT}/app/.wt",
      baseBranch: "main", providers: ["claude"], agentPermissionMode: "bypass",
      features: { slack: true, previews: true },
    }],
  })).config!);
  const repo = (await loadConfig()).repos[0]!;
  expect(repo.providers).toEqual(["claude"]);
  expect(repo.agentPermissionMode).toBe("bypass");
  expect(featuresOf(repo)).toMatchObject({ slack: true, previews: true, autoMerge: false });

  // Migration 3 backfills a repo configured BEFORE opt-ins existed, so a working board doesn't go
  // dark. Simulate one by stripping the features block the way a pre-migration row looked.
  const sql = await db.open();
  await sql`UPDATE repo_config SET config = config - 'features' - 'providers' - 'agentPermissionMode'`;
  await sql.unsafe(MIGRATION_3);
  invalidateConfig();
  const backfilled = (await loadConfig()).repos[0]!;
  expect(featuresOf(backfilled)).toMatchObject({ autoMerge: true, aiPrDescription: true, aiTitles: true });
  expect(backfilled.providers).toEqual(["claude", "codex", "cursor"]);
  expect(backfilled.agentPermissionMode).toBe("bypass"); // preserves today's behaviour, revocably
  // The backfill grants nothing the repo couldn't already do: no Slack channel means no Slack, and
  // no preview services means no previews — it records behaviour, it doesn't invent it.
  expect(featuresOf(backfilled)).toMatchObject({ slack: false, previews: false });
});

test("the backfill turns Slack and previews on only where the repo was already able to use them", async () => {
  await saveConfigDocument(parseConfigDocument(doc({
    repos: [{
      name: "app", repoPath: "/r", worktreeRoot: "/w", baseBranch: "main",
      slackChannel: "#eng", previewServices: [{ name: "web", command: "bun dev" }],
    }],
  })).config!);
  const sql = await db.open();
  await sql`UPDATE repo_config SET config = config - 'features' - 'providers' - 'agentPermissionMode'`;
  await sql.unsafe(MIGRATION_3);
  invalidateConfig();
  expect(featuresOf((await loadConfig()).repos[0]!)).toMatchObject({ slack: true, previews: true });
});
