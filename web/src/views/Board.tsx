import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { boardViewAtom, draftRepoAtom, repoFilterAtom } from "@/lib/atoms";
import type { ChangeSummary } from "../../../server/git";
import {
  baseBranch, createWorkstream, rerunAgent, summary as fetchSummary, undoDraft, useRepos, useWorkstreams,
  type Lane, type OptimisticDraft, type Row,
} from "../store";
import { navigate } from "@/lib/route";
import { Check, ChevronRight, CircleStop, Clock, Copy, ExternalLink, Eye, GitMerge, Loader2, Play, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChatComposer } from "@/components/ChatComposer";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewControl } from "./PreviewControl";

const LANES: { lane: Lane; title: string }[] = [
  { lane: "LOCAL", title: "Local" },
  { lane: "DRAFT", title: "Draft" },
  { lane: "IN_REVIEW", title: "In Review" },
  { lane: "MERGEABLE", title: "Mergeable" },
  { lane: "DONE", title: "Done · today" },
];

export function Board() {
  const all = useWorkstreams();
  const filter = useAtomValue(repoFilterAtom);
  const view = useAtomValue(boardViewAtom);
  // Which list-view sections are collapsed (Linear-style accordion). Empty by default = all expanded.
  const [collapsed, setCollapsed] = useState<Set<Lane>>(new Set());
  const toggleLane = (lane: Lane) =>
    setCollapsed((s) => { const n = new Set(s); n.has(lane) ? n.delete(lane) : n.add(lane); return n; });
  const rows = filter === "all" ? all : all.filter((r) => r.repo === filter);
  const cardsFor = (lane: Lane) => {
    const cards = rows.filter((r) => r.lane === lane);
    if (lane === "DONE") cards.sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "")); // recent first
    return cards;
  };

  // List view: lanes stacked as collapsible sections rather than side-by-side columns. Only the
  // list scrolls (sticky headers stay put); empty lanes are hidden (Local always shows, for the
  // New-draft composer).
  if (view === "list")
    return (
      <div className="mx-auto flex max-w-3xl flex-col overflow-hidden md:h-[calc(100dvh-6.5rem)]">
        <div className="flex-1 space-y-1 overflow-y-auto px-1.5">
          {LANES.map(({ lane, title }) => {
            const cards = cardsFor(lane);
            if (cards.length === 0 && lane !== "LOCAL") return null;
            const isCollapsed = collapsed.has(lane);
            return (
              <section key={lane}>
                <div className="bg-background sticky top-0 z-10 flex items-center gap-2 py-2">
                  <button
                    type="button"
                    onClick={() => toggleLane(lane)}
                    aria-expanded={!isCollapsed}
                    className="text-muted-foreground hover:text-foreground flex flex-1 items-center gap-2 text-xs font-semibold tracking-wide uppercase"
                  >
                    <ChevronRight className={`size-3.5 transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
                    {title} <span className="opacity-60">{cards.length}</span>
                  </button>
                  {lane === "DONE" && cards.length > 0 && <CopyDone cards={cards} />}
                </div>
                {!isCollapsed && (
                  <div className="space-y-2 py-2">
                    {lane === "LOCAL" && <NewDraft />}
                    {cards.map((r) => <WorkstreamCard key={r.repo + r.branch} row={r} />)}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    );

  return (
    <div className="grid grid-cols-1 gap-3 md:h-[calc(100dvh-6.5rem)] md:grid-cols-3 xl:grid-cols-5">
      {LANES.map(({ lane, title }) => {
        const cards = cardsFor(lane);
        return (
          <div key={lane} className="bg-muted/30 flex flex-col overflow-hidden rounded-lg border">
            <h3 className="text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs font-semibold tracking-wide uppercase">
              {title} <span className="opacity-60">{cards.length}</span>
              {lane === "DONE" && cards.length > 0 && <CopyDone cards={cards} />}
            </h3>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {lane === "LOCAL" && <NewDraft />}
              {cards.map((r) => <WorkstreamCard key={r.repo + r.branch} row={r} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Copies today's completed work as a shareable markdown list (scoped by the active repo filter,
// since `cards` is already filtered). Handy for standups / status posts.
function CopyDone({ cards }: { cards: Row[] }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = cards.map((c) => `- ${c.title}${c.prNumber ? ` (#${c.prNumber})` : ""}${c.prUrl ? ` — ${c.prUrl}` : ""}`).join("\n");
    void navigator.clipboard.writeText(`Completed today:\n${text}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" onClick={copy} title="Copy completed work (respects the repo filter)" className="hover:text-foreground ml-auto inline-flex items-center gap-1 normal-case">
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

const Eyebrow = ({ repo }: { repo: string }) => (
  <div className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{repo}</div>
);

// External destination link (opens elsewhere) — labelled + trailing arrow so it reads as "go there",
// distinct from the action buttons in the footer.
const DestLink = ({ href, children }: { href?: string; children: ReactNode }) => (
  <a className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-xs" href={href} target="_blank" rel="noreferrer">
    {children} <ExternalLink className="size-3" />
  </a>
);

// Small copy-to-clipboard icon — sits next to the PR link so you can grab the URL without visiting it.
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => window.prompt("Copy the PR link:", url));
  };
  return (
    <button type="button" onClick={copy} title="Copy PR link" className="text-muted-foreground hover:text-foreground">
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

// Worktree/branch name, click to copy — the identifier you paste into `git worktree`/`checkout`.
function CopyName({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(name);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" onClick={copy} title="Copy worktree name" className="hover:text-foreground group flex max-w-full items-center gap-1">
      <code className="truncate">{name}</code>
      {copied ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

// Coloured diffstat: green additions, red deletions, then the file count.
function Diffstat({ summary }: { summary: ChangeSummary }) {
  return (
    <div>
      <span className="text-emerald-700 dark:text-emerald-400">+{summary.additions}</span>
      {" / "}
      <span className="text-destructive">−{summary.deletions}</span>
      {" · "}{summary.files.length} files
    </div>
  );
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function elapsed(startedMs?: number): string {
  if (!startedMs) return "";
  const s = Math.floor((Date.now() - startedMs) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function AgentBadge({ row, hasWork }: { row: Row; hasWork: boolean }) {
  const s = row.agentStatus ?? "idle";
  if (s === "running") return <Badge variant="secondary">Running {elapsed(row.agentStartedAt)} <Loader2 className="animate-spin" /></Badge>;
  if (s === "done") return <Badge variant="success">Done <Check /></Badge>;
  if (s === "error") return <Badge variant="destructive" title={row.agentError}>Error <X /></Badge>;
  // idle = no live/tracked run. If it committed work it's completed; if not, it's stopped.
  return hasWork ? <Badge variant="success">Completed <Check /></Badge> : <Badge variant="destructive">Stopped <CircleStop /></Badge>;
}

function ConditionBadges({ row }: { row: Row }) {
  return (
    <>
      {row.autoMergeEnabled && <Badge variant="outline" className="border-purple-500/20 bg-purple-500/10 text-purple-700 dark:text-purple-400">Auto-merge <GitMerge /></Badge>}
      {row.reviewStatus === "changes_requested" && <Badge variant="destructive">Changes requested</Badge>}
      {row.mergeable === "CONFLICTING" && <Badge variant="destructive">Conflicts</Badge>}
      {row.mergeable === "UNKNOWN" && <Badge variant="outline">Checking…</Badge>}
      {row.ciStatus === "passing" && <Badge variant="success">CI <Check /></Badge>}
      {row.ciStatus === "failing" && <Badge variant="destructive">CI <X /></Badge>}
      {row.ciStatus === "pending" && <Badge variant="outline">CI <Clock /></Badge>}
    </>
  );
}

function NewDraft() {
  const repos = useRepos();
  const [repo, setRepo] = useAtom(draftRepoAtom);
  const active = repo || repos[0]?.name || "";
  // The card + Undo appear the instant you submit — createWorkstream paints an optimistic draft and
  // does the worktree/agent work in the background. We keep the Undo affordance for ~6s so a mis-sent
  // draft (wrong repo) can be reverted; Undo discards it (kills the run, removes the worktree+branch).
  const [undoable, setUndoable] = useState<OptimisticDraft | null>(null);
  useEffect(() => {
    if (!undoable) return;
    const t = setTimeout(() => setUndoable(null), 6000);
    return () => clearTimeout(t);
  }, [undoable]);

  return (
    <ChatComposer
      persistKey="orca.newDraft"
      placeholder="Describe a feature…  (⌘+Enter)"
      onSubmit={async (text, images) => setUndoable(createWorkstream(active, text, images))}
      footer={undoable && (
        <p className="text-muted-foreground mt-1 flex items-center gap-1.5 px-1 text-xs">
          Sent to <span className="text-foreground font-medium">{undoable.repo}</span>
          <button
            type="button"
            className="text-foreground underline underline-offset-2 hover:no-underline"
            onClick={() => { void undoDraft(undoable); setUndoable(null); }}
          >
            Undo
          </button>
        </p>
      )}
      leading={
        <Select value={active} onValueChange={setRepo}>
          <SelectTrigger className="text-muted-foreground hover:bg-accent hover:text-foreground h-8 border-0 text-xs shadow-none transition-colors focus-visible:ring-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            {repos.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
      }
    />
  );
}

// One card for every lane. Sections switch on whether the row has an open PR / is done /
// is a draft, but the shell, header, and styling are shared.
export function WorkstreamCard({ row }: { row: Row }) {
  const isDone = row.lane === "DONE";
  const isOpenPr = Boolean(row.prNumber) && !isDone;
  const isLocal = !row.prNumber && !isDone; // draft or local (no-remote) branch

  // Diffstat for every lane except Done (needs a worktree — Orca-made PRs keep theirs; adopted PRs
  // gain one on first action).
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  useEffect(() => {
    if (isDone || !row.worktreePath) return;
    const reload = () => void fetchSummary(row.repo, row.worktreePath!).then(setSummary).catch(() => {});
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [isDone, row.repo, row.worktreePath]);
  const hasWork = (summary?.commits.length ?? 0) > 0;

  // Card-level busy: any action (from WorkstreamActions or the Run button) dims the card and shows
  // a spinner, so a multi-second op (promote push + PR create, merge, …) doesn't look frozen.
  const [busy, setBusy] = useState(false);
  const runBusy = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  // The title links to this workstream's detail view (PR or local session).
  const titleTo = isOpenPr ? `/${row.repo}/prs/${row.prNumber}`
    : isLocal ? `/${row.repo}/local/${encodeURIComponent(row.branch)}`
    : row.prNumber ? `/${row.repo}/prs/${row.prNumber}` : null; // done: link to the merged PR

  return (
    <div className={`bg-card relative flex flex-col gap-2 rounded-md border p-3 shadow-sm ${busy ? "pointer-events-none" : ""}`} aria-busy={busy}>
      {busy && (
        <div className="bg-card/60 absolute inset-0 z-10 flex items-center justify-center rounded-md">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      )}
      {/* Meta strip: repo (index tab) on the left, "open elsewhere" destinations on the right. */}
      <div className="flex items-center justify-between gap-2">
        <Eyebrow repo={row.repo} />
        <div className="flex shrink-0 items-center gap-3">
          {row.previewUrl && <DestLink href={row.previewUrl}>Preview</DestLink>}
          {row.prNumber && <DestLink href={row.prUrl}>PR #{row.prNumber}</DestLink>}
          {row.prUrl && <CopyLink url={row.prUrl} />}
        </div>
      </div>

      {/* Identity: the title anchors the card; prompt is supporting context. */}
      <div className="space-y-0.5">
        {titleTo ? (
          <button type="button" onClick={() => navigate(titleTo)} className="text-foreground block w-full truncate text-left text-sm font-medium hover:underline">
            {row.title}
          </button>
        ) : (
          <div className="truncate text-sm font-medium">{row.title}</div>
        )}
        {row.prompt && <p className="text-muted-foreground line-clamp-2 text-xs">{row.prompt}</p>}
      </div>

      {/* State: agent status leads (standardised across lanes), then Run, then condition badges.
          Local cards always show it (each is an agent session); PR cards only when a run is live/recent. */}
      {!isDone && (
        <div className="flex flex-wrap items-center gap-1">
          {isOpenPr && row.following && (
            <Badge variant="outline" className="border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-400" title="Orca is watching this PR and auto-runs the agent to resolve conflicts, fix CI, or address review comments.">
              Following <Eye />
            </Badge>
          )}
          {(isLocal || (row.agentStatus && row.agentStatus !== "idle")) && <AgentBadge row={row} hasWork={hasWork} />}
          {isLocal && row.worktreePath && row.agentStatus !== "running" && (
            <button type="button" onClick={() => void runBusy(() => rerunAgent(row))} title="Run agent" className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-5 items-center justify-center rounded">
              <Play className="size-3" />
            </button>
          )}
          {isOpenPr && <ConditionBadges row={row} />}
          {isLocal && row.mergeClean === "conflict" && <Badge variant="destructive">Conflicts with {baseBranch(row.repo)}</Badge>}
        </div>
      )}

      {/* Detail: worktree name (click to copy) on its own line, then the diffstat. All lanes but Done. */}
      {!isDone && (
        <div className="text-muted-foreground space-y-0.5 text-xs">
          <CopyName name={row.branch} />
          {summary ? (
            <Diffstat summary={summary} />
          ) : isLocal ? (
            <div>no changes yet</div>
          ) : null}
        </div>
      )}
      {isDone && <div className="text-muted-foreground text-xs">merged {timeAgo(row.mergedAt)}</div>}

      {/* Local preview: its own full-width row, sitting between the session context and the actions. */}
      {!isDone && <PreviewControl row={row} />}

      {/* Actions: PR/agent verbs, below a divider — separated from the info + preview above. */}
      {!isDone && (
        <div className="border-t pt-2.5">
          <WorkstreamActions row={row} hasWork={hasWork} onBusy={setBusy} />
        </div>
      )}
    </div>
  );
}
