// Subscription usage for Claude and Codex, fetched from each installed CLI's existing login.
// Both paths are read-only: Claude uses its OAuth usage endpoint; Codex uses its local app server.
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";

// Overridable so a test can point at canned readings (`{token}` in the override stands in for the
// login's token, so each profile gets its own) — the real endpoint otherwise.
const claudeUsageUrl = (token: string) => (process.env.ORCA_CLAUDE_USAGE_URL || "https://api.anthropic.com/api/oauth/usage").replace("{token}", token);

export type UsageWindow = { utilization: number; resetsAt: string | null };
// Pay-as-you-go "extra usage" spend (only present when you've enabled it on your plan). Money is
// carried in MINOR units (pence/cents) + exponent so the client formats it exactly, no float drift.
export type ExtraUsage = { usedMinor: number; limitMinor: number; currency: string; exponent: number; utilization: number };
/** `fable` is the per-model weekly window (only hydra's `limits[]` parse exposes it); null/absent
 *  when the account has none or the reading came from the bare endpoint shape. */
export type ClaudeUsage = { fiveHour: UsageWindow; sevenDay: UsageWindow; extra: ExtraUsage | null; fable?: UsageWindow | null };
export type CodexUsageWindow = UsageWindow & { label: string; durationMinutes: number | null };
export type CodexUsage = { windows: CodexUsageWindow[] };
/** One Claude login as hydra reports it. `usage` is null with no reading yet (not signed in on this
 *  machine, or never fetched); `state` is hydra's verdict — "ok", "disabled", "exhausted", "locked",
 *  "token stale — refreshes on next launch", "no usage data yet", "not signed in on this machine". */
export type ProfileUsage = { name: string; usage: ClaudeUsage | null; state?: string; email?: string };
/** `claude` is the first login's usage (back-compat for the single-login meter); `profiles` is every
 *  login hydra knows, present only when hydra is installed. */
export type Usage = { claude: ClaudeUsage | null; codex: CodexUsage | null; profiles?: ProfileUsage[] };

/** Shape the raw Anthropic endpoint payload into the windows + extra-usage spend we surface. Pure. */
export function shapeUsage(raw: any): ClaudeUsage {
  const win = (w: any): UsageWindow => ({
    utilization: Math.max(0, Math.min(100, Math.round(Number(w?.utilization) || 0))),
    resetsAt: typeof w?.resets_at === "string" ? w.resets_at : null,
  });
  const eu = raw?.extra_usage;
  const extra: ExtraUsage | null = eu && eu.is_enabled && !eu.disabled_reason ? {
    usedMinor: Math.max(0, Math.round(Number(eu.used_credits) || 0)),
    limitMinor: Math.max(0, Math.round(Number(eu.monthly_limit) || 0)),
    currency: typeof eu.currency === "string" ? eu.currency : "USD",
    exponent: Number.isInteger(eu.decimal_places) ? eu.decimal_places : 2,
    utilization: Math.max(0, Math.min(100, Math.round(Number(eu.utilization) || 0))),
  } : null;
  return { fiveHour: win(raw?.five_hour), sevenDay: win(raw?.seven_day), extra };
}

function codexWindowLabel(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "wk";
  if (minutes === 1_440) return "day";
  if (minutes && minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return fallback;
}

/** Shape Codex app-server rate limits into percentage windows suitable for the mini chart. Pure. */
export function shapeCodexUsage(rateRaw: any): CodexUsage | null {
  const snapshot = rateRaw?.rateLimits;
  const windows = ([snapshot?.primary, snapshot?.secondary] as any[])
    .map((window, index): CodexUsageWindow | null => {
      if (!window || !Number.isFinite(Number(window.usedPercent))) return null;
      const durationMinutes = Number.isFinite(Number(window.windowDurationMins)) ? Number(window.windowDurationMins) : null;
      const resetSeconds = Number(window.resetsAt);
      return {
        label: codexWindowLabel(durationMinutes, index === 0 ? "limit" : "limit2"),
        durationMinutes,
        utilization: Math.max(0, Math.min(100, Math.round(Number(window.usedPercent)))),
        resetsAt: Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1000).toISOString() : null,
      };
    })
    .filter((window): window is CodexUsageWindow => window !== null);
  return windows.length ? { windows } : null;
}

/** Shape `hydra status --json` into per-profile usage. Pure. hydra's buckets carry `pct` (int or
 *  null) and `resets` (epoch SECONDS, or null); a null bucket means the account has no such window.
 *  A profile with no session reading has `usage: null` but keeps its `state`, so the meter can still
 *  say why (disabled / not signed in here / no data yet). */
export function shapeHydraStatus(raw: any): ProfileUsage[] {
  const win = (b: any): UsageWindow | null => b && typeof b === "object" ? {
    utilization: Math.max(0, Math.min(100, Math.round(Number(b.pct) || 0))),
    resetsAt: Number.isFinite(Number(b.resets)) && Number(b.resets) > 0 ? new Date(Number(b.resets) * 1000).toISOString() : null,
  } : null;
  const zero: UsageWindow = { utilization: 0, resetsAt: null };
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  return profiles
    .filter((p: any) => p && typeof p.name === "string")
    .map((p: any): ProfileUsage => {
      const session = win(p.session);
      const usage: ClaudeUsage | null = session
        ? { fiveHour: session, sevenDay: win(p.weekly) ?? zero, extra: null, fable: win(p.fable) }
        : null;
      return { name: p.name, usage, state: typeof p.state === "string" ? p.state : undefined, email: typeof p.email === "string" && p.email ? p.email : undefined };
    });
}

