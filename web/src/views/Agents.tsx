// The Agents page — Vercel's Deployments list, adapted: a quick-filter row grouped into families
// (State, Activity, Repo) with the active filters as dashed chips — instance and orchestrated stay
// as the row's own column/badge rather than a pill — then one dense row per workstream with only
// what you act on (workstream.listColumns): the title over repo · model, the
// status (a spinner and a live elapsed time while running), the PR state + number, checks and the
// review cluster, the instance, when it last moved, and the actions. Columns flex and truncate, so
// the list never scrolls sideways. Clicking a row opens its agent page; every action is in the
// trailing ⋯ and on right-click (WorkstreamActions, menu-only). The swimlanes stay behind List | Board.
// On a phone (below md) each row stacks — title, latest instruction, status, then where it runs —
// with every action in its one ⋯ menu, and the chips and sort move into a Filters bottom sheet
// beside the search box.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ThreadChips } from "@/components/SourceChip";
import { useAtom, useAtomValue } from "jotai";
import { ArrowDown, Columns3, GitPullRequest, List, ListFilter, Loader2, Rows2, Rows3, Search, X } from "lucide-react";
import { agentQueryAtom, boardViewAtom, densityAtom, instanceScopeAtom, repoFilterAtom, type BoardView } from "@/lib/atoms";
import { navigate, useSearch } from "@/lib/route";
import { useNow } from "@/lib/ticker";
import { oneOf, persistedKey, readPersisted, usePersisted, writePersisted } from "@/lib/persisted";
import { useNarrow } from "@/lib/viewport";
import { usePullToRefresh } from "@/lib/gestures";
import { BottomSheet } from "@/components/BottomSheet";
import { instanceChoices, modelFor, refresh, thisInstance, useRepos, useWorkstreams, useWorkstreamsLoaded, type Row } from "../store";
import {
  DEFAULT_LIST_FILTER, NO_QUICK_FILTER, QUICK_GROUPS, SORT_LABELS, applyQuickFilter, attentionReasons, filterRows, formatDuration, formatElapsed, prPill,
  listColumns, listGridTemplate, modelBadge, notMergedCount, parseQuickFilter, promptInstruction, quickActive, quickCount, quickFilterQuery, rowDuration, rowInstance, rowTone, sortRows, toggleNotMerged, toggleQuick,
  type ListColumn, type ListSort, type OverviewLane, type QuickFilter, type QuickGroup, type RowTone,
} from "../workstream";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OrchStatusNote, Pill, Skeleton, UpkeepNote, StatusDot, type DotTone } from "@/components/console";
import { TerminalDialog } from "@/components/Terminal";
import { Board, ConditionBadges, CopyDone, LaneActions, useSummary, useTerminalOpen } from "./Board";
import { QuickActionButtons, WorkstreamActions } from "./WorkstreamActions";
import { PreviewCell, PrPreviewInline } from "./PreviewControl";
import { ReviewCluster } from "./Review";
import { StatusHoverCard } from "./StatusCard";
import { Input } from "@/components/ui/input";

export function Agents() {
  const [view, setView] = useAtom(boardViewAtom);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <div className="flex items-center gap-2">
          {view === "board" && <DensityToggle />}
          <ViewToggle view={view} setView={setView} />
        </div>
      </div>
      {view === "board" ? <Board /> : <AgentsList />}
    </div>
  );
}

const VIEWS: { value: BoardView; label: string; Icon: typeof List }[] = [
  { value: "list", label: "List", Icon: List },
  { value: "board", label: "Board", Icon: Columns3 },
];
// Board only: flip every (non-Done) card between the full card and a status-only dense one.
function DensityToggle() {
  const [density, setDensity] = useAtom(densityAtom);
  const dense = density === "dense";
  const label = dense ? "Switch to comfortable view" : "Switch to dense view";
  return (
    <Button size="icon" variant="outline" className="size-8" aria-pressed={dense} onClick={() => setDensity(dense ? "comfortable" : "dense")} aria-label={label}>
      {dense ? <Rows2 className="size-4" /> : <Rows3 className="size-4" />}
    </Button>
  );
}

