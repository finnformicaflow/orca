// The merge queue (server/mergeQueue.ts): a PR marked merge-when-green is squash-merged by Orca once
// every check passed and it merges clean — never red, never one the repo's mergePolicy keeps for a
// person — with a notification either way, and a report the orchestrator hears (red wakes it). And
// the auto-PR a finished worker's branch gets (verbs.openWorkerPr). Real Postgres, real git, the
// fake `gh` from helpers.ts.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as db from "../server/db";
import * as git from "../server/git";
import * as mergeQueue from "../server/mergeQueue";
import * as orchestrator from "../server/orchestrator";
import * as verbs from "../server/verbs";
import { run } from "../server/run";
import { parseConfigDocument, type OrcaConfig, type RepoConfig } from "../server/config";
import { deniedPaths, isWorkerProblem, mergeVerdict, pathMatches, workerPrBody, type MergePolicy } from "../web/src/workstream";
import { installFakeGh, makeScratchRepo, recordGhArgs, restorePath, setPrListFixture, setViewFixture } from "./helpers";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb, repoPath: string, prevDb: string | undefined;
const reports: string[] = [];
let ghArgs: () => Promise<string>;

beforeAll(async () => { await installFakeGh(); });
afterAll(() => restorePath());
beforeEach(async () => {
  prevDb = process.env.ORCA_DATABASE_URL;
  pg = await freshSchema("mergequeue");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  repoPath = await makeScratchRepo();
  reports.length = 0;
  mergeQueue.onReport(async (text) => { reports.push(text); });
  ghArgs = await recordGhArgs();
  await setPrListFixture([]);
});
afterEach(async () => {
  mergeQueue.onReport(undefined);
  await db.close();
  await pg.drop();
  if (prevDb === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prevDb;
  await rm(repoPath, { recursive: true, force: true });
});

const repo = (mergePolicy?: MergePolicy): RepoConfig => ({ name: "r", repoPath, worktreeRoot: join(repoPath, ".wt"), baseBranch: "main", previewServices: [], mergePolicy });
const cfg = (r: RepoConfig): OrcaConfig => ({ repos: [r], portRange: [30000, 40000], staleHours: 24 });
/** The fake `gh pr view` answer for PR #7 on branch `feat`. */
const pr = (over: Partial<{ ci: string; mergeable: string; files: string[]; state: string; sha: string; isDraft: boolean }> = {}) => setViewFixture({
  number: 7, title: "Add cache", headRefName: "feat", url: "https://github.com/acme/app/pull/7", isDraft: over.isDraft ?? false,
  headRefOid: over.sha ?? "sha1", state: over.state ?? "OPEN", mergeable: over.mergeable ?? "MERGEABLE", reviewDecision: "",
  statusCheckRollup: over.ci ? [{ name: "check", conclusion: over.ci }] : [],
  files: (over.files ?? ["src/cache.ts"]).map((path) => ({ path })), changedFiles: (over.files ?? ["src/cache.ts"]).length,
});
const merges = async () => (await ghArgs()).split("\n").filter((l) => l.startsWith("pr merge"));
const mark = async () => (await db.enrichment("r")).feat?.mergeWhenGreen as { pr?: number; reportedSha?: string } | undefined;
const kinds = async () => (await db.notifications()).map((n) => n.kind);

test("M1: a marked PR merges only once it is green and clean, then is unmarked, notified and reported", async () => {
  const r = repo({ whenGreen: "any" });
  await db.patchEnrichment("r", "feat", { orchestrated: true, title: "Cache" });
  // No checks yet (a fresh push) is not green.
  await pr();
  expect(await orchestrator.tool(cfg(r), "merge", { repo: "r", pr: "7", "when-green": "" })).toContain("Queued r PR #7 to merge when green (no checks reported yet)");
  await pr({ ci: "IN_PROGRESS" });
  await mergeQueue.tick(cfg(r));
  await pr({ ci: "SUCCESS", mergeable: "UNKNOWN" }); // green, but GitHub hasn't computed mergeability
  await mergeQueue.tick(cfg(r));
  expect(await merges()).toEqual([]);
  expect((await mark())?.pr).toBe(7);

  await pr({ ci: "SUCCESS" });
  await mergeQueue.tick(cfg(r));
  expect(await merges()).toEqual(["pr merge 7 --squash"]);
  expect(await mark()).toBeUndefined();
  expect(await kinds()).toEqual(["merged"]);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.split("\n")[0]).toBe('[worker finished] r/feat "Cache" — merged');
  expect(isWorkerProblem(reports[0]!)).toBe(false); // a merge is batched like a clean finish, not a wake
});

