import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { CircleUser, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { navigate, useRoute } from "@/lib/route";
import { repoFilterAtom } from "@/lib/atoms";
import { useTheme, type Theme } from "@/lib/theme";
import { api } from "./api";
import type { ClaudeUsage, CodexUsage, ExtraUsage, Usage } from "../../server/usage";
import { useRepos } from "./store";
import { Board } from "./views/Board";
import { PreviewManagerMenu, TestMasterMenu } from "./views/PreviewControl";
import { PrDetail } from "./views/PrDetail";
import { LocalDetail } from "./views/LocalDetail";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";

export function App() {
  const route = useRoute();
  const topLevel = route.name === "board";
  return (
    <div className="w-full px-4 py-4 md:px-6">
      <header className="mb-6 flex items-center gap-3">
        <Wordmark />
        <p className="text-muted-foreground hidden text-sm sm:block">the pod that ships</p>
        {/* Right cluster reads as two groups: read-only usage status, then a divider, then controls. */}
        <div className="ml-auto flex items-center gap-3">
          <UsageMeter />
          <div className="flex items-center gap-2">
            {/* Test master + running-previews read as one segmented control (connected borders). */}
            {topLevel && (
              <div className="inline-flex -space-x-px [&>button]:rounded-none [&>button:first-of-type]:rounded-l-md [&>button:last-of-type]:rounded-r-md">
                <TestMasterMenu />
                <PreviewManagerMenu />
              </div>
            )}
            {topLevel && <RepoFilter />}
            <ProfileMenu />
          </div>
        </div>
      </header>
      {route.name === "pr" ? <PrDetail repo={route.repo} number={route.number} sub={route.sub} />
        : route.name === "local" ? <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />
        : <Board />}
    </div>
  );
}

// The mark: a geometric orca silhouette (single-fill, currentColor, eye punched out via evenodd so
// it reads on any theme) beside a monospace "Orca" wordmark. The whole lockup links home to the board.
function Wordmark() {
  return (
    <button onClick={() => navigate("/")} className="flex items-center gap-2" title="Orca — board" aria-label="Orca — go to board">
      <OrcaMark className="text-foreground size-6" />
      <span className="font-mono text-xl font-semibold tracking-tight">Orca</span>
    </button>
  );
}

function OrcaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className} aria-hidden="true">
      <path d="M2 12.5C2 9.5 5.5 8 9 8L11 3L13.5 8C16.5 8 19 8.5 20.5 9L22.5 6L20.3 11L22.5 15.5C19 13 10 14 2 12.5ZM5.6 10a1 1 0 1 0 0 2a1 1 0 1 0 0 -2Z" />
    </svg>
  );
}

