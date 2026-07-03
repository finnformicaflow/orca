import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useAtom } from "jotai";
import { draftPromptAtom, draftRepoAtom } from "@/lib/atoms";
import type { ChangeSummary } from "../../../server/git";
import {
  baseBranch, createWorkstream, discardDraft, merge, promote, rerunAgent, resolveConflicts,
  summary as fetchSummary, useRepos, useWorkstreams, type Lane, type Row,
} from "../store";
import { attachCommand, readyForReview } from "../workstream";
import { navigate } from "@/lib/route";
import { Check, ChevronDown, CircleStop, Clock, ExternalLink, Loader2, Trash2, X } from "lucide-react";
import { ActionButton } from "@/components/ActionButton";
import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PrActions } from "./PrActions";
import { PreviewControl } from "./PreviewControl";

const LANES: { lane: Lane; title: string }[] = [
  { lane: "LOCAL", title: "Local" },
  { lane: "DRAFT", title: "Draft" },
  { lane: "IN_REVIEW", title: "In Review" },
  { lane: "MERGEABLE", title: "Mergeable" },
  { lane: "DONE", title: "Done · today" },
];

export function Board() {
  const rows = useWorkstreams();
  return (
    <div className="grid grid-cols-1 gap-3 md:h-[calc(100dvh-6.5rem)] md:grid-cols-3 xl:grid-cols-5">
      {LANES.map(({ lane, title }) => {
        const cards = rows.filter((r) => r.lane === lane);
        if (lane === "DONE") cards.sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "")); // recent first
        return (
          <div key={lane} className="bg-muted/30 flex flex-col overflow-hidden rounded-lg border">
            <h3 className="text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs font-semibold tracking-wide uppercase">
              {title} <span className="opacity-60">{cards.length}</span>
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

const Eyebrow = ({ repo }: { repo: string }) => (
  <div className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{repo}</div>
);

const ExtLink = ({ href, children }: { href?: string; children: ReactNode }) => (
  <a className="text-muted-foreground inline-flex items-center gap-0.5 text-xs hover:underline" href={href} target="_blank" rel="noreferrer">
    {children}<ExternalLink className="size-3" />
  </a>
);

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const h = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? "just now" : h === 1 ? "1h ago" : `${h}h ago`;
}

function elapsed(startedMs?: number): string {
  if (!startedMs) return "";
  const s = Math.floor((Date.now() - startedMs) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

// Promote a local branch into a PR — choose ready/draft and optionally set the preview label.
function PromoteMenu({ row, disabled }: { row: Row; disabled: boolean }) {
  const [label, setLabel] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async (draft: boolean) => {
    setBusy(true);
    try { await promote(row, { draft, addPreviewLabel: label }); } finally { setBusy(false); }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="default" disabled={disabled || busy}>
          {busy ? <><Loader2 className="animate-spin" /> Promoting…</> : <>Promote <ChevronDown className="size-3.5" /></>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuCheckboxItem checked={label} onCheckedChange={(c) => setLabel(Boolean(c))} onSelect={(e) => e.preventDefault()}>
          Add preview label
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void go(false)}>Create PR (ready)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void go(true)}>Create draft PR</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AgentBadge({ row, hasWork }: { row: Row; hasWork: boolean }) {
  const s = row.agentStatus ?? "idle";
  if (s === "running") return <Badge variant="secondary"><Loader2 className="animate-spin" /> running {elapsed(row.agentStartedAt)}</Badge>;
  if (s === "done") return <Badge variant="success"><Check /> done</Badge>;
  if (s === "error") return <Badge variant="destructive" title={row.agentError}><X /> error</Badge>;
  // idle = no live/tracked run. If it committed work it's completed; if not, it's stopped.
  return hasWork ? <Badge variant="success"><Check /> completed</Badge> : <Badge variant="destructive"><CircleStop /> stopped</Badge>;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = repo || repos[0]?.name || "";

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || !active || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createWorkstream(active, prompt.trim());
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
  };

  return (
    <form onSubmit={submit} className="bg-card space-y-2 rounded-md border p-2 shadow-sm">
      <Textarea placeholder="Describe a feature…  (⌘+Enter)" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKey} rows={3} />
      <div className="flex items-center gap-2">
        <Select value={active} onValueChange={setRepo}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {repos.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={busy || !prompt.trim()}>{busy ? "Creating…" : "New"}</Button>
        {error && <span className="text-destructive text-xs">{error}</span>}
      </div>
    </form>
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

  return (
    <div className="bg-card space-y-2 rounded-md border px-3 pt-1.5 pb-3 shadow-sm">
      <div>
        <div className="flex items-center justify-between gap-2">
          <Eyebrow repo={row.repo} />
          <div className="flex shrink-0 items-center gap-2">
            {!isDone && <PreviewControl row={row} />}
            {row.prNumber && <ExtLink href={row.prUrl}>#{row.prNumber}</ExtLink>}
            {isLocal && (
              <Button variant="ghost" title="Discard" className="text-destructive hover:bg-destructive/10 hover:text-destructive h-auto w-auto p-0.5" onClick={() => { if (confirm(`Discard "${row.title}" (${row.branch})? Removes the worktree and branch.`)) void discardDraft(row); }}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
        {isOpenPr ? (
          <Button variant="link" className="text-foreground h-auto w-full justify-start p-0 text-sm font-medium" onClick={() => navigate(`/${row.repo}/prs/${row.prNumber}`)}>
            <span className="min-w-0 truncate">{row.title}</span>
          </Button>
        ) : isLocal ? (
          <Button variant="link" className="text-foreground h-auto w-full justify-start p-0 text-sm font-medium" onClick={() => navigate(`/${row.repo}/local/${encodeURIComponent(row.branch)}`)}>
            <span className="min-w-0 truncate">{row.title}</span>
          </Button>
        ) : (
          <div className="truncate text-sm font-medium">{row.title}</div>
        )}
        {row.prompt && <p className="text-muted-foreground mt-0.5 line-clamp-3 text-xs">{row.prompt}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {isLocal && <AgentBadge row={row} hasWork={hasWork} />}
        {isOpenPr && <ConditionBadges row={row} />}
        {isLocal && row.mergeClean === "conflict" && <Badge variant="destructive">conflicts with {baseBranch(row.repo)}</Badge>}
      </div>

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

      {isOpenPr && <PrActions row={row} />}
      {isLocal && <LocalActions row={row} hasWork={hasWork} />}
    </div>
  );
}

// Local-session action bar — shared by the board card and the local-session detail page.
export function LocalActions({ row, hasWork }: { row: Row; hasWork: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.worktreePath && <CopyButton text={attachCommand({ worktreePath: row.worktreePath, sessionId: row.sessionId })}>Copy CLI</CopyButton>}
      {row.worktreePath && row.agentStatus !== "running" && <ActionButton size="sm" variant="outline" onRun={() => rerunAgent(row)}>Run</ActionButton>}
      {row.mergeClean === "conflict" && row.lane !== "LOCAL" && <ActionButton size="sm" onRun={() => resolveConflicts(row)}>Resolve conflicts</ActionButton>}
      {row.lane === "LOCAL" && (row.hasRemote
        ? <PromoteMenu row={row} disabled={!hasWork} />
        : <ActionButton size="sm" variant="default" disabled={!hasWork} onRun={() => promote(row)}>Promote</ActionButton>)}
      {row.lane === "MERGEABLE" && <ActionButton size="sm" variant="default" confirm={`Merge ${row.branch} into ${baseBranch(row.repo)} locally? This can't be undone.`} onRun={() => merge(row)}>Merge</ActionButton>}
    </div>
  );
}
