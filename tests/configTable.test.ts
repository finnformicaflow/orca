// Configuration lives in the DATABASE, not in orca.config.ts. The point is that adding a project is
// a paste rather than an edit-and-redeploy — and that a second Orca instance sharing the database
// inherits it. These cases pin the three properties that makes possible: a bad document is rejected
// rather than half-applied, paths stay portable across machines, and a save takes effect without a
// restart.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../server/db";
import {
  configDocument, expandPath, invalidateConfig, loadConfig, parseConfigDocument, saveConfigDocument, templatePath,
} from "../server/config";
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
