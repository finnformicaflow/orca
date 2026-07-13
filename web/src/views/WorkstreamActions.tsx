import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  addPreviewLabel, addressReview, autoMerge, baseBranch, closePr, convertToDraft, discardDraft, ensureWorktree, fixCi, followUp, markReady,
  merge, promote, resolveConflicts, sendSlack, staleHours, toggleFollow, useAgentProviders, type Row,
} from "../store";
import { attachCommand, prMenuActions, shouldBump } from "../workstream";
import { ChatComposer } from "@/components/ChatComposer";
import { clearDraft, hasDraft } from "@/lib/composerDraft";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentLabel, type AgentProvider } from "../../../shared/agent";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// One organised action menu for every actionable workstream (open PR or local branch). Actions are
// grouped: promote/merge at top, then a PR submenu (every PR-scoped action — draft toggle, resolve
// conflicts, fix CI, add preview, copy link — see workstream.prMenuActions), an Agent submenu
// (provider-neutral agent work + worktree/CLI copy shortcuts)
// and a Slack submenu. Keeps the card header uncluttered — the
// contextual state lives in badges, so the menu doesn't need per-item spinners.
// localStorage key for a row's in-progress follow-up draft; whether one exists also drives
// whether the composer auto-reopens after a reload (see FollowUpComposer).
const followUpDraftKey = (row: Row) => `orca.followup.${row.repo}::${row.branch}`;

