import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { densityAtom, draftRepoAtom, repoFilterAtom } from "@/lib/atoms";
import type { ChangeSummary } from "../../../server/git";
import {
  baseBranch, cliCommand, createWorkstream, providerFor, rerunAgent, setCardProvider, summary as fetchSummary, undoDraft, useAgentProviders, useRepos, useWorkstreams,
  type Lane, type OptimisticDraft, type Row,
} from "../store";
import { navigate } from "@/lib/route";
import { Check, CircleStop, Clock, Copy, ExternalLink, Eye, GitMerge, Loader2, Play, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChatComposer } from "@/components/ChatComposer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewControl } from "./PreviewControl";
import { agentLabel, type AgentProvider } from "../../../shared/agent";

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
  const rows = filter === "all" ? all : all.filter((r) => r.repo === filter);
  const cardsFor = (lane: Lane) => {
    const cards = rows.filter((r) => r.lane === lane);
    if (lane === "DONE") cards.sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "")); // recent first
    return cards;
  };

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
              {/* Pin the new-draft box to the top of the (scrolling) Local column so it stays reachable
                  no matter how many sessions pile up below. The backdrop full-bleeds over the column's
                  p-2 (negative margins on top+sides) and `-top-2` cancels the padding gap that
                  otherwise lets a card peek above a `top-0` sticky — so cards scroll cleanly *under* the
                  bar. It must be OPAQUE to hide those cards, but the column itself is a translucent
                  `bg-muted/30`; an opaque `bg-background` base with the same `bg-muted/30` tint layered
                  on top composites to the exact column colour, so the bar is seamless instead of a
                  lighter band. `p-2` keeps equal padding around the composer on all four sides. */}
              {lane === "LOCAL" && (
                <div className="bg-background sticky -top-2 z-20 -mx-2 -mt-2">
                  <div className="bg-muted/30 p-2">
                    <NewDraft />
                  </div>
                </div>
              )}
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
  <div className="text-muted-foreground min-w-fit text-[10px] font-semibold tracking-widest uppercase">{repo}</div>
);

// External destination link (opens elsewhere) — labelled + trailing arrow so it reads as "go there",
// distinct from the action buttons in the footer.
const DestLink = ({ href, children }: { href?: string; children: ReactNode }) => (
  <a className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 text-xs" href={href} target="_blank" rel="noreferrer">
    {children} <ExternalLink className="size-3" />
  </a>
);

// Copy icon (top-right) → a small dropdown of copy-to-clipboard actions: the PR link (only once
// there's a PR), the worktree name, and "Copy CLI" — the terminal command to resume the agent's
// session in that worktree (ensures a worktree exists first). All the grab-and-go affordances live
// here, off the card face, so the header stays uncluttered.
function CopyMenu({ row }: { row: Row }) {
  const [copied, setCopied] = useState(false);
  const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(flash, () => window.prompt(`Copy the ${label}:`, text));
  };
  // Copy CLI adopts a worktree if needed, resumes the pinned agent's session when it last ran here,
  // or (on a model switch) seeds a fresh interactive session with the portable transcript.
  const copyCli = async () => {
    const cmd = await cliCommand(row);
    try { await navigator.clipboard.writeText(cmd); flash(); } catch { window.prompt("Copy the CLI command:", cmd); }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title="Copy…" className="text-muted-foreground hover:text-foreground">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {row.prUrl && <DropdownMenuItem onSelect={() => copy(row.prUrl!, "PR link")} title="Copy PR link">Copy PR link</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => copy(row.branch, "worktree name")} title="Copy worktree name">Copy worktree name</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyCli()} title="Copy CLI: resume this agent's session in a terminal">Copy CLI</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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

