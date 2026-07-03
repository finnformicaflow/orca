import { useState } from "react";
import { addPreviewLabel, baseBranch, fixCi, followUp, markReady, merge, resolveConflicts, sendSlack, staleHours, type Row } from "../store";
import { canMerge, shouldBump } from "../workstream";
import { ActionButton } from "@/components/ActionButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** PR action bar — every button launches Claude (or a gh op) with inline ✓/✗ feedback. */
export function PrActions({ row }: { row: Row }) {
  const notified = Boolean(row.slackNotifiedAt);
  const bumpDue = shouldBump(row.slackNotifiedAt, row.slackLastBumpedAt, Date.now(), staleHours());
  const mergeable = { state: "OPEN", mergeable: row.mergeable ?? "UNKNOWN", ciStatus: row.ciStatus ?? "none", reviewStatus: row.reviewStatus ?? "none" };
  const [composing, setComposing] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {row.isDraft && <ActionButton onRun={() => markReady(row)}>Mark ready</ActionButton>}
        {!notified ? (
          <ActionButton onRun={() => sendSlack(row, "notify")}>Notify Slack</ActionButton>
        ) : (
          <ActionButton variant={bumpDue ? "default" : "outline"} onRun={() => sendSlack(row, "bump")}>Bump Slack</ActionButton>
        )}
        {row.worktreePath && <Button size="sm" variant="outline" onClick={() => setComposing((v) => !v)}>Follow up</Button>}
        {row.mergeable === "CONFLICTING" && row.worktreePath && <ActionButton onRun={() => resolveConflicts(row)}>Resolve conflicts</ActionButton>}
        {row.ciStatus === "failing" && row.worktreePath && <ActionButton onRun={() => fixCi(row)}>Fix CI</ActionButton>}
        {!row.previewUrl && <ActionButton onRun={() => addPreviewLabel(row)}>Add preview</ActionButton>}
        {row.lane === "MERGEABLE" && (
          <ActionButton variant="default" disabled={!canMerge(mergeable)} confirm={`Merge PR #${row.prNumber} "${row.title}" into ${baseBranch(row.repo)}? This can't be undone.`} onRun={() => merge(row)}>Merge</ActionButton>
        )}
        {row.agentStatus === "running" && <Badge variant="secondary">claude working…</Badge>}
        {row.agentStatus === "error" && <Badge variant="destructive">claude error</Badge>}
      </div>
      {composing && <FollowUpComposer row={row} onDone={() => setComposing(false)} />}
    </div>
  );
}

export function FollowUpComposer({ row, onDone }: { row: Row; onDone: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="space-y-1">
      <Textarea rows={2} placeholder="Follow-up for the agent (resumes its session)…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-1">
        <ActionButton variant="default" disabled={!text.trim()} onRun={async () => { await followUp(row, text.trim()); onDone(); }}>Send</ActionButton>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
