import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { CircleUser, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { navigate, useRoute } from "@/lib/route";
import { boardViewAtom, repoFilterAtom } from "@/lib/atoms";
import { useTheme, type Theme } from "@/lib/theme";
import { api } from "./api";
import type { ExtraUsage, Usage } from "../../server/usage";
import { useRepos } from "./store";
import { Board } from "./views/Board";
import { TestMasterMenu } from "./views/PreviewControl";
import { Review } from "./views/Review";
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
  const topLevel = route.name === "board" || route.name === "review";
  return (
    <div className="w-full px-4 py-4 md:px-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-xl font-semibold">🐳 Orca</h1>
        <p className="text-muted-foreground hidden text-sm sm:block">agent + PR control plane</p>
        {topLevel && <Nav active={route.name} />}
        {/* Right cluster reads as two groups: read-only usage status, then a divider, then controls. */}
        <div className="ml-auto flex items-center gap-3">
          <UsageMeter />
          <div className="flex items-center gap-2">
            {topLevel && <TestMasterMenu />}
            {topLevel && <RepoFilter />}
            <ProfileMenu />
          </div>
        </div>
      </header>
      {route.name === "pr" ? <PrDetail repo={route.repo} number={route.number} sub={route.sub} />
        : route.name === "local" ? <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />
        : route.name === "review" ? <Review />
        : <Board />}
    </div>
  );
}

// Top-level nav: your own kanban ("Board"), the same board stacked as lists ("List"), and the
// coworker review queue ("Review"). Board/List both live on "/" and just flip the display mode.
function Nav({ active }: { active: "board" | "review" }) {
  const [view, setView] = useAtom(boardViewAtom);
  const onBoard = active === "board";
  const link = (isActive: boolean, onClick: () => void, label: string) => (
    <button
      className={`rounded-md px-2.5 py-1 text-sm font-medium ${isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
  return (
    <nav className="flex items-center gap-1">
      {link(onBoard && view === "board", () => { setView("board"); navigate("/"); }, "Board")}
      {link(onBoard && view === "list", () => { setView("list"); navigate("/"); }, "List")}
      {link(active === "review", () => navigate("/review"), "Review")}
    </nav>
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

// Claude subscription limits (top-right): how much of the 5-hour rolling window and the weekly
// allowance you've burned, à la the CLI statusline. Polls the bridge (`/api/usage`) each minute;
// renders nothing when you're not on a Claude.ai plan / not logged in (the endpoint returns null).
function UsageMeter() {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    // Keep the last value on a transient null/failure (the endpoint rate-limits) so the widget
    // doesn't flicker out; the server also serves last-good, this is the client-side belt.
    const load = () => void api.usage().then((u) => { if (u) setUsage(u); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!usage) return null;
  // A statusline, à la the CLI: monospace, dim labels, coloured figures — no boxes/badges. A trailing
  // divider (only rendered with the stats, so no lone line when usage is hidden) sets it apart from
  // the controls to its right.
  return (
    <>
      <div className="text-muted-foreground hidden items-center gap-3 font-mono text-xs sm:flex" aria-label="Claude usage limits">
        <UsageStat label="5h" pct={usage.fiveHour.utilization} resetsAt={usage.fiveHour.resetsAt} />
        <UsageStat label="wk" pct={usage.sevenDay.utilization} resetsAt={usage.sevenDay.resetsAt} />
        {usage.extra && <SpendStat extra={usage.extra} />}
      </div>
      <div className="bg-border hidden h-5 w-px sm:block" aria-hidden="true" />
    </>
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

function UsageStat({ label, pct, resetsAt }: { label: string; pct: number; resetsAt: string | null }) {
  const resets = resetsAt ? `, resets ${new Date(resetsAt).toLocaleString()}` : "";
  return (
    <span title={`Claude ${label} usage: ${pct}%${resets}`}>
      {label} <span className={`font-semibold ${ZONE_TEXT[usageZone(pct)]}`}>{pct}%</span>
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

// Pay-as-you-go spend this month as actual money (£/$/€…), coloured by how much of the cap is used.
function SpendStat({ extra }: { extra: ExtraUsage }) {
  const used = formatMoney(extra.usedMinor, extra.exponent, extra.currency);
  const limit = formatMoney(extra.limitMinor, extra.exponent, extra.currency);
  return (
    <span title={`Extra usage this month: ${used} of ${limit} (${extra.utilization}%)`}>
      extra <span className={`font-semibold ${ZONE_TEXT[usageZone(extra.utilization)]}`}>{used}</span>
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
