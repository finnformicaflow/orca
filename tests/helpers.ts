import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../server/run";

/** Create a throwaway git repo on `main` with one commit. Returns its path. */
export async function makeScratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-repo-"));
  await run(["git", "init", "-b", "main", dir]);
  await run(["git", "-C", dir, "config", "user.email", "test@orca.dev"]);
  await run(["git", "-C", dir, "config", "user.name", "Orca Test"]);
  await writeFile(join(dir, "README.md"), "# scratch\n");
  await run(["git", "-C", dir, "add", "."]);
  await run(["git", "-C", dir, "commit", "-m", "init"]);
  return dir;
}

// A `gh` stand-in: `pr create` prints a URL, `pr view` cats the fixture file,
// `pr merge` succeeds. Same code path as real gh, no network. When ORCA_GH_ARGS_LOG is set it
// records each invocation's args, so a test can assert *which* --json fields we ask gh for (the
// shim otherwise ignores the field list — cat'ing the whole fixture regardless).
const GH_SHIM = `#!/bin/sh
[ -n "$ORCA_GH_ARGS_LOG" ] && echo "$*" >> "$ORCA_GH_ARGS_LOG"
case "$1 $2" in
  "pr create") echo "https://github.com/acme/app/pull/\${ORCA_PR_NUMBER:-123}" ;;
  "pr view") cat "$ORCA_GH_FIXTURE" ;;
  "pr list") cat "$ORCA_PRLIST_FIXTURE" ;;
  "pr diff") printf 'diff --git a/x.ts b/x.ts\\n@@ -1 +1 @@\\n+added line\\n-removed line\\n' ;;
  "pr merge") exit 0 ;;
  "pr ready") exit 0 ;;
  *) echo "fake-gh: unhandled: $*" >&2; exit 1 ;;
esac
`;

let realPath: string | undefined;

/** Prepend a fake `gh` to PATH. Call restorePath() when done. */
export async function installFakeGh(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orca-shim-"));
  const gh = join(dir, "gh");
  await writeFile(gh, GH_SHIM);
  await chmod(gh, 0o755);
  realPath = process.env.PATH;
  process.env.PATH = `${dir}:${realPath}`;
}

export function restorePath(): void {
  if (realPath !== undefined) process.env.PATH = realPath;
}

/** Point the fake `gh pr view` at a canned status JSON. */
export async function setPrFixture(status: {
  state: string;
  mergeable: string;
  reviewDecision: string;
  statusCheckRollup: Array<{ conclusion?: string; state?: string }>;
}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orca-fx-"));
  const path = join(dir, "pr.json");
  await writeFile(path, JSON.stringify(status));
  process.env.ORCA_GH_FIXTURE = path;
}

/** Point the fake `gh pr view` at an arbitrary JSON object (for pr-detail tests). */
export async function setViewFixture(obj: unknown): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orca-fxv-"));
  const path = join(dir, "view.json");
  await writeFile(path, JSON.stringify(obj));
  process.env.ORCA_GH_FIXTURE = path;
}

/** Point the fake `gh pr list` at a canned array of PRs. */
export async function setPrListFixture(prs: unknown[]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orca-fxl-"));
  const path = join(dir, "prs.json");
  await writeFile(path, JSON.stringify(prs));
  process.env.ORCA_PRLIST_FIXTURE = path;
}

/** Start recording every fake-`gh` invocation's args; returns a reader for what's been logged. */
export async function recordGhArgs(): Promise<() => Promise<string>> {
  const dir = await mkdtemp(join(tmpdir(), "orca-args-"));
  const path = join(dir, "args.log");
  await writeFile(path, "");
  process.env.ORCA_GH_ARGS_LOG = path;
  return async () => readFile(path, "utf8");
}
