// `orca preview --push-to-template`: make one preview the starting point for every later preview of
// its repo. Two halves, both dry-run unless confirmed:
//   1. Database — the repo's PREVIEW_TEMPLATE_DB (read from the preview's env file, as preview-db.sh
//      does) is replaced by a WHOLE copy of the preview's database: pg_dump of the preview (a read;
//      the running preview is never altered or disconnected) restored into a temporary database,
//      then two renames in one transaction (template → timestamped backup, temp → template). It
//      refuses while anything is connected to the template; Postgres refuses the rename too.
//   2. Env — integration-related variables the preview's env file has and the source env file (the
//      one `copyToWorktree` copies into new worktrees) lacks or holds differently are written back,
//      after a diff. The old file is kept under the state dir (never beside it: an untracked backup
//      in the app repo is a secret one `git add` from a commit). Values are never printed in full.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { previewDbName } from "./preview";

// ponytail: name heuristic for "integration-related"; differing keys it misses are listed by name as
// skipped, so a miss is visible. Make it per-repo config if a repo's integrations don't match it.
const INTEGRATION = /INTEGRATION|LINEAR|GITHUB|GITLAB|JIRA|ATLASSIAN|CONFLUENCE|SLACK|NOTION|ASANA|OAUTH|_BASE_URL$/i;
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

type EnvLine = { value: string; line: string };
/** KEY=value lines (optionally `export`ed, quotes stripped for comparison); the raw line is kept so a
 *  copied variable is written exactly as the preview has it. Last assignment wins, as dotenv/bash. */