// The last good hydra reading, so a slow or failed call (hydra refreshes stale profiles on this
// call, bounded by its own curl timeout) keeps the meter on the previous numbers rather than blank.
let lastGoodHydra: ProfileUsage[] | null = null;

/** Every Claude login's usage via hydra (`hydra status --json`), or null when hydra isn't installed
 *  or the call fails — the caller then falls back to the single default login. Never throws. */
export async function hydraUsage(): Promise<ProfileUsage[] | null> {
  // Live PATH, not Bun's startup snapshot — the test PATH shim (a fake `hydra`) relies on it, the same
  // way run.ts passes env for the fake `gh`.
  const hydra = Bun.which("hydra", { PATH: process.env.PATH ?? "" });
  if (!hydra) return null;
  try {
    const proc = Bun.spawn([hydra, "status", "--json"], { env: process.env, stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) return lastGoodHydra;
    const shaped = shapeHydraStatus(JSON.parse(out));
    if (shaped.length) lastGoodHydra = shaped;
    return lastGoodHydra;
  } catch (error) {
    console.error("[usage] hydra status failed:", error instanceof Error ? error.message : error);
    return lastGoodHydra;
  }
}

export const DEFAULT_CLAUDE_DIR = join(homedir(), ".claude");

/** The macOS Keychain service the CLI stores a login's OAuth token under. Read out of the CLI
 *  itself (2.1.263): the default directory uses the bare name; any `CLAUDE_CONFIG_DIR` appends a
 *  dash and the first 8 hex chars of the SHA-256 of the directory path (NFC-normalised). The path
 *  must be byte-identical to what the CLI saw in its environment, so Orca always passes the same
 *  expanded absolute path it hashes here. */
export function keychainService(configDir: string): string {
  if (configDir === DEFAULT_CLAUDE_DIR) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

// Reads a login's OAuth access token from wherever the CLI stored it: `.credentials.json` in its
// config dir (Linux/others), else the macOS Keychain. Returns null if that dir isn't logged in.
export async function readClaudeToken(configDir = DEFAULT_CLAUDE_DIR): Promise<string | null> {
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

// Last good reading per login, so a transient endpoint failure keeps the meter (and the profile
// picker's view of headroom) on the previous value rather than blanking it.
const lastGoodClaude = new Map<string, ClaudeUsage>();
let lastGoodCodex: CodexUsage | null = null;

async function claudeUsage(configDir = DEFAULT_CLAUDE_DIR): Promise<ClaudeUsage | null> {
  try {
    const token = await readClaudeToken(configDir);
    if (!token) return lastGoodClaude.get(configDir) ?? null;
    // Bun.fetch, not the global: the test DOM shim swaps global fetch for one without file:// support.
    // No AbortSignal: under the test DOM shim the global AbortSignal isn't Bun's, and Bun rejects it.
    const response = await Promise.race([
      Bun.fetch(claudeUsageUrl(token), { headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("usage fetch timed out")), 8000).unref?.()),
    ]);
    if (!response.ok) return lastGoodClaude.get(configDir) ?? null;
    lastGoodClaude.set(configDir, shapeUsage(await response.json()));
  } catch (error) {
    console.error("[usage] Claude fetch failed:", error instanceof Error ? error.message : error);
  }
  return lastGoodClaude.get(configDir) ?? null;
}

/** Ask the installed Codex CLI for the same percentage limits shown by `/usage`. */
async function codexUsage(): Promise<CodexUsage | null> {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const child = Bun.spawn(["codex", "app-server", "--listen", "stdio://"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc = child;
    const requests = [
      { id: 1, method: "initialize", params: { clientInfo: { name: "orca", title: "Orca", version: "0.1.0" }, capabilities: { experimentalApi: true } } },
      { id: 2, method: "account/rateLimits/read", params: null },
    ];
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
    await child.stdin.flush();

    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let rateRaw: any = null;
    const timeout = setTimeout(() => proc?.kill(), 8000);
    try {
      while (!rateRaw) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const message = JSON.parse(line.trim());
            if (message.id === 2 && message.result) rateRaw = message.result;
          } catch { /* app-server diagnostics and partial lines are safe to skip */ }
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
    const shaped = shapeCodexUsage(rateRaw);
    if (shaped) lastGoodCodex = shaped;
  } catch (error) {
    console.error("[usage] Codex read failed:", error instanceof Error ? error.message : error);
  } finally {
    proc?.kill();
  }
  return lastGoodCodex;
}

/** Current usage for every locally authenticated provider. Claude comes from hydra when it is
 *  installed (every login, three windows each), else from the default login's endpoint reading;
 *  Codex from its app server. Null only when nothing at all is available. */
export async function usage(): Promise<Usage | null> {
  const [profiles, codex] = await Promise.all([hydraUsage(), codexUsage()]);
  const claude = profiles ? (profiles[0]?.usage ?? null) : await claudeUsage();
  if (!claude && !profiles?.some((p) => p.usage) && !codex) return null;
  return { claude, codex, ...(profiles ? { profiles } : {}) };
}
