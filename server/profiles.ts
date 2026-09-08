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
import { cp, mkdir, stat } from "fs/promises";
import { join } from "path";
import type { AgentTurn } from "../shared/agent";
import type { OrcaConfig } from "./config";
import * as db from "./db";
import { DEFAULT_CLAUDE_DIR, usage, type ClaudeUsage } from "./usage";
export { keychainService, readClaudeToken as readToken } from "./usage";

export type ClaudeProfile = { name: string; configDir: string };

/** The configured profiles, or the CLI's default login when none are configured. A single
 *  profile is "no switching": launches carry no profile name and nothing is copied. */
export function profilesOf(configured: ClaudeProfile[] | undefined): ClaudeProfile[] {
  return configured?.length ? configured : [{ name: "default", configDir: DEFAULT_CLAUDE_DIR }];
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

export type RunRoute = { profile?: string; configDir?: string; resume?: string; history?: AgentTurn[]; handoffFrom?: "claude" };

/** Decide the login for a Claude run and, when a resumed session changes hands, carry it over.
 *  Returns the launch options to spread: with one login nothing is chosen (env untouched unless that
 *  one login lives in a custom dir); otherwise the picked profile's dir, and `resume` either kept
 *  (same owner, or copied across) or DROPPED with the recorded turns as `history` — the bounded
 *  portable handoff — when the owner's session file couldn't be found to copy. The chosen name is
 *  recorded on the workstream as `sessionProfile`, the owner of the (possibly new) native session. */
export async function routeRun(cfg: OrcaConfig, repo: string, branch: string | undefined, cwd: string, resume: string | undefined): Promise<RunRoute> {
  const profiles = profilesOf(cfg.claudeProfiles);
  if (profiles.length === 1) {
    const only = profiles[0]!;
    return { resume, ...(only.configDir === DEFAULT_CLAUDE_DIR ? {} : { configDir: only.configDir }) };
  }
  const recorded = branch ? ((await db.enrichment(repo))[branch]?.sessionProfile as string | undefined) : undefined;
  // A session that predates profiles was made by the first login.
  const owner = recorded ?? (resume ? profiles[0]!.name : undefined);
  const readings = (await usage(profiles))?.profiles ?? profiles.map((p) => ({ name: p.name, usage: null }));
  const name = pickProfile(readings, owner, cfg.profileSwitchPct ?? 90);
  const chosen = profiles.find((p) => p.name === name)!;
  const route: RunRoute = { profile: name, configDir: chosen.configDir, resume };
  if (resume && owner && owner !== name) {
    const from = profiles.find((p) => p.name === owner)?.configDir;
    const carried = from ? await copySession(from, chosen.configDir, cwd, resume).catch(() => false) : false;
    if (!carried && branch) {
      route.resume = undefined;
      route.history = await db.turns(repo, branch);
      route.handoffFrom = "claude";
    }
  }
  if (branch) await db.patchEnrichment(repo, branch, { sessionProfile: name });
  return route;
}
