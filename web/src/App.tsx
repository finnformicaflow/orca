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
        <div className="ml-auto flex items-center gap-2">
          {topLevel && <TestMasterMenu />}
          <UsageMeter />
          {topLevel && <RepoFilter />}
          <ProfileMenu />
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
    const load = () => void api.usage().then(setUsage).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!usage) return null;
  return (
    <div className="hidden items-center gap-1 sm:flex" aria-label="Claude usage limits">
      <UsagePill label="5h" pct={usage.fiveHour.utilization} resetsAt={usage.fiveHour.resetsAt} />
      <UsagePill label="wk" pct={usage.sevenDay.utilization} resetsAt={usage.sevenDay.resetsAt} />
      {usage.extra && <SpendPill extra={usage.extra} />}
    </div>
  );
}

// Traffic-light zone by how much of the allowance is burned: green (fine) → amber (caution, ≥75%)
// → red (the "red-zone", ≥90%). Tints the whole pill so it's glanceable at the edge of vision.
function usageZone(pct: number): "ok" | "warn" | "danger" {
  return pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok";
}
const ZONE_CLASS: Record<"ok" | "warn" | "danger", string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400",
};
const pillClass = (pct: number) =>
  `inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs ${ZONE_CLASS[usageZone(pct)]}`;

function UsagePill({ label, pct, resetsAt }: { label: string; pct: number; resetsAt: string | null }) {
  const resets = resetsAt ? `, resets ${new Date(resetsAt).toLocaleString()}` : "";
  return (
    <span className={pillClass(pct)} title={`Claude ${label} usage: ${pct}%${resets}`}>
      <span className="opacity-60">{label}</span>
      <span className="font-semibold tabular-nums">{pct}%</span>
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

// Pay-as-you-go spend this month, shown as actual money (£/$/€…) and coloured by how much of the
// extra-usage cap is used — same red-zone treatment as the rate-limit pills.
function SpendPill({ extra }: { extra: ExtraUsage }) {
  const used = formatMoney(extra.usedMinor, extra.exponent, extra.currency);
  const limit = formatMoney(extra.limitMinor, extra.exponent, extra.currency);
  return (
    <span className={pillClass(extra.utilization)} title={`Extra usage this month: ${used} of ${limit} (${extra.utilization}%)`}>
      <span className="opacity-60">extra</span>
      <span className="font-semibold tabular-nums">{used}</span>
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