function ViewToggle({ view, setView }: { view: BoardView; setView: (v: BoardView) => void }) {
  return (
    <div role="group" aria-label="View" className="inline-flex h-8 items-center rounded-md border p-0.5">
      {VIEWS.map(({ value, label, Icon }) => (
        <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}
          className={`inline-flex h-full items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition-colors ${view === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          <Icon className="size-3.5" /> {label}
        </button>
      ))}
    </div>
  );
}

// How many placeholder rows to show while the first agents+PRs refresh is in flight — enough to fill
// a typical viewport without guessing the real count (which we don't have yet).
const SKELETON_ROWS = 6;

function AgentsList() {
  const all = useWorkstreams();
  const loaded = useWorkstreamsLoaded();
  const repo = useAtomValue(repoFilterAtom); // the top bar's scope
  const instance = useAtomValue(instanceScopeAtom); // the sidebar's scope
  const [q, setQ] = useAtom(agentQueryAtom);
  const search = useSearch();
  const quick = parseQuickFilter(search);
  const [sort, setSort] = usePersisted<ListSort>(persistedKey("agents.sort"), "updated", oneOf(...(Object.keys(SORT_LABELS) as ListSort[])));
  const here = thisInstance();
  const filtersKey = persistedKey("agents.filters", repo); // the chips + search, per repo scope
  // The URL is the source of truth whenever it has a query (links keep working); /agents opened
  // bare restores this scope's last chips + search and writes them into the URL. Every change after
  // that is saved, so Clear (an empty query, no search) is remembered too.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (restoredFor.current !== filtersKey) {
      restoredFor.current = filtersKey;
      if (!search) {
        const saved = readPersisted(filtersKey, NO_SAVED_FILTERS, isSavedFilters);
        const restoreQ = !q && saved.q; // a query the Find box just typed wins over the saved one
        if (restoreQ) setQ(saved.q);
        const query = quickFilterQuery(parseQuickFilter(saved.query)); // re-normalised: never trust stored text as-is
        if (query) { navigate(`/agents${query}`, true); return; }
        if (restoreQ) return;
      }
    }
    writePersisted(filtersKey, { query: quickFilterQuery(quick), q });
  }, [filtersKey, search, q]); // quick derives from search
  // The scopes first (they hold on every page), then the search box, then the quick chips.
  const scoped = filterRows(all, { ...DEFAULT_LIST_FILTER, repo, instance, q }, here);
  const visible = sortRows(applyQuickFilter(scoped, quick, here), sort);
  const setQuick = (f: QuickFilter) => navigate(`/agents${quickFilterQuery(f)}`, true); // a filter change is not a history step
  const clear = () => { setQ(""); setQuick(NO_QUICK_FILTER); };
  const cols = listColumns();
  const stacked = useNarrow(); // a phone: rows stack, no column header
  const sectionRef = useRef<HTMLElement>(null);
  const pull = usePullToRefresh(sectionRef, refresh, stacked); // a phone: pull down from the top to refresh
  return (
    <section ref={sectionRef} aria-label="Agents" className="space-y-3">
      {stacked && pull.phase !== "idle" && (
        <div data-slot="pull-to-refresh" data-phase={pull.phase} role="status" style={{ height: pull.offset }}
          className="text-muted-foreground flex items-end justify-center gap-1.5 overflow-hidden pb-2 text-xs">
          {pull.phase === "refreshing" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            : <ArrowDown className={`size-4 transition-transform ${pull.phase === "release" ? "rotate-180" : ""}`} aria-hidden="true" />}
          {pull.phase === "refreshing" ? "Refreshing…" : pull.phase === "release" ? "Release to refresh" : "Pull to refresh"}
        </div>
      )}
      <FilterRow scoped={scoped} quick={quick} setQuick={setQuick} clear={clear} visible={visible} total={all.length} q={q} setQ={setQ} sort={sort} setSort={setSort}
        showRepos={repo === "all"} loaded={loaded} />
      <div data-slot="workstream-list" role="table" aria-label="Workstreams" className="bg-card overflow-hidden rounded-lg border">
        {(!loaded || visible.length > 0) && !stacked && <ListHeader cols={cols} />}
        {!loaded ? (
          Array.from({ length: SKELETON_ROWS }, (_, i) => <AgentRowSkeleton key={i} cols={cols} stacked={stacked} />)
        ) : visible.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 px-4 py-14 text-sm">
            No agents match.
            <Button size="sm" variant="outline" onClick={clear}>Clear filters</Button>
          </div>
        ) : visible.map((r) => <AgentRow key={r.repo + r.branch} row={r} cols={cols} stacked={stacked} />)}
      </div>
    </section>
  );
}

/** A row-shaped placeholder, matching `AgentRow`'s grid (desktop) or stacked (phone) layout, so the
 *  list doesn't reflow once the real rows land. */
function AgentRowSkeleton({ cols, stacked }: { cols: ListColumn[]; stacked: boolean }) {
  if (stacked) {
    return (
      <div data-slot="workstream-row-skeleton" className="flex items-start gap-1 border-b py-3 px-4 last:border-b-0">
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-16" />
          </div>
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-3 w-full max-w-xs" />
        </div>
      </div>
    );
  }
  return (
    <div data-slot="workstream-row-skeleton" role="row" style={rowGrid(cols)} className={`${GRID} h-14 border-b last:border-b-0`}>
      {cols.map((c) => (
        <div key={c.key} role="cell" className="min-w-0">
          <Skeleton className={`h-3.5 ${c.key === "actions" ? "ml-auto w-8" : c.key === "workstream" ? "w-40" : "w-16"}`} />
        </div>
      ))}
    </div>
  );
}

// What the Agents list remembers per repo scope: the chips as their URL query, and the search text.
type SavedFilters = { query: string; q: string };
const NO_SAVED_FILTERS: SavedFilters = { query: "", q: "" };
const isSavedFilters = (v: unknown): v is SavedFilters =>
  typeof v === "object" && v !== null && typeof (v as SavedFilters).query === "string" && typeof (v as SavedFilters).q === "string";

type Chip = { group: QuickGroup; value: string; label: string; dot?: DotTone };

// The grouping is in the data only now (no visible caption or extra gap between families): this
// wrapper stays in the DOM, keyed by `label`, so a chip's family is still inspectable, but
// `contents` keeps it out of layout so every chip reads as one flat, evenly-gapped wrapping row.
function ChipFamily({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-slot="quick-filter-group" data-group={label.toLowerCase()} className="contents">
      {children}
    </div>
  );
}

// Vercel's filter row: one-click chips, each with its count, toggleable and combinable (AND across
// groups, OR within one); the URL query holds them, so a filtered view is a link. Search and sort sit
// at the end.
function FilterRow({ scoped, quick, setQuick, clear, visible, total, q, setQ, sort, setSort, showRepos, loaded }: {
  scoped: Row[]; quick: QuickFilter; setQuick: (f: QuickFilter) => void; clear: () => void; visible: Row[]; total: number;
  q: string; setQ: (v: string) => void; sort: ListSort; setSort: (s: ListSort) => void;
  showRepos: boolean; loaded: boolean;
}) {
  const repos = useRepos();
  const here = thisInstance();
  // State and instance/by are columns and badges already (instance column, the orchestrated bot
  // icon); only the lane-ish and activity chips earn a pill here. Grouped Vercel-style: a muted
  // caption per family, chips within a family read as one segmented row.
  const stateChips: Chip[] = [
    { group: "pr", value: "open", label: "Open PRs" },
    { group: "pr", value: "mergeable", label: "Mergeable", dot: "queued" },
    { group: "pr", value: "merged", label: "Merged today", dot: "ready" },
  ];
  const activityChips: Chip[] = [
    { group: "status", value: "running", label: "Running", dot: "building" },
    { group: "status", value: "attention", label: "Needs attention", dot: "warning" },
  ];
  const repoChips: Chip[] = showRepos && repos.length > 1 ? repos.map((r): Chip => ({ group: "repo", value: r.name, label: r.name })) : [];
  // The lane the chips narrow to, when exactly one: the swimlanes' bulk verbs apply to it.
  const lane: OverviewLane | null = quick.pr.length === 1 && quick.pr[0] !== "open" ? (quick.pr[0] === "merged" ? "DONE" : "MERGEABLE") : null;
  const narrow = useNarrow();
  const [sheet, setSheet] = useState(false);
  const renderChip = (c: Chip) => {
    const on = (quick[c.group] as string[]).includes(c.value);
    return (
      <button key={`${c.group}:${c.value}`} type="button" data-slot="quick-filter" data-chip={`${c.group}:${c.value}`} aria-pressed={on}
        onClick={() => setQuick(toggleQuick(quick, c.group, c.value))}
        className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors ${on ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:border-foreground/30"}`}>
        {c.dot && <StatusDot tone={c.dot} className="size-2" />}
        {c.label}
        <span data-slot="quick-count" className={`tabular-nums ${on ? "opacity-70" : "opacity-60"}`}>
          {loaded ? quickCount(scoped, quick, c.group, c.value, here) : <Skeleton className="h-3 w-3" />}
        </span>
      </button>
    );
  };
  const notMergedChip = (
    <button key="notMerged" type="button" data-slot="quick-filter" data-chip="notMerged" aria-pressed={quick.notMerged}
      onClick={() => setQuick(toggleNotMerged(quick))}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors ${quick.notMerged ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:border-foreground/30"}`}>
      Not merged
      <span data-slot="quick-count" className={`tabular-nums ${quick.notMerged ? "opacity-70" : "opacity-60"}`}>
        {loaded ? notMergedCount(scoped, quick, here) : <Skeleton className="h-3 w-3" />}
      </span>
    </button>
  );
  const chipGroup = (
      <div role="group" aria-label="Quick filters" className="flex flex-wrap items-center gap-1.5">
        <ChipFamily label="State">{stateChips.map(renderChip)}{notMergedChip}</ChipFamily>
        <ChipFamily label="Activity">{activityChips.map(renderChip)}</ChipFamily>
        {repoChips.length > 0 && <ChipFamily label="Repo">{repoChips.map(renderChip)}</ChipFamily>}
        {(quickActive(quick) || q) && (
          <button type="button" data-slot="clear-filters" onClick={clear} className="text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 px-1.5 text-[13px]">
            <X className="size-3.5" /> Clear
          </button>
        )}
      </div>
  );
  const sortSelect = (
          <Select value={sort} onValueChange={(v) => setSort(v as ListSort)}>
            <Tip label={`Sort: ${SORT_LABELS[sort]}`}>
              <SelectTrigger className="h-8 w-40" aria-label="Sort"><span className="text-muted-foreground text-xs">Sort</span><SelectValue /></SelectTrigger>
            </Tip>
            <SelectContent>{(Object.keys(SORT_LABELS) as ListSort[]).map((k) => <SelectItem key={k} value={k}>{SORT_LABELS[k]}</SelectItem>)}</SelectContent>
          </Select>
  );
  const searchBox = (
        <label className="bg-card focus-within:ring-ring/40 flex h-8 min-w-48 flex-1 items-center gap-2 rounded-md border px-2.5 focus-within:ring-2 sm:max-w-72 max-md:h-11 max-md:min-w-0">
          <Search className="text-muted-foreground size-4 shrink-0" strokeWidth={1.5} />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents…" aria-label="Search workstreams"
            className="h-auto rounded-none border-0 bg-transparent px-0 py-0 focus-visible:ring-0 flex-1 md:text-[13px]" />
          {q && <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="text-muted-foreground hover:text-foreground max-md:-mr-2 max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center"><X className="size-3.5" /></button>}
        </label>
  );
  const laneActions = (
    <>
      {lane === "DONE" && visible.length > 0 && <span className="text-muted-foreground"><CopyDone cards={visible} /></span>}
      {lane && <span className="text-muted-foreground"><LaneActions lane={lane} cards={visible} /></span>}
    </>
  );
  if (narrow) {
    // A phone: the search box and a Filters button (with how many chips are on) on one line; the
    // chips and the sort live in a bottom sheet. The count and the lane's bulk verbs stay in view.
    const active = QUICK_GROUPS.reduce((n, g) => n + quick[g].length, 0) + (quick.notMerged ? 0 : 1);
    return (
      <div data-slot="filter-bar" className="space-y-2">
        <div className="flex items-center gap-2">
          {searchBox}
          <Button variant="outline" className="h-11 shrink-0" data-slot="filters-button" aria-haspopup="dialog" onClick={() => setSheet(true)}>
            <ListFilter className="size-4" />Filters{active > 0 && <span data-slot="filters-active" className="bg-foreground text-background rounded-full px-1.5 text-[11px] tabular-nums">{active}</span>}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums" data-slot="agents-count">{loaded ? `${visible.length} of ${total}` : <Skeleton className="h-3 w-16" />}</span>
          <span className="ml-auto flex items-center gap-2">{laneActions}</span>
        </div>
        <BottomSheet open={sheet} onClose={() => setSheet(false)} title="Filters" slot="filter-sheet">
          {chipGroup}
          <div className="flex items-center justify-between gap-2">{sortSelect}<Button onClick={() => setSheet(false)}>Show {visible.length}</Button></div>
        </BottomSheet>
      </div>
    );
  }
  return (
    <div data-slot="filter-bar" className="space-y-2">
      {chipGroup}
      <div className="flex flex-wrap items-center gap-2">
        {searchBox}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums" data-slot="agents-count">{loaded ? `${visible.length} of ${total}` : <Skeleton className="h-3 w-16" />}</span>
          {laneActions}
          {sortSelect}
        </div>
      </div>
    </div>
  );
}

// ---- the row ----

const rowGrid = (cols: ListColumn[]) => ({ gridTemplateColumns: listGridTemplate(cols) });
const GRID = "grid items-center gap-x-3 px-4"; // gap / padding: workstream.LIST_GAP_PX / LIST_PAD_PX

/** Lines added/removed, compact: green `+N`, red `-N` — a PR's own diffstat (gh, free) or, for a
 *  branch with no PR yet, the worktree's `git diff` against base (useSummary). */
function Diffstat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span data-slot="diffstat" className="shrink-0 tabular-nums">
      <span className="text-emerald-700 dark:text-emerald-400">+{additions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  );
}

function ListHeader({ cols }: { cols: ListColumn[] }) {
  return (
    <div role="row" data-slot="workstream-list-header" style={rowGrid(cols)} className={`${GRID} text-muted-foreground h-9 border-b text-xs`}>
      {cols.map((c) => <div key={c.key} role="columnheader" data-col={c.key} className={`truncate ${c.key === "actions" ? "text-right" : ""}`}>{c.label}</div>)}
    </div>
  );
}

export const TONE_DOT: Record<RowTone, DotTone> = { running: "building", failed: "error", attention: "warning", ready: "ready", neutral: "neutral" };
export const TONE_LABEL: Record<RowTone, string> = { running: "Running", failed: "Error", attention: "Needs you", ready: "Ready", neutral: "Idle" };

/** The agent page a row opens: its PR page, or its local-session page. */
export function detailPath(row: Pick<Row, "repo" | "branch" | "lane" | "prNumber">): string | null {
  if (row.prNumber) return `/${row.repo}/prs/${row.prNumber}`;
  if (row.lane !== "DONE" && !row.branch.startsWith("opt-")) return `/${row.repo}/local/${encodeURIComponent(row.branch)}`;
  return null;
}

// A click on the row (not on one of its controls) opens the agent page. Menus portal out of the
// row's DOM but React still bubbles their clicks here — hence the contains().
const INTERACTIVE = "button, a, input, textarea, select, dialog, [role=menu], [role=menuitem], [role=dialog]";
function openOnRowClick(row: Row) {
  return (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!e.currentTarget.contains(t) || t.closest(INTERACTIVE)) return;
    const to = detailPath(row);
    if (to) navigate(to);
  };
}