export function parseEnv(text: string): Map<string, EnvLine> {
  const out = new Map<string, EnvLine>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const raw = m[2]!.trim();
    out.set(m[1]!, { value: raw.match(/^(['"])(.*)\1$/)?.[2] ?? raw, line: line.replace(/^\s*export\s+/, "") });
  }
  return out;
}

/** Never a whole value: two leading characters and the length. */
export const mask = (v: string): string => (v.length <= 4 ? "*".repeat(v.length) : `${v.slice(0, 2)}…(${v.length} chars)`);

export type EnvChange = { key: string; line: string; from?: string; to: string };
/** What the preview's env would push back: integration keys added or changed (`changes`), and the
 *  other differing keys by name only (`skipped`). Keys only the source has are left alone. */
export function envDiff(preview: string, source: string): { changes: EnvChange[]; skipped: string[] } {
  const p = parseEnv(preview), s = parseEnv(source);
  const changes: EnvChange[] = [], skipped: string[] = [];
  for (const [key, { value, line }] of p) {
    if (s.get(key)?.value === value) continue;
    if (INTEGRATION.test(key)) changes.push({ key, line, from: s.get(key)?.value, to: value });
    else skipped.push(key);
  }
  return { changes, skipped };
}

/** The source text with each change applied: an existing assignment is replaced in place, a new key
 *  appended under one comment line. Every other line is untouched. */
export function applyEnv(source: string, changes: EnvChange[], note: string): string {
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const done = new Set<string>();
  const lines = source.split("\n").map((l) => {
    const key = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    const c = key ? byKey.get(key) : undefined;
    if (!c) return l;
    done.add(c.key);
    return c.line;
  });
  const added = changes.filter((c) => !done.has(c.key)).map((c) => c.line);
  if (!added.length) return lines.join("\n");
  const body = lines.join("\n").replace(/\n*$/, "");
  return `${body}${body ? "\n\n" : ""}# ${note}\n${added.join("\n")}\n`;
}

const describe = (c: EnvChange) => (c.from === undefined ? `  + ${c.key}=${mask(c.to)}` : `  ~ ${c.key}: ${mask(c.from)} -> ${mask(c.to)}`);

async function run(cmd: string[], env: Record<string, string>, stdin?: ReadableStream | "ignore"): Promise<string> {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (exit ${code}): ${err.trim().slice(-1500)}`);
  return out.trim();
}

/** A pg_dump at least as new as the server (pg_dump refuses an older one): $PG_DUMP, PATH's, then the
 *  usual Homebrew/Debian per-version installs, since PATH's is often an older major. */
async function pgDumpFor(major: number): Promise<string> {
  const candidates = [process.env.PG_DUMP, "pg_dump", `/opt/homebrew/opt/postgresql@${major}/bin/pg_dump`, "/opt/homebrew/opt/libpq/bin/pg_dump", `/usr/lib/postgresql/${major}/bin/pg_dump`];
  for (const c of candidates.filter((c): c is string => !!c)) {
    const v = await run([c, "--version"], {}).catch(() => "");
    if (Number(v.match(/(\d+)/)?.[1]) >= major) return c;
  }
  throw new Error(`no pg_dump ${major} or newer found (the server is Postgres ${major}); set PG_DUMP to one`);
}

export type PushOpts = {
  worktree: string; // the preview's worktree (its key)
  repoPath: string; // the main checkout new worktrees copy their env file from
  envFile: string; // repo-relative, e.g. backend/.env
  confirm: boolean;
  backupDir: string; // where the source env file's previous version is kept
  now?: Date;
};

export async function pushToTemplate(o: PushOpts): Promise<string> {
  const previewEnvPath = join(o.worktree, o.envFile), sourceEnvPath = join(o.repoPath, o.envFile);
  for (const f of [previewEnvPath, sourceEnvPath]) if (!existsSync(f)) throw new Error(`${f} not found`);
  const previewText = readFileSync(previewEnvPath, "utf8"), sourceText = readFileSync(sourceEnvPath, "utf8");
  const vars = parseEnv(previewText);
  const get = (k: string) => vars.get(k)?.value || undefined;

  const db = previewDbName(o.worktree);
  const template = get("PREVIEW_TEMPLATE_DB");
  if (!template) throw new Error(`PREVIEW_TEMPLATE_DB is not set in ${previewEnvPath}, so there is no template database to replace`);
  if (!IDENT.test(template) || template.startsWith("orca_") || template === db) throw new Error(`refusing to replace '${template}': not a plain template database name`);

  // The connection comes from the env file, like preview-db.sh; on the environment, never on argv.
  const pg: Record<string, string> = { PGHOST: get("DB_HOST") ?? "localhost", PGPORT: get("DB_PORT") ?? "5432", PGUSER: get("DB_MASTER_USER") ?? "postgres", PGDATABASE: "postgres" };
  if (get("PGPASSWORD")) pg.PGPASSWORD = get("PGPASSWORD")!;
  const sql = (q: string) => run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-tAc", q], pg);
  const exists = async (name: string) => (await sql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`)) === "1";
  if (!(await exists(db))) throw new Error(`the preview database ${db} does not exist; start the preview first`);
  if (!(await exists(template))) throw new Error(`the template database ${template} does not exist`);

  const pgDump = await pgDumpFor(Math.floor(Number(await sql("SHOW server_version_num")) / 10000));

  const ts = (o.now ?? new Date()).toISOString().replace(/\D/g, "").slice(0, 14);
  const base = template.slice(0, 63 - "_pushed_".length - ts.length);
  const backup = `${base}_bak_${ts}`, temp = `${base}_push_${ts}`, displaced = `${base}_pushed_${ts}`;
  const { changes, skipped } = envDiff(previewText, sourceText);
  const plan = [
    `Database: replace ${template} with a whole copy of the preview database ${db}; the current ${template} is kept as ${backup}.`,
    `Env: ${sourceEnvPath}`,
    ...(changes.length ? changes.map(describe) : ["  (no integration variables differ)"]),
    ...(skipped.length ? [`  not copied (not integration-related): ${skipped.join(", ")}`] : []),
  ];
  if (!o.confirm) return [...plan, "", "Nothing changed. Re-run with --confirm to apply."].join("\n");

  const [n, who] = (await sql(`SELECT count(*), coalesce(string_agg(DISTINCT coalesce(nullif(application_name, ''), usename), ', '), '') FROM pg_stat_activity WHERE datname = '${template}'`)).split("|");
  if (n !== "0") throw new Error(`refusing: ${n} connection(s) open on ${template} (${who}). Stop whatever uses it (e.g. the main checkout's backend) and run again.`);

  const owner = await sql(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${template}'`);
  await sql(`CREATE DATABASE "${temp}" OWNER "${owner}" TEMPLATE template0`);
  try {
    const dump = Bun.spawn([pgDump, "-d", db], { env: { ...process.env, ...pg }, stdout: "pipe", stderr: "pipe" });
    const restore = run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", temp], pg, dump.stdout);
    const [dumpErr, dumpCode] = await Promise.all([new Response(dump.stderr).text(), dump.exited]);
    await restore;
    if (dumpCode !== 0) throw new Error(`pg_dump failed (exit ${dumpCode}): ${dumpErr.trim().slice(-1500)}`);
    // One statement string = one transaction: both renames happen or neither. Postgres itself refuses
    // to rename a database anyone is connected to, which closes the race after the check above.
    await sql(`ALTER DATABASE "${template}" RENAME TO "${backup}"; ALTER DATABASE "${temp}" RENAME TO "${template}"`);
  } catch (e) {
    await sql(`DROP DATABASE IF EXISTS "${temp}"`).catch(() => {});
    throw e;
  }

  let envNote = "Env: unchanged.";
  const kept = join(o.backupDir, `${basename(o.repoPath)}-${o.envFile.replace(/\W+/g, "_")}-${ts}`);
  if (changes.length) {
    mkdirSync(o.backupDir, { recursive: true });
    copyFileSync(sourceEnvPath, kept);
    writeFileSync(`${sourceEnvPath}.orca-tmp`, applyEnv(sourceText, changes, `from preview ${db} (orca preview --push-to-template, ${ts})`));
    renameSync(`${sourceEnvPath}.orca-tmp`, sourceEnvPath);
    envNote = `Env: wrote ${changes.length} variable(s); the previous file is kept at ${kept}.`;
  }
  const psql = `psql -h ${pg.PGHOST} -p ${pg.PGPORT} -U ${pg.PGUSER} -d postgres`;
  return [
    ...plan, "",
    `Done. ${template} is now a copy of ${db}; every new preview starts from it.`,
    envNote, "",
    "To restore the previous template (nothing may be connected to either database):",
    `  ${psql} -c 'ALTER DATABASE "${template}" RENAME TO "${displaced}"; ALTER DATABASE "${backup}" RENAME TO "${template}"'`,
    ...(changes.length ? ["To restore the env file:", `  cp '${kept}' '${sourceEnvPath}'`] : []),
    `Once you are happy, drop the backup: ${psql} -c 'DROP DATABASE "${backup}"'`,
  ].join("\n");
}
