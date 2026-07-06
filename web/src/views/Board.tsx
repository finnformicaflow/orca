import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { draftPromptAtom, draftRepoAtom, repoFilterAtom } from "@/lib/atoms";
import type { ChangeSummary } from "../../../server/git";
import {
  baseBranch, createWorkstream, rerunAgent, summary as fetchSummary, useRepos, useWorkstreams,
  type Lane, type Row,
} from "../store";
import { readyForReview } from "../workstream";
import { navigate } from "@/lib/route";
import { Check, CircleStop, Clock, Copy, ExternalLink, Loader2, Play, X } from "lucide-react";
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
  const rows = filter === "all" ? all : all.filter((r) => r.repo === filter);
  return (
    <div className="grid grid-cols-1 gap-3 md:h-[calc(100dvh-6.5rem)] md:grid-cols-3 xl:grid-cols-5">
      {LANES.map(({ lane, title }) => {
        const cards = rows.filter((r) => r.lane === lane);
        if (lane === "DONE") cards.sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "")); // recent first
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
      {row.reviewStatus === "changes_requested" && <Badge variant="destructive">changes requested</Badge>}
      {readyForReview({ state: "OPEN", mergeable: row.mergeable ?? "UNKNOWN", ciStatus: row.ciStatus ?? "none", reviewStatus: row.reviewStatus ?? "none" }) && <Badge variant="secondary">ready for review</Badge>}
      {row.mergeable === "CONFLICTING" && <Badge variant="destructive">conflicts</Badge>}
      {row.mergeable === "UNKNOWN" && <Badge variant="outline">checking…</Badge>}
      {row.ciStatus === "passing" && <Badge variant="success">CI <Check /></Badge>}
      {row.ciStatus === "failing" && <Badge variant="destructive">CI <X /></Badge>}
      {row.ciStatus === "pending" && <Badge variant="outline">CI <Clock /></Badge>}
    </>
  );
}

function NewDraft() {
  const repos = useRepos();
  const [repo, setRepo] = useAtom(draftRepoAtom);
  const [prompt, setPrompt] = useAtom(draftPromptAtom);
  const active = repo || repos[0]?.name || "";

  return (
    <ChatComposer
      value={prompt}
      onChange={setPrompt}
      placeholder="Describe a feature…  (⌘+Enter)"
      onSubmit={(text, images) => createWorkstream(active, text, images)}
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
function WorkstreamCard({ row }: { row: Row }) {
  const isDone = row.lane === "DONE";
  const isOpenPr = Boolean(row.prNumber) && !isDone;
  const isLocal = !row.prNumber && !isDone; // draft or local (no-remote) branch

  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  useEffect(() => {
    if (!isLocal || !row.worktreePath) return;
    const reload = () => void fetchSummary(row.repo, row.worktreePath!).then(setSummary).catch(() => {});
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [isLocal, row.repo, row.worktreePath]);
  const hasWork = (summary?.commits.length ?? 0) > 0;

  // The title links to this workstream's detail view (PR or local session).
  const titleTo = isOpenPr ? `/${row.repo}/prs/${row.prNumber}`
    : isLocal ? `/${row.repo}/local/${encodeURIComponent(row.branch)}`
    : row.prNumber ? `/${row.repo}/prs/${row.prNumber}` : null; // done: link to the merged PR

  return (
    <div className="bg-card flex flex-col gap-2 rounded-md border p-3 shadow-sm">
      {/* Meta strip: repo (index tab) on the left, "open elsewhere" destinations on the right. */}
      <div className="flex items-center justify-between gap-2">
        <Eyebrow repo={row.repo} />
        <div className="flex shrink-0 items-center gap-3">
          {row.previewUrl && <DestLink href={row.previewUrl}>Preview</DestLink>}
          {row.prNumber && <DestLink href={row.prUrl}>PR #{row.prNumber}</DestLink>}
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

      {/* State: badges scan left-to-right; Run sits by the status tag (re-launch a stopped session). */}
      {!isDone && (
        <div className="flex flex-wrap items-center gap-1">
          {isLocal && <AgentBadge row={row} hasWork={hasWork} />}
          {isLocal && row.worktreePath && row.agentStatus !== "running" && (
            <button type="button" onClick={() => void rerunAgent(row)} title="Run agent" className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-5 items-center justify-center rounded">
              <Play className="size-3" />
            </button>
          )}
          {isOpenPr && <ConditionBadges row={row} />}
          {isLocal && row.mergeClean === "conflict" && <Badge variant="destructive">conflicts with {baseBranch(row.repo)}</Badge>}
        </div>
      )}

      {/* Detail line: branch + diffstat / agent result / merged-when. */}
      {isLocal && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
          <code className="truncate">{row.branch}</code>
          <span>{summary ? `+${summary.additions}/−${summary.deletions} · ${summary.files.length} files` : "no changes yet"}</span>
        </div>
      )}
      {isLocal && row.agentStatus === "done" && row.agentResult && (
        <div className="text-muted-foreground border-l-2 pl-2 text-xs italic line-clamp-3">{row.agentResult}</div>
      )}
      {isDone && <div className="text-muted-foreground text-xs">merged {timeAgo(row.mergedAt)}</div>}

      {/* Local preview: its own full-width row, sitting between the session context and the actions. */}
      {!isDone && <PreviewControl row={row} />}

      {/* Actions: PR/agent verbs, below a divider — separated from the info + preview above. */}
      {!isDone && (
        <div className="border-t pt-2.5">
          <WorkstreamActions row={row} hasWork={hasWork} />
        </div>
      )}
    </div>
  );
}
