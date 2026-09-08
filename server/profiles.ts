// Claude account profiles: one `CLAUDE_CONFIG_DIR` per login. The CLI scopes EVERYTHING to that
// directory — credentials, settings, and the session transcripts a `--resume` reads — so a profile
// is nothing more than a directory Orca sets in a run's environment. There is no API key anywhere:
// each profile is a `claude login` done once inside its directory.
//
// Switching accounts mid-conversation is LOSSLESS when the session file travels with it: the CLI
// stores a session as `<configDir>/projects/<cwd-slug>/<sessionId>.jsonl` (plus a same-named
// directory for subagent transcripts), and the slug is derived from the worktree path alone, so a
// copy into the other profile's tree resumes there with the full native context. See CLAUDE.md
// "Handover ladder" for where this sits against the portable-transcript fallback.
import { createHash } from "crypto";
import { cp, mkdir, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { ClaudeUsage } from "./usage";

export type ClaudeProfile = { name: string; configDir: string };

/** The configured profiles, or the CLI's default login when none are configured. A single
 *  profile is "no switching": launches carry no profile name and nothing is copied. */
export function profilesOf(configured: ClaudeProfile[] | undefined): ClaudeProfile[] {
  return configured?.length ? configured : [{ name: "default", configDir: join(homedir(), ".claude") }];
}
export const isDefaultDir = (configDir: string): boolean => configDir === join(homedir(), ".claude");

/** The macOS Keychain service the CLI stores a profile's OAuth token under. Read out of the CLI
 *  itself (2.1.263): the default directory uses the bare name; any `CLAUDE_CONFIG_DIR` appends a
 *  dash and the first 8 hex chars of the SHA-256 of the directory path (NFC-normalised). The path
 *  must be byte-identical to what the CLI saw in its environment, so Orca always passes the same
 *  expanded absolute path it hashes here. */
export function keychainService(configDir: string): string {
  if (isDefaultDir(configDir)) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

/** The profile's OAuth access token: `.credentials.json` in its directory (Linux, and any platform
 *  where the CLI fell back to the file), else the Keychain. Null when the profile isn't logged in. */
export async function readToken(configDir: string): Promise<string | null> {
  const parse = (raw: string): string | null => {
    try { return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null; } catch { return null; }
  };
  const file = Bun.file(join(configDir, ".credentials.json"));
  if (await file.exists()) return parse(await file.text());
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", keychainService(configDir), "-w"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) return parse(out.trim());
  }
  return null;
}

/** The CLI's per-project directory name for a working directory (same rule as backfill.ts). */
export const projectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** Carry a native session from one profile to another so `--resume` finds it there. Copies the
 *  transcript file and its sidecar directory when present. False when the source has no such
 *  session — the caller then falls back to the portable transcript rather than resuming into
 *  nothing (which the CLI reports as "No conversation found"). */
export async function copySession(from: string, to: string, cwd: string, sessionId: string): Promise<boolean> {
  const src = join(from, "projects", projectSlug(cwd));
  const dst = join(to, "projects", projectSlug(cwd));
  const file = join(src, `${sessionId}.jsonl`);
  if (!(await exists(file))) return false;
  await mkdir(dst, { recursive: true });
  await cp(file, join(dst, `${sessionId}.jsonl`));
  const side = join(src, sessionId);
  if (await exists(side)) await cp(side, join(dst, sessionId), { recursive: true });
  return true;
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/** Which profile the next run should use. Pure. The session's current owner keeps it while it has
 *  headroom (a resume there is free; a switch costs a copy), else the profile with the most
 *  five-hour headroom, ties broken by the weekly window, then configured order. A profile whose
 *  usage is unknown (not logged in, endpoint down) is never chosen over a known one. */
export function pickProfile(
  profiles: { name: string; usage: ClaudeUsage | null }[],
  owner: string | undefined,
  switchPct: number,
): string {
  const current = profiles.find((p) => p.name === owner);
  if (current && (current.usage === null || current.usage.fiveHour.utilization < switchPct)) return current.name;
  const known = profiles.filter((p) => p.usage);
  if (!known.length) return current?.name ?? profiles[0]!.name;
  known.sort((a, b) =>
    a.usage!.fiveHour.utilization - b.usage!.fiveHour.utilization
    || a.usage!.sevenDay.utilization - b.usage!.sevenDay.utilization);
  return known[0]!.name;
}
