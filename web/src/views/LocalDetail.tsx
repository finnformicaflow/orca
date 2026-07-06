import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { ChangeSummary } from "../../../server/git";
import { api } from "../api";
import { baseBranch, summary as fetchSummary, useWorkstreams } from "../store";
import { navigate, type LocalTab } from "@/lib/route";
import { AgentBadge } from "./Board";
import { DiffView } from "./PrDetail";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewPanel } from "./PreviewControl";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Detail view for a local session (a worktree + its agent, pre-PR). Mirrors PrDetail's shape:
// Overview (prompt, agent result, commits), Files changed (branch-vs-base diff), Preview.
export function LocalDetail({ repo, branch, sub }: { repo: string; branch: string; sub: LocalTab }) {
  const row = useWorkstreams().find((r) => r.repo === repo && r.branch === branch && !r.mergedAt);
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const wt = row?.worktreePath;

  useEffect(() => {
    if (!wt) { setSummary(null); return; }
    const reload = () => void fetchSummary(repo, wt).then(setSummary).catch(() => {});
    reload();
    const t = setInterval(reload, 5000); // keep commits/size fresh while the agent works
    return () => clearInterval(t);
  }, [repo, wt]);

  useEffect(() => {
    if (sub === "files" && wt && diff === null) api.localDiff(repo, wt).then((d) => setDiff(d.diff)).catch(() => setDiff(""));
  }, [sub, repo, wt, diff]);

  const go = (t: LocalTab) => navigate(`/${repo}/local/${encodeURIComponent(branch)}${t === "overview" ? "" : `/${t}`}`);
  const back = `/${repo}`;

  if (!row) return <div className="space-y-4"><Back to={back} /><p className="text-muted-foreground text-sm">No local session for <code>{branch}</code>.</p></div>;

  const hasWork = (summary?.commits.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <Back to={back} />
      <div className="space-y-2">
        <div className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{repo}</div>
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          {row.title}
          <AgentBadge row={row} hasWork={hasWork} />
        </h2>
        <p className="text-muted-foreground text-sm">
          <code>{branch}</code> → <code>{baseBranch(repo)}</code>
          {summary && <> · +{summary.additions}/−{summary.deletions} across {summary.files.length} files</>}
        </p>
        <WorkstreamActions row={row} hasWork={hasWork} />
      </div>

      <Tabs value={sub} onValueChange={(v) => go(v as LocalTab)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="files">Files changed{summary ? ` (${summary.files.length})` : ""}</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 pt-3">
          {row.prompt && <Section title="Prompt"><p className="text-sm whitespace-pre-wrap">{row.prompt}</p></Section>}
          {row.agentResult && <Section title="Agent result"><p className="text-sm whitespace-pre-wrap">{row.agentResult}</p></Section>}
          {row.agentError && <p className="text-destructive text-sm whitespace-pre-wrap">{row.agentError}</p>}
          <Section title={`Commits (${summary?.commits.length ?? 0})`}>
            {summary && summary.commits.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {summary.commits.map((c) => (
                  <li key={c.hash} className="flex gap-2"><code className="text-muted-foreground shrink-0">{c.hash.slice(0, 7)}</code><span className="truncate">{c.subject}</span></li>
                ))}
              </ul>
            ) : <p className="text-muted-foreground text-sm">No commits yet.</p>}
          </Section>
        </TabsContent>

        <TabsContent value="files" className="space-y-3 pt-3">
          {!wt ? <p className="text-muted-foreground text-sm">No worktree checked out.</p>
            : diff === null ? <p className="text-muted-foreground text-sm">Loading diff…</p>
            : <DiffView text={diff} />}
        </TabsContent>

        <TabsContent value="preview">
          <PreviewPanel row={row} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const Back = ({ to }: { to: string }) => <Button variant="ghost" size="sm" onClick={() => navigate(to)}><ArrowLeft /> Back to board</Button>;

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <h3 className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">{title}</h3>
    {children}
  </div>
);
