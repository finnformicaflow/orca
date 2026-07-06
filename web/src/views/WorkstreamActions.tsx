import { useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import {
  addPreviewLabel, baseBranch, discardDraft, ensureWorktree, fixCi, followUp, markReady, merge, promote,
  rerunAgent, resolveConflicts, sendSlack, staleHours, type Row,
} from "../store";
import { attachCommand, canMerge, shouldBump } from "../workstream";
import { ActionButton } from "@/components/ActionButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// One organised action menu for every actionable workstream (open PR or local branch). Actions are
// grouped: lifecycle ops (promote / mark ready / merge / preview) at top, then an Agent submenu
// (Claude-driven work + Copy CLI) and a Slack submenu. Keeps the card header uncluttered — the
// contextual state lives in badges, so the menu doesn't need per-item spinners.
export function WorkstreamActions({ row, hasWork = true }: { row: Row; hasWork?: boolean }) {
  const [composing, setComposing] = useState(false);

  const isPr = Boolean(row.prNumber);
  const isLocalLane = row.lane === "LOCAL";
  const isMergeable = row.lane === "MERGEABLE";
  const conflicting = row.mergeable === "CONFLICTING" || row.mergeClean === "conflict";
  const ciFailing = row.ciStatus === "failing";
  const notified = Boolean(row.slackNotifiedAt);
  const bumpDue = shouldBump(row.slackNotifiedAt, row.slackLastBumpedAt, Date.now(), staleHours());
  const mergeReady = canMerge({ state: "OPEN", mergeable: row.mergeable ?? "UNKNOWN", ciStatus: row.ciStatus ?? "none", reviewStatus: row.reviewStatus ?? "none" });

  const copyCli = async () => {
    const cmd = attachCommand({ worktreePath: row.worktreePath ?? (await ensureWorktree(row)), sessionId: row.sessionId });
    try { await navigator.clipboard.writeText(cmd); } catch { window.prompt("Copy the CLI command:", cmd); }
  };
  const mergeConfirm = isPr
    ? `Merge PR #${row.prNumber} "${row.title}" into ${baseBranch(row.repo)}? This can't be undone.`
    : `Merge ${row.branch} into ${baseBranch(row.repo)} locally? This can't be undone.`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setComposing((v) => !v)}>Follow up</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">Actions <ChevronDown className="size-3.5" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem]">
            {/* Lifecycle */}
            {row.isDraft && <DropdownMenuItem onSelect={() => void markReady(row)}>Mark ready for review</DropdownMenuItem>}
            {isLocalLane && (row.hasRemote
              ? <PromoteSubmenu row={row} disabled={!hasWork} />
              : <DropdownMenuItem disabled={!hasWork} onSelect={() => void promote(row)}>Promote</DropdownMenuItem>)}
            {isMergeable && (
              <DropdownMenuItem disabled={isPr && !mergeReady} onSelect={() => { if (window.confirm(mergeConfirm)) void merge(row); }}>
                Merge{isPr && !mergeReady ? " (not ready)" : ""}
              </DropdownMenuItem>
            )}
            {isPr && !row.previewUrl && <DropdownMenuItem onSelect={() => void addPreviewLabel(row)}>Add preview</DropdownMenuItem>}

            <DropdownMenuSeparator />

            {/* Agent */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Agent</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {!isPr && row.worktreePath && row.agentStatus !== "running" && <DropdownMenuItem onSelect={() => void rerunAgent(row)}>Run</DropdownMenuItem>}
                {conflicting && <DropdownMenuItem onSelect={() => void resolveConflicts(row)}>Resolve conflicts</DropdownMenuItem>}
                {isPr && ciFailing && <DropdownMenuItem onSelect={() => void fixCi(row)}>Fix CI</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => void copyCli()}>Copy CLI</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Slack — only meaningful once there's a PR to link */}
            {isPr && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Slack</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={() => void sendSlack(row, "notify")}>Notify{notified ? " again" : ""}</DropdownMenuItem>
                  <DropdownMenuItem disabled={!notified} onSelect={() => void sendSlack(row, "bump")}>Bump{bumpDue ? " (due)" : ""}</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            {/* Discard — never deletes a branch that has an open PR (only pre-PR locals) */}
            {!isPr && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => { if (window.confirm(`Discard "${row.title}" (${row.branch})? Removes the worktree and branch.`)) void discardDraft(row); }}
                >
                  Discard
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {row.agentStatus === "running" && <Badge variant="secondary">claude working…</Badge>}
        {row.agentStatus === "error" && <Badge variant="destructive" title={row.agentError}>claude error</Badge>}
      </div>
      {composing && <FollowUpComposer row={row} onDone={() => setComposing(false)} />}
    </div>
  );
}

// Promote a local branch into a PR — choose ready/draft and optionally set the preview label.
function PromoteSubmenu({ row, disabled }: { row: Row; disabled?: boolean }) {
  const [label, setLabel] = useState(false);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>Promote to PR</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuLabel>Promote to PR</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={label} onCheckedChange={(c) => setLabel(Boolean(c))} onSelect={(e) => e.preventDefault()}>
          Add preview label
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void promote(row, { draft: false, addPreviewLabel: label })}>Create PR (ready)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void promote(row, { draft: true, addPreviewLabel: label })}>Create draft PR</DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function FollowUpComposer({ row, onDone }: { row: Row; onDone: () => void }) {
  const [text, setText] = useState("");
  const sendRef = useRef<HTMLSpanElement>(null);
  // ⌘/Ctrl+Enter submits by clicking Send — reuses its spinner/✓/✗ and disabled-when-empty guard.
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendRef.current?.querySelector("button")?.click(); }
  };
  return (
    <div className="space-y-1">
      <Textarea rows={2} placeholder="Follow-up for the agent (resumes its session)…  (⌘+Enter)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      <div className="flex gap-1">
        <span ref={sendRef}>
          <ActionButton variant="default" disabled={!text.trim()} onRun={async () => { await followUp(row, text.trim()); onDone(); }}>Send</ActionButton>
        </span>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