test("M2: red CI is never merged — notified and reported once per push, and it merges once fixed", async () => {
  const r = repo({ whenGreen: "any" });
  await pr({ ci: "FAILURE" });
  const said = await orchestrator.tool(cfg(r), "merge", { repo: "r", pr: "7", "when-green": "" });
  expect(said).toContain("it is red now (CI failing: check)");
  await mergeQueue.tick(cfg(r)); // same head: not said twice
  expect(await merges()).toEqual([]);
  expect(await kinds()).toEqual(["pr_ci_failed"]);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toStartWith('[worker finished] r/feat "Add cache" — merge blocked: CI failing: check (PR #7)');
  expect(reports[0]).toContain("orca address --repo r --branch feat");
  expect(isWorkerProblem(reports[0]!)).toBe(true); // wakes the orchestrator like a worker's problem
  expect((await mark())?.reportedSha).toBe("sha1"); // still marked

  // A conflict on the next push is red too, and is reported for that push.
  await pr({ ci: "SUCCESS", mergeable: "CONFLICTING", sha: "sha2" });
  await mergeQueue.tick(cfg(r));
  expect(reports.at(-1)).toContain("merge blocked: merge conflicts with its base");
  expect(await merges()).toEqual([]);

  // Fixed and green: it merges, with nobody watching.
  await pr({ ci: "SUCCESS", sha: "sha3", isDraft: true });
  await mergeQueue.tick(cfg(r));
  expect((await ghArgs()).split("\n").filter((l) => /^pr (ready|merge)/.test(l))).toEqual(["pr ready 7", "pr merge 7 --squash"]);
});

test("M3: the repo's policy — denylisted paths are refused and unmarked; never / small are refused up front", async () => {
  const r = repo({ whenGreen: "any", denyPaths: ["deploy/", "server/cgroup.ts", "**/migrations/*.sql"] });
  await pr({ ci: "SUCCESS", files: ["src/a.ts", "deploy/autodeploy.sh"] });
  expect(await orchestrator.tool(cfg(r), "merge", { repo: "r", pr: "7", "when-green": "" })).toBe("Not queued: it touches deploy/autodeploy.sh, which this repo never merges on its own (mergePolicy.denyPaths).");
  expect(await merges()).toEqual([]);
  expect(await mark()).toBeUndefined();
  expect(await kinds()).toEqual(["merge_refused"]);

  // A path added by a later push is caught at merge time, not just when marked.
  await pr({ ci: "IN_PROGRESS" });
  await orchestrator.tool(cfg(r), "merge", { repo: "r", pr: "7", "when-green": "" });
  await pr({ ci: "SUCCESS", files: ["src/a.ts", "db/migrations/0019_x.sql"], sha: "sha2" });
  await mergeQueue.tick(cfg(r));
  expect(await merges()).toEqual([]);
  expect(await mark()).toBeUndefined();

  // Policy before any gh call: absent / never refuses outright, small wants --small.
  await expect(orchestrator.tool(cfg(repo()), "merge", { repo: "r", pr: "7", "when-green": "" })).rejects.toThrow('mergePolicy.whenGreen is "never"');
  const small = repo({ whenGreen: "small" });
  await expect(orchestrator.tool(cfg(small), "merge", { repo: "r", pr: "7", "when-green": "" })).rejects.toThrow("only merges PRs marked small");
  await pr({ ci: "SUCCESS" });
  expect(await orchestrator.tool(cfg(small), "merge", { repo: "r", pr: "7", "when-green": "", small: "" })).toBe("Merged r PR #7: it was already green and clean.");
  // It only ever queues.
  await expect(orchestrator.tool(cfg(small), "merge", { repo: "r", pr: "7" })).rejects.toThrow("add --when-green");
});

test("M4: a branch marked before its PR exists is merged once the PR is open and green", async () => {
  const r = repo({ whenGreen: "any" });
  expect(await orchestrator.tool(cfg(r), "merge", { repo: "r", branch: "feat", "when-green": "" })).toContain("it has no PR yet");
  await mergeQueue.tick(cfg(r));
  expect(await merges()).toEqual([]);
  await setPrListFixture([{ number: 7, title: "Add cache", headRefName: "feat", baseRefName: "main", url: "u", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], comments: [], author: { login: "me" }, reviews: [], labels: [] }]);
  await pr({ ci: "SUCCESS" });
  await mergeQueue.tick(cfg(r));
  expect(await merges()).toEqual(["pr merge 7 --squash"]);
});

