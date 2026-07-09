// Claude subscription rate-limit usage (5-hour rolling window + weekly), fetched from the same
// OAuth endpoint the CLI's `/usage` hits — reusing your existing Claude login, no API key. Read-only.
import { homedir } from "os";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export type UsageWindow = { utilization: number; resetsAt: string | null };
// Pay-as-you-go "extra usage" spend (only present when you've enabled it on your plan). Money is
// carried in MINOR units (pence/cents) + exponent so the client formats it exactly, no float drift.
export type ExtraUsage = { usedMinor: number; limitMinor: number; currency: string; exponent: number; utilization: number };
export type Usage = { fiveHour: UsageWindow; sevenDay: UsageWindow; extra: ExtraUsage | null };

/** Shape the raw endpoint payload into the windows + extra-usage spend we surface. Pure. */
export function shapeUsage(raw: any): Usage {
  const win = (w: any): UsageWindow => ({
    utilization: Math.max(0, Math.min(100, Math.round(Number(w?.utilization) || 0))),
    resetsAt: typeof w?.resets_at === "string" ? w.resets_at : null,
  });
  // extra_usage: { is_enabled, monthly_limit, used_credits (both minor units), currency,
  // decimal_places, utilization, disabled_reason }. Only surface it when actually enabled.
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

// Reads the Claude Code OAuth access token from wherever the CLI stored it: ~/.claude/.credentials.json
// (Linux/others), else the macOS Keychain. Returns null if not logged in.
async function readToken(): Promise<string | null> {
  const parse = (raw: string): string | null => {
    try { return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null; } catch { return null; }
  };
  const file = Bun.file(`${homedir()}/.claude/.credentials.json`);
  if (await file.exists()) return parse(await file.text());
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) return parse(out.trim());
  }
  return null;
}

// Cache the last successful read. The OAuth usage endpoint is flaky (transient 5xx / rate-limits /
// timeouts) and a single failure used to null out the response, making the whole header widget
// vanish and reappear. Serving the last-good value on any failure keeps it steady; we only ever
// return null before the first success (genuinely logged out / never fetched).
let lastGood: Usage | null = null;

/** Current subscription usage. Returns the last successful value on a transient failure so the
 *  widget doesn't flicker; null only until the first success (not logged in / never fetched). */
export async function usage(): Promise<Usage | null> {
  try {
    const token = await readToken();
    if (!token) { console.error("[usage] no Claude token found (credentials file / Keychain)"); return lastGood; }
    const r = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.error(`[usage] upstream HTTP ${r.status}`); return lastGood; }
    lastGood = shapeUsage(await r.json());
    return lastGood;
  } catch (e) {
    console.error("[usage] fetch failed:", e instanceof Error ? e.message : e);
    return lastGood;
  }
}