export function WorkstreamActions({ row, hasWork = true, onBusy }: { row: Row; hasWork?: boolean; onBusy?: (busy: boolean) => void }) {
  // Reopen the follow-up box on reload if a draft was left in progress, so nothing typed is lost.
  const [composing, setComposing] = useState(() => hasDraft(followUpDraftKey(row)));
  // The follow-up submit is optimistic — the box closes instantly while the launch (ensureWorktree +
  // upload + claude) runs for a few seconds. Show a spinner on the Follow up button meanwhile, so the
  // work isn't invisible.
  const [submitting, setSubmitting] = useState(false);
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

  // Copy shortcuts adopt a missing worktree first. Copy CLI intentionally lives both here and in
  // the card's top-right copy menu: this submenu is discoverable while the icon is faster.
  const copyWorktree = async () => {
    const path = row.worktreePath ?? (await ensureWorktree(row));
    try { await navigator.clipboard.writeText(path); } catch { window.prompt("Copy the worktree path:", path); }
  };
  const copyCli = async () => {
    const path = row.worktreePath ?? (await ensureWorktree(row));
    const command = attachCommand({ worktreePath: path, provider: row.agentProvider, sessionId: row.sessionId });
    try { await navigator.clipboard.writeText(command); } catch { window.prompt("Copy the CLI command:", command); }
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
        <Button size="sm" variant="soft" disabled={submitting || row.agentStatus === "running"} onClick={() => setComposing((v) => !v)}>
          {submitting && <Loader2 className="size-4 animate-spin" />}Follow up
        </Button>
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
            {/* Follow: put the card on autopilot — Orca watches the PR and fires the agent to resolve
                conflicts / fix CI / address review comments as they appear. */}
            {isPr && (
              <>
                <DropdownMenuCheckboxItem checked={Boolean(row.following)} onCheckedChange={() => toggleFollow(row)} onSelect={(e) => e.preventDefault()}
                  title="Autopilot: every ~8s Orca checks this PR and launches the agent to resolve conflicts, fix failing CI, and address new review comments as they land — no click needed.">
                  Follow PR (auto-fix)
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
              </>
            )}
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
                  {prActions.includes("autoMerge") && <DropdownMenuItem onSelect={run(() => autoMerge(row))}>Enable auto-merge</DropdownMenuItem>}
                  {prActions.includes("resolveConflicts") && <DropdownMenuItem onSelect={run(() => resolveConflicts(row))}>Resolve conflicts</DropdownMenuItem>}
                  {prActions.includes("fixCi") && <DropdownMenuItem onSelect={run(() => fixCi(row))}>Fix CI</DropdownMenuItem>}
                  {prActions.includes("addressReview") && <DropdownMenuItem onSelect={run(() => addressReview(row))}>Address review</DropdownMenuItem>}
                  {prActions.includes("addPreview") && <DropdownMenuItem onSelect={run(() => addPreviewLabel(row))}>Add preview</DropdownMenuItem>}
                  {prActions.includes("copyLink") && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={run(copyLink)}>Copy link</DropdownMenuItem></>}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            <DropdownMenuSeparator />

            {/* Agent — provider-neutral work; resolve conflicts lives here only for a local branch (no PR) */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Agent</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {!isPr && conflicting && <DropdownMenuItem onSelect={run(() => resolveConflicts(row))}>Resolve conflicts</DropdownMenuItem>}
                <DropdownMenuItem onSelect={run(copyCli)}>Copy CLI</DropdownMenuItem>
                <DropdownMenuItem onSelect={run(copyWorktree)}>Copy worktree</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Slack — only meaningful once there's a PR to link */}
            {isPr && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Slack</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={run(() => sendSlack(row, "notify"))}>Copy message{notified ? " again" : ""}</DropdownMenuItem>
                  <DropdownMenuItem disabled={!notified} onSelect={run(() => sendSlack(row, "bump"))}>Copy bump{bumpDue ? " (due)" : ""}</DropdownMenuItem>
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
      {composing && (
        <FollowUpComposer
          row={row}
          onClose={() => setComposing(false)}
          // Launch failed: reopen with the (still-persisted) prompt and surface why.
          onFail={(msg) => { setErr(msg); setComposing(true); }}
          onSubmitting={setSubmitting}
        />
      )}
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

export function FollowUpComposer(
  { row, onClose, onFail, onSubmitting }: { row: Row; onClose: () => void; onFail: (msg: string) => void; onSubmitting: (busy: boolean) => void },
) {
  const key = followUpDraftKey(row);
  const providers = useAgentProviders();
  const [provider, setProvider] = useState<AgentProvider>(row.agentProvider ?? providers[0] ?? "claude");
  useEffect(() => { if (providers.length && !providers.includes(provider)) setProvider(providers[0]!); }, [providers, provider]);
  // A card can receive a newer provider while it is mounted (poll completes, or another run starts).
  // Follow-ups inherit that active provider; a manual choice after opening remains untouched.
  useEffect(() => {
    if (row.agentProvider && providers.includes(row.agentProvider)) setProvider(row.agentProvider);
  }, [row.agentProvider, providers]);
  return (
    <ChatComposer
      autoFocus
      optimistic
      persistKey={key}
      // ↑/↓ from an empty box recall past follow-ups sent on this branch — resend the last one after
      // an error without retyping. Kept in enrichment (row.followUps) until the branch ends.
      history={row.followUps}
      placeholder="Continue this work…  (⌘+Enter)"
      leading={
        <div className="flex min-w-0 w-full items-center overflow-hidden">
          <Select value={provider} onValueChange={(v) => setProvider(v as AgentProvider)}>
            <SelectTrigger size="sm" aria-label="Agent provider" className="text-muted-foreground hover:bg-accent min-w-0 max-w-full border-0 shadow-none focus-visible:ring-0"><SelectValue /></SelectTrigger>
            <SelectContent>
              {providers.map((p) => <SelectItem key={p} value={p}>{agentLabel(p)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      }
      // Optimistic submit: close the box the instant you send (launching the agent takes a few
      // seconds — ensureWorktree + upload). The draft stays persisted, so a failed launch reopens
      // it with the same prompt; a success drops it. `onSubmitting` drives the Follow up button's
      // spinner for the duration, so the in-flight launch isn't invisible after the box closes.
      onSubmit={async (instruction, images) => {
        onClose();
        onSubmitting(true);
        // followUp records the sent prompt in enrichment before it can fail, so the local draft is
        // safe to drop as soon as the send is handed off (a failed launch reopens the box from it).
        try { await followUp(row, instruction, images, { provider }); clearDraft(key); }
        catch (e) { onFail(e instanceof Error ? e.message : String(e)); }
        finally { onSubmitting(false); }
      }}
      onCancel={onClose}
    />
  );
}
