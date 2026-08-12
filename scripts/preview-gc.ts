// Reap preview databases whose worktree is gone.
//
// Each preview gets its own database (`previewDbName`, derived from the worktree path) and drops it
// on teardown. But a preview whose bridge was killed — or whose worktree was removed while it wasn't
// running — leaves the database behind, and nothing ever collects it. On a laptop that's untidy; on a
// box with a disk quota it's the thing that eventually fills it. (There were ~9 orphans here, 4.4 GB.)
//
// Reports by default and only drops with `--drop`, because the failure mode of getting this wrong is
// deleting a preview someone is using.
//
//   bun run scripts/preview-gc.ts --repo branch-demo          # report
//   bun run scripts/preview-gc.ts --repo branch-demo --drop   # reap
//
// Credentials come from the repo's own gitignored env file — the same one preview-db.sh reads — so
// this needs no configuration of its own.
import { readFileSync } from "fs";
import { join } from "path";
import { loadConfig, repoOf } from "../server/config";
import { listWorktrees } from "../server/git";
import { orphanPreviewDbs } from "../server/preview";

const args = process.argv.slice(2);
const drop = args.includes("--drop");
const repoName = args[args.indexOf("--repo") + 1];

const cfg = await loadConfig();
const repo = repoOf(cfg, repoName);

/** Connection settings from the repo's env file (`copyToWorktree`'s .env entry, resolved against the
 *  main checkout). Preview databases live on the APP's Postgres, not Orca's. */
function appDatabaseUrl(): string | undefined {
  const rel = (repo.copyToWorktree ?? []).find((p) => p.endsWith(".env"));
  if (!rel) return undefined;
  let text: string;
  try { text = readFileSync(join(repo.repoPath, rel), "utf8"); } catch { return undefined; }
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, "");
  }
  const user = env.DB_MASTER_USER || "postgres";
  const pass = env.PGPASSWORD;
  const host = env.DB_HOST || "localhost";
  const port = env.DB_PORT || "5432";
  if (!pass) return undefined;
  return `postgres://${user}:${encodeURIComponent(pass)}@${host}:${port}/postgres`;
}

const url = appDatabaseUrl();
if (!url) {
  console.error(`orca: no database credentials found for ${repo.name} (expected a .env in copyToWorktree)`);
  process.exit(1);
}

const live = await listWorktrees(repo.repoPath, repo.worktreeRoot);

const sql = new Bun.SQL(url);
const rows = await sql`
  SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size, pg_database_size(datname) AS bytes
  FROM pg_database WHERE datname LIKE 'orca\\_%' ORDER BY datname`;

const all = rows as { datname: string; size: string; bytes: string }[];
const orphaned = new Set(orphanPreviewDbs(all.map((r) => r.datname), live.map((w) => w.worktreePath)));
const orphans = all.filter((r) => orphaned.has(r.datname));
const total = orphans.reduce((n, r) => n + Number(r.bytes), 0);

console.log(`orca: ${live.length} live worktree(s), ${rows.length} preview database(s), ${orphans.length} orphaned`);
for (const o of orphans) console.log(`  ${drop ? "dropping" : "orphan "} ${o.datname}  ${o.size}`);

if (!orphans.length) { await sql.end(); process.exit(0); }
if (!drop) {
  console.log(`orca: ${(total / 1e9).toFixed(2)} GB reclaimable — re-run with --drop to reap`);
  await sql.end();
  process.exit(0);
}

for (const o of orphans) {
  // Bar new connections and terminate live ones first: a preview that reconnects between the
  // terminate and the DROP would keep the database alive (the same race preview-db.sh guards).
  try {
    await sql.unsafe(`ALTER DATABASE "${o.datname}" ALLOW_CONNECTIONS false`);
  } catch { /* an INVALID database (datconnlimit -2) can only be dropped */ }
  await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${o.datname} AND pid <> pg_backend_pid()`;
  await sql.unsafe(`DROP DATABASE IF EXISTS "${o.datname}"`);
}
await sql.end();
console.log(`orca: reaped ${orphans.length} database(s), ${(total / 1e9).toFixed(2)} GB`);