/** The newest thing asked of the agent — what Vercel's row shows as the commit message. */
export function latestInstruction(row: Row): string {
  const last = row.transcript?.[row.transcript.length - 1];
  const text = last ? (last.instruction ?? promptInstruction(last.prompt)) : row.prompt;
  return (text || "").replace(/\s+/g, " ").trim();
}

export function AgentRow({ row, cols, stacked = false }: { row: Row; cols: ListColumn[]; stacked?: boolean }) {
  const isDone = row.lane === "DONE";
  const pill = prPill(row);
  const [busy, setBusy] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [terminalOpen, setTerminalOpen] = useTerminalOpen(row); // "New chat" pops its conversation open on arrival
  const tone = rowTone(row);
  const reasons = attentionReasons(row);
  const multiInstance = instanceChoices().length > 1; // instance is a phone-only subline detail, not its own column
  const instance = rowInstance(row, thisInstance());
  const to = detailPath(row);
  const model = modelBadge(row.agentMeta?.model, row.worktreePath || row.prNumber ? modelFor(row) : undefined);
  const instruction = latestInstruction(row);
  const error = row.agentStatus === "error" ? row.agentError : undefined;
  const hasMenu = !isDone;
  // A PR's own diffstat (gh, free) when there is one; otherwise the worktree's `git diff` against
  // base (useSummary — shared with the card, cached/polled there already).
  const localSummary = useSummary(row.prNumber ? undefined : row);
  const diffAdditions = row.prNumber ? row.prAdditions : localSummary?.additions;
  const diffDeletions = row.prNumber ? row.prDeletions : localSummary?.deletions;
  const hasDiff = Boolean((diffAdditions ?? 0) > 0 || (diffDeletions ?? 0) > 0);
  const diffstat = hasDiff && <Diffstat additions={diffAdditions ?? 0} deletions={diffDeletions ?? 0} />;
  // Right-click (or the keyboard's menu key / Shift+F10 on a focused row) opens the ⋯ menu's items
  // where the pointer is; from the keyboard there is no pointer, so it opens at the row's left edge.
  // Never from a finger: a long-press fires contextmenu too, and popped the menu while you were only
  // scrolling or holding — on touch the menu opens from the ⋯ alone (see the stacked row below).
  const lastPointer = useRef("");
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (!hasMenu || (e.target as HTMLElement).closest("a, input, textarea")) return; // links keep the browser's menu
    if (lastPointer.current === "touch") { e.preventDefault(); return; }
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setMenuAt(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 16, y: r.bottom });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" && to) navigate(to);
  };
  const closeMenu = () => { setMenuAt(null); if (!document.activeElement || document.activeElement === document.body) ref.current?.focus({ preventScroll: true }); };
  // Create PR needs commits of its own — the same worktree summary the diffstat reads.
  const hasWork = row.prNumber ? true : (localSummary?.commits.length ?? 0) > 0;
  // The state-aware quick icons sit left of the preview cell; they only PEEK at the review cache.
  const quick = hasMenu && <QuickActionButtons row={row} hasWork={hasWork} peek onBusy={setBusy} />;
  const menu = hasMenu && <WorkstreamActions row={row} hasWork={hasWork} compact menuOnly onBusy={setBusy} onFollowUp={to ? () => navigate(`${to}/chat`) : undefined}
    onOpen={to ? () => navigate(to) : undefined} contextAt={menuAt} onContextClose={closeMenu} />;
  const prLink = row.prNumber && <a href={row.prUrl} target="_blank" rel="noreferrer" data-slot="pr-link" className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-0.5 font-mono text-xs"><GitPullRequest className="size-3.5" />{row.prNumber}</a>;
  if (stacked) return (
    // A phone: a taller, card-like row with no fixed-width columns — everything wraps instead of
    // scrolling sideways. Line 1 is title + status; line 2 is branch/model/PR/preview/diffstat. The
    // quick actions and ⋯ menu used to sit in their own trailing column — fixed-width touch targets
    // squeezing the title/branch text into a narrow strip that truncated badly. They now sit at the
    // end of the state/condition-badges line instead (icon-only, no forced touch-target size), so the
    // content column gets the row's full width. State/condition badges, reasons and a run error
    // follow as their own wrapping lines.
    <div
      ref={ref} role="row" tabIndex={0} data-slot="workstream-row" data-layout="stacked" data-branch={row.branch} aria-busy={busy}
      aria-label={row.title}
      onClick={openOnRowClick(row)} onKeyDown={onKeyDown}
      // A phone: no menu from a long-press or contextmenu at all, only the browser's own on a link.
      // No selection or iOS callout either, which looked like a menu popping; links keep their callout.
      onContextMenu={(e) => { if (!(e.target as HTMLElement).closest("a, input, textarea")) e.preventDefault(); }}
      className={`active:bg-accent/40 flex items-start select-none [-webkit-touch-callout:none] [&_a]:[-webkit-touch-callout:default] gap-1 border-b py-3 px-4 text-sm outline-none last:border-b-0 ${to ? "cursor-pointer" : ""} ${busy ? "pointer-events-none opacity-60" : ""}`}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div role="cell" className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium">{row.title}</span>
          <RunStatus row={row} tone={tone} reasons={reasons} />
        </div>
        <div role="cell" className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          <span className="shrink-0">{row.repo}</span>
          <ThreadChips repo={row.repo} branch={row.branch} />
          <span aria-hidden="true">·</span><span className="min-w-0 font-mono break-all">{row.branch}</span>
          {model && <><span aria-hidden="true">·</span><span data-slot="model-label">{model.label}</span></>}
          {prLink}
          {!isDone && <PrPreviewInline row={row} />}
          {diffstat && <><span aria-hidden="true">·</span>{diffstat}</>}
          {instance && multiInstance && <><span aria-hidden="true">·</span><span data-slot="instance-chip">{instance}</span></>}
        </div>
        {instruction && <div data-slot="row-instruction" role="cell" className="text-muted-foreground line-clamp-2 text-xs break-words">{instruction}</div>}
        {!isDone && <OrchStatusNote status={row.orchStatus} />}
        {!isDone && <UpkeepNote upkeep={row.upkeep} running={row.agentStatus === "running"} />}
        <div role="cell" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          {pill.tooltip ? <Tip label={pill.tooltip}><Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill></Tip> : <Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill>}
          {row.prNumber && !isDone && <ConditionBadges row={row} />}
          {row.prNumber && !isDone && <ReviewCluster row={row} />}
          {!row.prNumber && row.mergeClean === "conflict" && <Pill tone="red">Conflicts</Pill>}
          {(quick || menu) && <div data-slot="row-actions" className="ml-auto flex shrink-0 items-center gap-1">{quick}{menu}</div>}
        </div>
        {reasons.length > 0 && <div role="cell" data-slot="row-reasons" className="text-geist-warning-fg text-xs">{reasons.join(" · ")}</div>}
        {error && <div role="cell" data-slot="row-error" className="text-geist-red line-clamp-3 text-xs break-words">{error}</div>}
      </div>
      {!isDone && <TerminalDialog row={row} open={terminalOpen} onClose={() => setTerminalOpen(false)} />}
    </div>
  );
  return (
    <div
      ref={ref} role="row" tabIndex={0} data-slot="workstream-row" data-branch={row.branch} aria-busy={busy}
      aria-label={row.title} aria-haspopup={hasMenu ? "menu" : undefined}
      onClick={openOnRowClick(row)} onContextMenu={onContextMenu} onKeyDown={onKeyDown}
      onPointerDown={(e) => { lastPointer.current = e.pointerType; }}
      style={rowGrid(cols)}
      className={`${GRID} hover:bg-accent/40 focus-visible:bg-accent/40 h-14 border-b text-sm outline-none last:border-b-0 ${to ? "cursor-pointer" : ""} ${busy ? "pointer-events-none opacity-60" : ""}`}
    >
      <div role="cell" className="min-w-0">
        <div className="truncate font-medium">{row.title}</div>
        <div className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
          <span className="shrink-0">{row.repo}</span>
          <ThreadChips repo={row.repo} branch={row.branch} iconOnly />
          {model && <><span aria-hidden="true">·</span><Tip label={model.title}><span data-slot="model-label" className="shrink-0">{model.label}</span></Tip></>}
          {!isDone && <PrPreviewInline row={row} />}
          {diffstat && <><span aria-hidden="true">·</span>{diffstat}</>}
          {error && <><span aria-hidden="true">·</span><span data-slot="row-error" className="text-geist-red truncate">{error}</span></>}
        </div>
      </div>
      <div role="cell" className="min-w-0"><RunStatus row={row} tone={tone} reasons={reasons} /></div>
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {pill.tooltip ? <Tip label={pill.tooltip}><Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill></Tip> : <Pill tone={pill.tone} slot="state-pill">{pill.label}</Pill>}
        {row.prNumber && <a href={row.prUrl} target="_blank" rel="noreferrer" data-slot="pr-link" className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-0.5 font-mono text-xs"><GitPullRequest className="size-3.5" />{row.prNumber}</a>}
      </div>
      <div role="cell" data-slot="row-signals"
        className="flex min-w-0 items-center gap-1 overflow-hidden [&>*]:shrink-0 [&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:py-0 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]_svg]:size-2.5">
        {row.prNumber && !isDone && <ConditionBadges row={row} />}
        {row.prNumber && !isDone && <ReviewCluster row={row} />}
        {!row.prNumber && row.mergeClean === "conflict" && <Pill tone="red">Conflicts</Pill>}
        {!isDone && <OrchStatusNote status={row.orchStatus} chipOnly />}
      </div>
      <div role="cell" className="flex items-center justify-end gap-1">
        {quick}
        {!isDone && <PreviewCell row={row} />}
        {menu}
        {!isDone && <TerminalDialog row={row} open={terminalOpen} onClose={() => setTerminalOpen(false)} />}
      </div>
    </div>
  );
}