test("M5: auto-PR opens a finished worker's branch as a ready PR, titled from the card, bodied from its outcome", async () => {
  const remote = await makeScratchRepo();
  await run(["git", "-C", repoPath, "remote", "add", "origin", remote]);
  await run(["git", "-C", repoPath, "fetch", "origin"]);
  const r = repo({ autoPr: true });
  const wt = join(r.worktreeRoot, "feat");
  await run(["git", "-C", repoPath, "worktree", "add", "-b", "feat", wt]);
  await db.patchEnrichment("r", "feat", { title: "Add cache" });
  // Nothing of its own yet: no PR.
  expect(await verbs.openWorkerPr(r, "feat", wt, { response: "nothing" })).toBeUndefined();
  await writeFile(join(wt, "cache.ts"), "export {};\n");
  await run(["git", "-C", wt, "add", "."]);
  await run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "Add the cache"]);
  const opened = await verbs.openWorkerPr(r, "feat", wt, { outcome: { outcome: "Added a response cache.", remaining: [], decisions: ["LRU"], verification: ["bun test"], commits: [] } });
  expect(opened?.number).toBe(123);
  const create = (await ghArgs()).slice((await ghArgs()).indexOf("pr create")); // the body spans lines
  expect(create).toStartWith("pr create --base main --head feat --title Add cache --body ## Outcome\nAdded a response cache.\n");
  expect(create).toContain("## Decisions\n- LRU\n");
  expect(create).toContain("## Commits\n- Add the cache\n");
  expect(create).not.toContain("--draft");
  expect((await git.listWorktrees(repoPath, r.worktreeRoot)).some((w) => w.branch === "feat")).toBe(true);
  // A branch that already has a PR is left alone.
  await setPrListFixture([{ number: 123, title: "Add cache", headRefName: "feat", baseRefName: "main", url: "u", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], comments: [], author: { login: "me" }, reviews: [], labels: [] }]);
  expect(await verbs.openWorkerPr(r, "feat", wt, { response: "again" })).toBeUndefined();
  await rm(remote, { recursive: true, force: true });
});

test("M6: the policy is pure, and lives in the repo's config document", () => {
  expect(pathMatches("deploy/orca.service", "deploy/")).toBe(true);
  expect(pathMatches("deploy/orca.service", "deploy")).toBe(true);
  expect(pathMatches("deployment.md", "deploy")).toBe(false);
  expect(pathMatches("server/cgroup.ts", "server/*.ts")).toBe(true);
  expect(pathMatches("server/x/cgroup.ts", "server/*.ts")).toBe(false);
  expect(pathMatches("a/b/migrations/1.sql", "**/migrations/*.sql")).toBe(true);
  expect(pathMatches("migrations/1.sql", "**/migrations/*.sql")).toBe(true);
  expect(deniedPaths(["a.ts", "server/db.ts"], ["server/db.ts"])).toEqual(["server/db.ts"]);
  const gate = { state: "OPEN", mergeable: "MERGEABLE", ciStatus: "passing", files: ["a.ts"], changedFiles: 1 };
  expect(mergeVerdict({ whenGreen: "any" }, {}, gate)).toEqual({ action: "merge" });
  expect(mergeVerdict({ whenGreen: "any" }, {}, { ...gate, state: "MERGED" }).action).toBe("gone");
  expect(mergeVerdict({ whenGreen: "any", denyPaths: ["x/"] }, {}, { ...gate, changedFiles: 400 }).action).toBe("refuse"); // can't see every file
  expect(workerPrBody({ response: "Did it.", commits: ["one"] })).toBe("## Summary\nDid it.\n\n## Commits\n- one\n\nOpened by Orca when the workstream's agent finished.");

  const doc = (mergePolicy: unknown) => ({ repos: [{ name: "app", repoPath: "/a", worktreeRoot: "/a/.wt", baseBranch: "main", mergePolicy }] });
  expect(parseConfigDocument(doc({ whenGreen: "always" })).errors).toEqual(["repos[0].mergePolicy.whenGreen must be one of never, small, any"]);
  expect(parseConfigDocument(doc({ denyPaths: "deploy/" })).errors).toEqual(["repos[0].mergePolicy.denyPaths must be an array of path globs"]);
  expect(parseConfigDocument(doc({ autoPR: true })).errors).toEqual(["repos[0].mergePolicy.autoPR is not a known setting (whenGreen, denyPaths, autoPr)"]);
  const ok = { whenGreen: "small", denyPaths: ["server/db.ts", "server/cgroup.ts", "deploy/"], autoPr: true };
  expect(parseConfigDocument(doc(ok)).config?.repos[0]?.mergePolicy).toEqual(ok as MergePolicy);
});
