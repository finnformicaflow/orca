import { useState } from "react";
import { baseBranch, fixCi, merge, resolveConflicts, sendSlack, staleHours, type PrRow } from "../store";
import { canMerge, shouldBump } from "../workstream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PreviewControl } from "./PreviewControl";

/** PR action bar — every button launches Claude to actually perform the task. */
export function PrActions({ row }: { row: PrRow }) {
  const notified = Boolean(row.slackNotifiedAt);
  const bumpDue = shouldBump(row.slackNotifiedAt, row.slackLastBumpedAt, Date.now(), staleHours());
  const conflicted = row.mergeable === "CONFLICTING";
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doMerge = async () => {
    if (!confirm(`Merge PR #${row.number} "${row.title}" into ${baseBranch()}? This can't be undone.`)) return;
    setMerging(true);
    setError(null);
    try {
      await merge(row.number, row.worktreePath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {!notified ? (
        <Button size="sm" variant="outline" onClick={() => void sendSlack(row, "notify")}>Notify Slack</Button>
      ) : (
        <Button size="sm" variant={bumpDue ? "default" : "outline"} onClick={() => void sendSlack(row, "bump")}>Bump Slack</Button>
      )}
      {conflicted && row.worktreePath && (
        <Button size="sm" variant="outline" onClick={() => void resolveConflicts(row)}>Resolve conflicts</Button>
      )}
      {row.ciStatus === "failing" && row.worktreePath && (
        <Button size="sm" variant="outline" onClick={() => void fixCi(row)}>Fix CI</Button>
      )}
      {row.worktreePath && <PreviewControl branch={row.branch} worktreePath={row.worktreePath} />}
      {row.kanbanState === "MERGEABLE" && (
        <Button size="sm" disabled={merging || !canMerge(row)} onClick={() => void doMerge()}>
          {merging ? "Merging…" : "Merge"}
        </Button>
      )}
      {row.agentStatus === "running" && <Badge variant="secondary">claude working…</Badge>}
      {row.agentStatus === "error" && <Badge variant="destructive">claude error</Badge>}
      {error && <span className="text-destructive w-full text-xs">{error}</span>}
    </div>
  );
}
