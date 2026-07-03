import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { ChangeSummary } from "../../../server/git";
import {
  createWorkstream, discardDraft, promote, rerunAgent, summary as fetchSummary,
  useAgents, usePrs, type AgentRow, type PrRow,
} from "../store";
import { attachCommand, readyForReview } from "../workstream";
import { navigate } from "@/lib/route";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { PrActions } from "./PrActions";
import { PreviewControl } from "./PreviewControl";

export function Board() {
  const drafts = useAgents();
  const prs = usePrs();
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const flagNew = (b: string) => {
    setNewBranch(b);
    setTimeout(() => setNewBranch((cur) => (cur === b ? null : cur)), 2500);
  };

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Column title="Draft">
        <NewDraft onCreated={flagNew} />
        {drafts.map((d) => <DraftCard key={d.branch} row={d} isNew={d.branch === newBranch} />)}
      </Column>
      <Column title="In Review">
        {prs.filter((p) => p.kanbanState === "IN_REVIEW").map((p) => <PrCard key={p.number} row={p} />)}
      </Column>
      <Column title="Mergeable">
        {prs.filter((p) => p.kanbanState === "MERGEABLE").map((p) => <PrCard key={p.number} row={p} />)}
      </Column>
    </div>
  );
}

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border p-2">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function NewDraft({ onCreated }: { onCreated: (branch: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createWorkstream(prompt.trim()));
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <Textarea placeholder="Describe a feature…  (⌘+Enter)" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKey} rows={3} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !prompt.trim()}>{busy ? "Creating…" : "New draft"}</Button>
        {error && <span className="text-destructive text-xs">{error}</span>}
      </div>
    </form>
  );
}

const AGENT_LABEL: Record<AgentRow["agentStatus"], string> = {
  idle: "idle", running: "● claude running", done: "✓ claude done", error: "claude error",
};
const AGENT_VARIANT: Record<AgentRow["agentStatus"], "secondary" | "success" | "destructive" | "outline"> = {
  idle: "outline", running: "secondary", done: "success", error: "destructive",
};

function DraftCard({ row, isNew }: { row: AgentRow; isNew: boolean }) {
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  useEffect(() => {
    const reload = () => void fetchSummary(row.worktreePath).then(setSummary).catch(() => {});
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [row.worktreePath]);

  const hasWork = (summary?.commits.length ?? 0) > 0;
  const discard = () => {
    if (confirm(`Discard draft "${row.title}" (${row.branch})? This removes the worktree and branch.`)) {
      void discardDraft(row.branch, row.worktreePath);
    }
  };

  return (
    <Card className={`gap-2 py-3 ${isNew ? "ring-primary ring-2" : ""}`}>
      <CardHeader className="flex-row items-center justify-between px-3">
        <CardTitle className="truncate text-sm">{row.title}</CardTitle>
        <Badge variant={AGENT_VARIANT[row.agentStatus]} title={row.agentError}>{AGENT_LABEL[row.agentStatus]}</Badge>
      </CardHeader>
      <CardContent className="space-y-1 px-3">
        <code className="text-muted-foreground block truncate text-xs">{row.branch}</code>
        <p className="text-muted-foreground text-xs">
          {summary
            ? `${summary.commits.length} commits · +${summary.additions}/−${summary.deletions} · ${summary.files.length} files`
            : "no changes yet"}
        </p>
      </CardContent>
      <CardFooter className="flex-wrap gap-1 px-3">
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(attachCommand(row))}>Copy CLI</Button>
        <Button size="sm" variant="ghost" onClick={() => void rerunAgent(row.branch, row.worktreePath)}>Re-run</Button>
        <PreviewControl branch={row.branch} worktreePath={row.worktreePath} />
        <Button size="sm" variant="ghost" onClick={discard}>Discard</Button>
        <Button size="sm" disabled={!hasWork} onClick={() => void promote(row.branch, row.worktreePath, row.title)}>Promote</Button>
      </CardFooter>
    </Card>
  );
}

function ConditionBadges({ row }: { row: PrRow }) {
  return (
    <>
      {row.reviewStatus === "changes_requested" && <Badge variant="destructive">changes requested</Badge>}
      {readyForReview(row) && <Badge variant="secondary">ready for review</Badge>}
      {row.mergeable === "CONFLICTING" && <Badge variant="destructive">conflicts</Badge>}
      {row.mergeable === "UNKNOWN" && <Badge variant="outline">checking…</Badge>}
      {row.ciStatus === "passing" && <Badge variant="success">CI ✓</Badge>}
      {row.ciStatus === "failing" && <Badge variant="destructive">CI ✗</Badge>}
      {row.ciStatus === "pending" && <Badge variant="outline">CI…</Badge>}
    </>
  );
}

function PrCard({ row }: { row: PrRow }) {
  return (
    <Card className="gap-2 py-3">
      <CardHeader className="px-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">#{row.number}</span>
          <button className="truncate text-left hover:underline" onClick={() => navigate(`/prs/${row.number}`)}>{row.title}</button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-1 px-3">
        <ConditionBadges row={row} />
      </CardContent>
      <CardFooter className="px-3">
        <PrActions row={row} />
      </CardFooter>
    </Card>
  );
}
