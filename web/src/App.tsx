import { useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { Check, CircleUser, FolderSync, Loader2, Monitor, Moon, RefreshCw, Rows2, Rows3, Sun, X } from "lucide-react";
import { navigate, useRoute } from "@/lib/route";
import { densityAtom, repoFilterAtom } from "@/lib/atoms";
import { useTheme, type Theme } from "@/lib/theme";
import { api } from "./api";
import type { ClaudeUsage, CodexUsage, ExtraUsage, Usage } from "../../server/usage";
import { useRepos } from "./store";
import { summarizeSync } from "./workstream";
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
            {topLevel && <DensityToggle />}
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

// Board-only control: flip every (non-Done) card between the full comfortable card and a compact,
// status-only dense card — one persisted toggle, so a board with many sessions fits on screen.
function DensityToggle() {
  const [density, setDensity] = useAtom(densityAtom);
  const dense = density === "dense";
  return (
    <Button
      size="icon" variant="outline" className="size-8" aria-pressed={dense}
      onClick={() => setDensity(dense ? "comfortable" : "dense")}
      title={dense ? "Switch to comfortable view" : "Switch to dense view"}
      aria-label={dense ? "Switch to comfortable view" : "Switch to dense view"}
    >
      {dense ? <Rows2 className="size-4" /> : <Rows3 className="size-4" />}
    </Button>
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

/** Merge a fresh usage poll over the last-known one, PER PROVIDER: a provider that came back null
 *  this poll (a transient failure, or not fetched yet) keeps its previous value instead of blanking
 *  the bar. Pure, so the belt is testable without a timer. */
export function mergeUsage(prev: Usage | null, next: Usage): Usage {
  return { claude: next.claude ?? prev?.claude ?? null, codex: next.codex ?? prev?.codex ?? null };
}

// Provider usage (top-right): two compact terminal-bar groups, side by side.
// Poll cadence self-adjusts: fast until both bars are filled, then every five minutes.
function UsageMeter() {
  const [usage, setUsage] = useState<Usage | null>(null);
  // Mirror the state for synchronous merge/completeness checks inside the poll loop (setState's
  // updater can't reliably report back). Not for rendering — that reads `usage`.
  const latest = useRef<Usage | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let fastTries = 0;
    const SLOW = 5 * 60_000, FAST = 15_000, MAX_FAST = 4;
    const schedule = (ms: number) => { if (!cancelled) timer = setTimeout(load, ms); };
    // Merge PER PROVIDER: a single provider's transient null — Claude's endpoint rate-limiting, the
    // Codex app-server handshake timing out, or a just-restarted bridge with a cold cache — must not
    // drop the OTHER provider that's already showing. Until both are present, retry soon (bounded) so
    // a cold start fills the bar in seconds; once complete, settle into the slow cadence.
    const load = () => void api.usage().then((u) => {
      if (cancelled) return;
      let complete = false;
      if (u) {
        const next = mergeUsage(latest.current, u);
        latest.current = next;
        setUsage(next);
        complete = Boolean(next.claude && next.codex);
      }
      schedule(complete || ++fastTries > MAX_FAST ? SLOW : FAST);
    }).catch(() => schedule(FAST));
    load();
    return () => { cancelled = true; clearTimeout(timer); };
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

/** Compact countdown to a window's reset, e.g. "45m", "1h 15m", "2h", "7d 2h" — null if unknown or
 *  already past. `now` is injectable for tests (defaults to wall-clock). Pure. Lives here (not
 *  server/usage.ts) so it stays out of a browser bundle that can't resolve that module's node/Bun
 *  imports. */
export function untilReset(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) {
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  }
  const days = Math.floor(mins / (24 * 60));
  const hours = Math.floor((mins % (24 * 60)) / 60);
  return `${days}d${hours ? ` ${hours}h` : ""}`;
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

// Pull remote work down across every configured repo: fetch each, fast-forward its worktrees to
// their upstreams (never forces). Keeps the menu open (onSelect preventDefault) so its inline
// spinner → ✓/✗ feedback and per-outcome summary stay visible, matching the ActionButton pattern.
function SyncWorktreesItem() {
  const repos = useRepos();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [summary, setSummary] = useState("");
  const run = async () => {
    if (state === "loading") return;
    setState("loading");
    setSummary("");
    try {
      const results = (await Promise.all(repos.map((r) => api.syncWorktrees(r.name)))).flat();
      setSummary(summarizeSync(results));
      setState("done");
    } catch {
      setSummary("sync failed");
      setState("error");
    }
    setTimeout(() => { setState("idle"); setSummary(""); }, 6000);
  };
  const Icon = state === "loading" ? Loader2 : state === "done" ? Check : state === "error" ? X : FolderSync;
  return (
    <DropdownMenuItem
      onSelect={(e) => { e.preventDefault(); void run(); }}
      disabled={state === "loading"}
      title="Fetch each repo and fast-forward every worktree to its upstream (never forces, skips dirty/diverged)"
    >
      <Icon className={`size-3.5${state === "loading" ? " animate-spin" : ""}`} /> Sync worktrees
      {summary && <span className="text-muted-foreground ml-auto pl-3 text-xs">{summary}</span>}
    </DropdownMenuItem>
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
        <SyncWorktreesItem />
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
