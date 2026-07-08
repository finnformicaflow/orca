// Claude subscription rate-limit usage (5-hour rolling window + weekly), fetched from the same
// OAuth endpoint the CLI's `/usage` hits — reusing your existing Claude login, no API key. Read-only.
import { homedir } from "os";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export type UsageWindow = { utilization: number; resetsAt: string | null };
export type Usage = { fiveHour: UsageWindow; sevenDay: UsageWindow };

/** Shape the raw endpoint payload into the two windows we surface (percent, rounded). Pure. */
export function shapeUsage(raw: any): Usage {
  const win = (w: any): UsageWindow => ({
    utilization: Math.max(0, Math.min(100, Math.round(Number(w?.utilization) || 0))),
    resetsAt: typeof w?.resets_at === "string" ? w.resets_at : null,
  });
  return { fiveHour: win(raw?.five_hour), sevenDay: win(raw?.seven_day) };
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

/** Current subscription usage, or null when not logged in / the call fails (widget just hides). */
export async function usage(): Promise<Usage | null> {
  const token = await readToken();
  if (!token) return null;
  try {
    const r = await fetch(USAGE_URL, { headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } });
    if (!r.ok) return null;
    return shapeUsage(await r.json());
  } catch {
    return null;
  }
}
