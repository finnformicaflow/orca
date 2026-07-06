import { useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import {
  addPreviewLabel, baseBranch, discardDraft, ensureWorktree, fixCi, followUp, markReady, merge, promote,
  rerunAgent, resolveConflicts, sendSlack, staleHours, type Row,
} from "../store";
import { attachCommand, shouldBump } from "../workstream";
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
  const [err, setErr] = useState<string | null>(null);
  // Menu items are fire-and-forget, so without this a failed promote/merge/etc. would vanish
  // silently (e.g. "promote did nothing" when the branch couldn't be pushed). Surface it.
  const run = (fn: () => Promise<unknown>) => () => { setErr(null); void fn().catch((e) => setErr(e instanceof Error ? e.message : String(e))); };

  const isPr = Boolean(row.prNumber);
  const isLocalLane = row.lane === "LOCAL";
  const conflicting = row.mergeable === "CONFLICTING" || row.mergeClean === "conflict";
  const ciFailing = row.ciStatus === "failing";
  const notified = Boolean(row.slackNotifiedAt);
  const bumpDue = shouldBump(row.slackNotifiedAt, row.slackLastBumpedAt, Date.now(), staleHours());
  // Offer Merge whenever it's actually mergeable — for a PR that means no conflicts + CI not failing
  // (approval is a team norm GitHub enforces, and you can't approve your own PR); for a local branch
  // it's the promoted+clean Mergeable lane.
  const canMergeNow = isPr ? (!row.isDraft && row.mergeable === "MERGEABLE" && !ciFailing) : row.lane === "MERGEABLE";
  const unreviewed = isPr && row.reviewStatus !== "approved";
  // A local session that isn't currently running can be (re)launched. First-class so a "stopped"
  // session always has an obvious way to run again, not buried in the Agent submenu.
  const canRun = !isPr && Boolean(row.worktreePath) && row.agentStatus !== "running";

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
        {canRun && <Button size="sm" variant="outline" onClick={run(() => rerunAgent(row))}>Run</Button>}
        <Button size="sm" variant="outline" onClick={() => setComposing((v) => !v)}>Follow up</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">Actions <ChevronDown className="size-3.5" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem]">
            {/* Lifecycle */}
            {row.isDraft && <DropdownMenuItem onSelect={run(() => markReady(row))}>Mark ready for review</DropdownMenuItem>}
            {isLocalLane && (row.hasRemote
              ? <PromoteSubmenu row={row} disabled={!hasWork} run={run} />
              : <DropdownMenuItem disabled={!hasWork} onSelect={run(() => promote(row))}>Promote</DropdownMenuItem>)}
            {canMergeNow && (
              <DropdownMenuItem onSelect={() => { if (window.confirm(mergeConfirm)) run(() => merge(row))(); }}>
                Merge{unreviewed ? " (unreviewed)" : ""}
              </DropdownMenuItem>
            )}
            {isPr && !row.previewUrl && <DropdownMenuItem onSelect={run(() => addPreviewLabel(row))}>Add preview</DropdownMenuItem>}

            <DropdownMenuSeparator />

            {/* Agent */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Agent</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {conflicting && <DropdownMenuItem onSelect={run(() => resolveConflicts(row))}>Resolve conflicts</DropdownMenuItem>}
                {isPr && ciFailing && <DropdownMenuItem onSelect={run(() => fixCi(row))}>Fix CI</DropdownMenuItem>}
                <DropdownMenuItem onSelect={run(copyCli)}>Copy CLI</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Slack — only meaningful once there's a PR to link */}
            {isPr && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Slack</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={run(() => sendSlack(row, "notify"))}>Notify{notified ? " again" : ""}</DropdownMenuItem>
                  <DropdownMenuItem disabled={!notified} onSelect={run(() => sendSlack(row, "bump"))}>Bump{bumpDue ? " (due)" : ""}</DropdownMenuItem>
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
      {err && <p className="text-destructive text-xs break-words">{err}</p>}
      {composing && <FollowUpComposer row={row} onDone={() => setComposing(false)} />}
    </div>
  );
}

// Promote a local branch into a PR — choose ready/draft and optionally set the preview label.
function PromoteSubmenu({ row, disabled, run }: { row: Row; disabled?: boolean; run: (fn: () => Promise<unknown>) => () => void }) {
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
        <DropdownMenuItem onSelect={run(() => promote(row, { draft: false, addPreviewLabel: label }))}>Create PR (ready)</DropdownMenuItem>
        <DropdownMenuItem onSelect={run(() => promote(row, { draft: true, addPreviewLabel: label }))}>Create draft PR</DropdownMenuItem>
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
