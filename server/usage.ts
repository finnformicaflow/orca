// Subscription usage for Claude and Codex, fetched from each installed CLI's existing login.
// Both paths are read-only: Claude uses its OAuth usage endpoint; Codex uses its local app server.
import { homedir } from "os";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export type UsageWindow = { utilization: number; resetsAt: string | null };
// Pay-as-you-go "extra usage" spend (only present when you've enabled it on your plan). Money is
// carried in MINOR units (pence/cents) + exponent so the client formats it exactly, no float drift.
export type ExtraUsage = { usedMinor: number; limitMinor: number; currency: string; exponent: number; utilization: number };
export type ClaudeUsage = { fiveHour: UsageWindow; sevenDay: UsageWindow; extra: ExtraUsage | null };
export type CodexUsageWindow = UsageWindow & { label: string; durationMinutes: number | null };
export type CodexUsage = { windows: CodexUsageWindow[] };
export type Usage = { claude: ClaudeUsage | null; codex: CodexUsage | null };

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

// Reads the Claude Code OAuth access token from wherever the CLI stored it: ~/.claude/.credentials.json
// (Linux/others), else the macOS Keychain. Returns null if not logged in.
async function readClaudeToken(): Promise<string | null> {
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

let lastGoodClaude: ClaudeUsage | null = null;
let lastGoodCodex: CodexUsage | null = null;

async function claudeUsage(): Promise<ClaudeUsage | null> {
  try {
    const token = await readClaudeToken();
    if (!token) return lastGoodClaude;
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return lastGoodClaude;
    lastGoodClaude = shapeUsage(await response.json());
  } catch (error) {
    console.error("[usage] Claude fetch failed:", error instanceof Error ? error.message : error);
  }
  return lastGoodClaude;
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

/** Current usage for every locally authenticated provider. Null only when neither is available. */
export async function usage(): Promise<Usage | null> {
  const [claude, codex] = await Promise.all([claudeUsage(), codexUsage()]);
  return claude || codex ? { claude, codex } : null;
}