// Board-only control: filter by repo (only meaningful with more than one configured).
function RepoFilter() {
  const repos = useRepos();
  const [filter, setFilter] = useAtom(repoFilterAtom);
  if (repos.length <= 1) return null;
  return (
    <Select value={filter} onValueChange={setFilter}>
      <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All repos</SelectItem>
        {repos.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// Provider usage (top-right): two compact terminal-bar groups, side by side.
// Polls the bridge every five minutes and keeps the last successful snapshot on transient failures.
function UsageMeter() {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    // Keep the last value on a transient null/failure (the endpoint rate-limits) so the widget
    // doesn't flicker out; the server also serves last-good, this is the client-side belt.
    const load = () => void api.usage().then((u) => { if (u) setUsage(u); }).catch(() => {});
    load();
    // Every 5 min — the 5h/weekly windows move slowly, so this is plenty fresh and stays well clear
    // of the endpoint's rate limit (which used to null the widget out).
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  if (!usage) return null;
  return (
    <>
      <div className="text-muted-foreground hidden items-center gap-3 font-mono text-[10px] leading-tight sm:flex" aria-label="Agent usage limits">
        {usage.claude && <ClaudeUsageGroup usage={usage.claude} />}
        {usage.claude && usage.codex && <span className="opacity-30" aria-hidden="true">│</span>}
        {usage.codex && <CodexUsageGroup usage={usage.codex} />}
      </div>
      {/* Full button-height footprint (h-8) but the visible line is inset by py-1 — reads as the
          same height as the buttons, just a touch shorter. */}
      <div className="hidden h-8 py-1 sm:block" aria-hidden="true">
        <div className="bg-border h-full w-px" />
      </div>
    </>
  );
}

function ClaudeUsageGroup({ usage }: { usage: ClaudeUsage }) {
  return (
    <div className="flex items-center gap-2" aria-label="Claude usage limits">
      <span className="opacity-70">claude</span>
      <UsageStat provider="Claude" label="5h" pct={usage.fiveHour.utilization} resetsAt={usage.fiveHour.resetsAt} />
      <UsageStat provider="Claude" label="1w" pct={usage.sevenDay.utilization} resetsAt={usage.sevenDay.resetsAt} />
      {usage.extra && <SpendStat extra={usage.extra} />}
    </div>
  );
}

function CodexUsageGroup({ usage }: { usage: CodexUsage }) {
  return (
    <div className="flex items-center gap-2" aria-label="Codex usage limits">
      <span className="opacity-70">codex</span>
      {usage.windows.map((window, index) => (
        <UsageStat key={`${window.label}-${index}`} provider="Codex" label={window.label === "wk" ? "1w" : window.label} pct={window.utilization} resetsAt={window.resetsAt} />
      ))}
    </div>
  );
}

// Traffic-light zone by how much of the allowance is burned: green (fine) → amber (caution, ≥75%)
// → red (the "red-zone", ≥90%). Colours the figure only — statusline style, not a badge.
function usageZone(pct: number): "ok" | "warn" | "danger" {
  return pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok";
}
const ZONE_TEXT: Record<"ok" | "warn" | "danger", string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

/** Compact countdown to a window's reset, e.g. "45m", "1.5h", "2h", "3d" — null if unknown or
 *  already past. `now` is injectable for tests (defaults to wall-clock). Pure. Lives here (not
 *  server/usage.ts) so it stays out of a browser bundle that can't resolve that module's node/Bun
 *  imports. */
export function untilReset(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  // Half-hour granularity — a 90-minute window reads "1.5h", not a lopsided "2h".
  const hrs = Math.round(mins / 30) / 2;
  return hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
}

function UsageStat({ provider, label, pct, resetsAt }: { provider: string; label: string; pct: number; resetsAt: string | null }) {
  const left = untilReset(resetsAt);
  const resets = resetsAt ? `, resets ${new Date(resetsAt).toLocaleString()}` : "";
  const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
  return (
    <span className="whitespace-nowrap" title={`${provider} ${label} usage: ${pct}%${resets}`}>
      {label}{" "}
      <span className={`font-semibold ${ZONE_TEXT[usageZone(pct)]}`}>
        <span aria-hidden="true">{"█".repeat(filled)}{"░".repeat(5 - filled)}</span>{" "}{pct}%
        {left && <span className="ml-0.5 font-normal opacity-60">({left})</span>}
      </span>
    </span>
  );
}

/** Format money carried as minor units (+ exponent) in its own currency, e.g. 8535/2/GBP → "£85.35". */
function formatMoney(minor: number, exponent: number, currency: string): string {
  const amount = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: exponent }).format(amount);
  } catch {
    return `${amount.toFixed(exponent)} ${currency}`; // unknown currency code → plain number + code
  }
}

// Pay-as-you-go spend this month as actual money, coloured by how much of the cap is used.
function SpendStat({ extra }: { extra: ExtraUsage }) {
  const used = formatMoney(extra.usedMinor, extra.exponent, extra.currency);
  const limit = formatMoney(extra.limitMinor, extra.exponent, extra.currency);
  return (
    <span className="whitespace-nowrap" title={`Extra usage this month: ${used} of ${limit} (${extra.utilization}%)`}>
      $ <span className={`font-semibold ${ZONE_TEXT[usageZone(extra.utilization)]}`}>{used}</span>
    </span>
  );
}

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

// Profile menu (top-right, all views): refresh the app + a theme submenu (light/dark/system).
function ProfileMenu() {
  const [theme, setTheme] = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="outline" className="size-8" title="Profile" aria-label="Profile menu">
          <CircleUser className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => window.location.reload()} title="Reload the app (pick up rebuilt code + refetch)">
          <RefreshCw className="size-3.5" /> Refresh
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              {THEMES.map(({ value, label, Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}><Icon className="size-3.5" /> {label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