/** The status cell: dot + label, and the duration. While running, a spinner and an elapsed time read
 *  off the ONE shared ticker (lib/ticker) — only this cell re-renders each second, never the list. */
export function RunStatus({ row, tone, reasons }: { row: Row; tone: RowTone; reasons: string[] }) {
  const running = row.agentStatus === "running" && Boolean(row.agentStartedAt);
  const now = useNow(running);
  const duration = running ? undefined : rowDuration(row);
  return (
    <div data-slot="run-status" className="flex min-w-0 items-center gap-2 whitespace-nowrap">
      <StatusHoverCard row={row}>
        {tone === "running" ? <Loader2 data-slot="run-spinner" aria-hidden="true" className="text-geist-amber size-3 shrink-0 animate-spin" /> : <StatusDot tone={TONE_DOT[tone]} />}
        <span data-tone={tone} className="truncate font-medium">{TONE_LABEL[tone]}</span>
      </StatusHoverCard>
      {running && now !== undefined && (
        <Tip label={`Running since ${new Date(row.agentStartedAt!).toLocaleTimeString()}`}>
          <span data-slot="elapsed" className="text-muted-foreground tabular-nums">{formatElapsed(now - row.agentStartedAt!)}</span>
        </Tip>
      )}
      {duration !== undefined && <span className="text-muted-foreground tabular-nums">{formatDuration(duration)}</span>}
    </div>
  );
}
