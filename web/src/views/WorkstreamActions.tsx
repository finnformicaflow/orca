import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  addPreviewLabel, baseBranch, closePr, convertToDraft, discardDraft, ensureWorktree, fixCi, followUp, markReady,
  merge, promote, resolveConflicts, sendSlack, staleHours, type Row,
} from "../store";
import { attachCommand, prMenuActions, shouldBump } from "../workstream";
import { ChatComposer } from "@/components/ChatComposer";
import { hasDraft } from "@/lib/composerDraft";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// One organised action menu for every actionable workstream (open PR or local branch). Actions are
// grouped: promote/merge at top, then a PR submenu (every PR-scoped action — draft toggle, resolve
// conflicts, fix CI, add preview, copy link — see workstream.prMenuActions), an Agent submenu
// (Claude-driven work + Copy CLI) and a Slack submenu. Keeps the card header uncluttered — the
// contextual state lives in badges, so the menu doesn't need per-item spinners.
// localStorage key for a row's in-progress follow-up draft; whether one exists also drives
// whether the composer auto-reopens after a reload (see FollowUpComposer).
const followUpDraftKey = (row: Row) => `orca.followup.${row.repo}::${row.branch}`;

export function WorkstreamActions({ row, hasWork = true, onBusy }: { row: Row; hasWork?: boolean; onBusy?: (busy: boolean) => void }) {
  // Reopen the follow-up box on reload if a draft was left in progress, so nothing typed is lost.
  const [composing, setComposing] = useState(() => hasDraft(followUpDraftKey(row)));
  const [err, setErr] = useState<string | null>(null);
  // Wrap every action so it (a) surfaces errors — menu items are fire-and-forget, so a failed
  // promote/merge would otherwise vanish silently — and (b) reports busy up to the card, which
  // shows a loading overlay (actions like promote push + open a PR and take a few seconds).
  const run = (fn: () => Promise<unknown>) => async () => {
    setErr(null); onBusy?.(true);
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { onBusy?.(false); }
  };

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

  const copyCli = async () => {
    const cmd = attachCommand({ worktreePath: row.worktreePath ?? (await ensureWorktree(row)), sessionId: row.sessionId });
    try { await navigator.clipboard.writeText(cmd); } catch { window.prompt("Copy the CLI command:", cmd); }
  };
  const copyLink = async () => {
    if (!row.prUrl) return;
    try { await navigator.clipboard.writeText(row.prUrl); } catch { window.prompt("Copy the PR link:", row.prUrl); }
  };
  const prActions = prMenuActions(row);
  const mergeConfirm = isPr
    ? `Merge PR #${row.prNumber} "${row.title}" into ${baseBranch(row.repo)}? This can't be undone.`
    : `Merge ${row.branch} into ${baseBranch(row.repo)} locally? This can't be undone.`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="soft" onClick={() => setComposing((v) => !v)}>Follow up</Button>
        {/* Second-class, lane-contextual action right after Follow up. */}
        {row.lane === "IN_REVIEW" && (
          <Button size="sm" variant={bumpDue ? "default" : "outline"} onClick={run(() => sendSlack(row, notified ? "bump" : "notify"))}>
            {notified ? "Bump Slack" : "Notify Slack"}
          </Button>
        )}
        {row.lane === "MERGEABLE" && (
          <Button size="sm" variant="success" onClick={() => { if (window.confirm(mergeConfirm)) run(() => merge(row))(); }}>
            Merge{unreviewed ? " (unreviewed)" : ""}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">Actions <ChevronDown className="size-3.5" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem]">
            {/* Lifecycle: promote a local branch, or merge from a lane where Merge isn't already a header button */}
            {isLocalLane && (row.hasRemote
              ? <PromoteSubmenu row={row} disabled={!hasWork} run={run} />
              : <DropdownMenuItem disabled={!hasWork} onSelect={run(() => promote(row))}>Promote</DropdownMenuItem>)}
            {canMergeNow && row.lane !== "MERGEABLE" && (
              <DropdownMenuItem onSelect={() => { if (window.confirm(mergeConfirm)) run(() => merge(row))(); }}>
                Merge{unreviewed ? " (unreviewed)" : ""}
              </DropdownMenuItem>
            )}

            {/* PR — every action that needs an open PR, in one place (workstream.prMenuActions) */}
            {isPr && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>PR</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {prActions.includes("markReady") && <DropdownMenuItem onSelect={run(() => markReady(row))}>Mark ready for review</DropdownMenuItem>}
                  {prActions.includes("moveToDraft") && <DropdownMenuItem onSelect={run(() => convertToDraft(row))}>Move to draft</DropdownMenuItem>}
                  {prActions.includes("resolveConflicts") && <DropdownMenuItem onSelect={run(() => resolveConflicts(row))}>Resolve conflicts</DropdownMenuItem>}
                  {prActions.includes("fixCi") && <DropdownMenuItem onSelect={run(() => fixCi(row))}>Fix CI</DropdownMenuItem>}
                  {prActions.includes("addPreview") && <DropdownMenuItem onSelect={run(() => addPreviewLabel(row))}>Add preview</DropdownMenuItem>}
                  {prActions.includes("copyLink") && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={run(copyLink)}>Copy link</DropdownMenuItem></>}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            <DropdownMenuSeparator />

            {/* Agent — Claude-driven work; resolve conflicts lives here only for a local branch (no PR) */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Agent</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {!isPr && conflicting && <DropdownMenuItem onSelect={run(() => resolveConflicts(row))}>Resolve conflicts</DropdownMenuItem>}
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

            {/* Close/Discard — Close PR abandons an open PR (+cleanup); Discard only for pre-PR locals */}
            <DropdownMenuSeparator />
            {isPr ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => { if (window.confirm(`Close PR #${row.prNumber} "${row.title}" without merging? Removes the worktree and local branch.`)) run(() => closePr(row))(); }}
              >
                Close PR
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => { if (window.confirm(`Discard "${row.title}" (${row.branch})? Removes the worktree and branch.`)) void discardDraft(row); }}
              >
                Discard
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
  return (
    <ChatComposer
      autoFocus
      persistKey={followUpDraftKey(row)}
      placeholder="Follow-up for the agent (resumes its session)…  (⌘+Enter)"
      onSubmit={async (instruction, images) => { await followUp(row, instruction, images); onDone(); }}
      onCancel={onDone}
    />
  );
}