// The card's agent, as a hover-reveal picker. At rest it reads as plain text (the provider name);
// hovering/focusing reveals it's a dropdown, and choosing re-pins the card so every action — Follow
// up, Fix CI, Resolve conflicts, Address review — uses it (store.setCardProvider / providerFor). It's
// a real Select trigger, so it's keyboard-focusable, not hover-only. stopPropagation keeps a click
// from bubbling to the card's row navigation.
function ProviderPicker({ row }: { row: Row }) {
  const providers = useAgentProviders();
  const provider = providerFor(row);
  return (
    <Select value={provider} onValueChange={(v) => setCardProvider(row, v as AgentProvider)}>
      <SelectTrigger
        size="sm"
        aria-label="Agent for this card"
        onClick={(e) => e.stopPropagation()}
        className="text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground -ml-1 -mr-2 h-auto w-fit gap-0.5 border-transparent bg-transparent pl-2 py-0 shadow-none focus-visible:ring-0 [&>svg]:size-3 [&>svg]:opacity-0 [&>svg]:transition-opacity hover:[&>svg]:opacity-70 data-[state=open]:[&>svg]:opacity-70"
      >
        {agentLabel(provider)}
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        {providers.map((p) => <SelectItem key={p} value={p}>{agentLabel(p)}</SelectItem>)}
      </SelectContent>
    </Select>
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
  const providers = useAgentProviders();
  const [repo, setRepo] = useAtom(draftRepoAtom);
  const [provider, setProvider] = useState<AgentProvider>(() => providers[0] ?? "claude");
  useEffect(() => { if (providers.length && !providers.includes(provider)) setProvider(providers[0]!); }, [providers, provider]);
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
      onSubmit={async (text, images) => setUndoable(createWorkstream(active, text, images, provider))}
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
        <div className="flex min-w-0 w-full items-center overflow-hidden">
          <Select value={active} onValueChange={setRepo}>
            <SelectTrigger size="sm" className="text-muted-foreground hover:bg-accent hover:text-foreground min-w-0 flex-1 border-0 shadow-none transition-colors focus-visible:ring-0"><SelectValue /></SelectTrigger>
            <SelectContent>
              {repos.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={provider} onValueChange={(v) => setProvider(v as AgentProvider)}>
            <SelectTrigger size="sm" aria-label="Agent provider" className="text-muted-foreground hover:bg-accent hover:text-foreground min-w-0 max-w-24 flex-1 border-0 shadow-none transition-colors focus-visible:ring-0"><SelectValue /></SelectTrigger>
            <SelectContent>
              {providers.map((p) => <SelectItem key={p} value={p}>{agentLabel(p)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
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
  // Dense view strips the card to its at-a-glance status (kept: repo, title, smaller status/condition
  // badges) plus a single toolbar row of icon buttons (Test locally, Follow up, Merge, Actions) so it
  // stays driveable; the prompt and diffstat are dropped. Done cards stay compact — they never densify.
  const dense = useAtomValue(densityAtom) === "dense" && !isDone;

  // Diffstat for every lane except Done (needs a worktree — Orca-made PRs keep theirs; adopted PRs
  // gain one on first action).
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  useEffect(() => {
    if (isDone || !row.worktreePath) return;
    const reload = () => void fetchSummary(row.repo, row.worktreePath!).then(setSummary).catch(() => {});
    reload();
    if (row.agentStatus !== "running") return;
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [isDone, row.repo, row.worktreePath, row.agentStatus]);
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
    <div className={`bg-card relative flex flex-col rounded-md border shadow-sm ${dense ? "gap-1 p-2" : "gap-2 p-3"} ${busy ? "pointer-events-none" : ""}`} aria-busy={busy}>
      {busy && (
        <div className="bg-card/60 absolute inset-0 z-10 flex items-center justify-center rounded-md">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      )}
      {/* Meta strip: repo (index tab) on the left, "open elsewhere" destinations on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <Eyebrow repo={row.repo} />
        <div className="flex shrink-0 items-center gap-3">
          {row.previewUrl && <DestLink href={row.previewUrl}>Preview</DestLink>}
          {row.prNumber && <DestLink href={row.prUrl}>PR #{row.prNumber}</DestLink>}
          <CopyMenu row={row} />
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
        {!dense && row.prompt && <p className="text-muted-foreground line-clamp-2 text-xs">{row.prompt}</p>}
      </div>

      {/* State: agent status leads (standardised across lanes), then Run, then condition badges.
          Local cards always show it (each is an agent session); PR cards only when a run is live/recent. */}
      {!isDone && (
        <div className={`flex flex-wrap items-center gap-1 ${dense ? "[&_[data-slot=badge]]:px-1.5 [&_[data-slot=badge]]:py-0 [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]_svg]:size-2.5" : ""}`}>
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

      {/* Detail: file changes + the card's agent picker, justified to opposite ends. All lanes but
          Done. (The worktree/branch name is dropped as visual noise — copy it from the top-right menu.) */}
      {!isDone && !dense && (
        <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
          {summary ? (
            <Diffstat summary={summary} />
          ) : isLocal ? (
            <div>no changes yet</div>
          ) : <div />}
          {(row.agentMeta || row.agentProvider || row.worktreePath || row.prNumber) && <ProviderPicker row={row} />}
        </div>
      )}
      {isDone && <div className="text-muted-foreground text-xs">merged {timeAgo(row.mergedAt)}</div>}

      {/* Preview + actions, below a divider — separated from the session info above. Comfortable
          stacks the full-width Test-locally control over the labelled verbs; dense folds every verb
          (Test locally, Follow up, Merge, Actions) into one row of icon buttons. */}
      {!isDone && (
        <div className={`space-y-2 border-t ${dense ? "pt-1.5" : "pt-2.5"}`}>
          {dense ? (
            <WorkstreamActions row={row} hasWork={hasWork} onBusy={setBusy} compact leading={<PreviewControl row={row} compact />} />
          ) : (
            <>
              <PreviewControl row={row} />
              <WorkstreamActions row={row} hasWork={hasWork} onBusy={setBusy} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
