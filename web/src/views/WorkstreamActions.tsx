import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, GitMerge, Loader2, MessageSquarePlus, MoreVertical, Sparkles, X } from "lucide-react";
import {
  addPreviewLabel, addressPr, autoMerge, baseBranch, closePr, convertToDraft, discardDraft, ensureWorktree, followUp, instanceChoices, markReady, mergeWhenGreen, moveWorkstream, previewConfigured, thisInstance,
  cliCommand, disableAutoMerge, merge, modelFor, promote, rename, resolveConflicts, sendSlack, setCardModel, staleHours, suggestTitle, toggleFollow, useRepos, type Row,
} from "../store";
import { firstLine, prMenuActions, prPreviewState, shouldBump } from "../workstream";
import { actionFailed } from "@/lib/notificationStore";
import { ChatComposer } from "@/components/ChatComposer";
import { clearDraft, hasDraft } from "@/lib/composerDraft";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/ModelPicker";
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

// `compact` renders the toolbar as icon-only buttons (dense view); `leading` slots an extra control
// (the dense Test-locally icon) into the front of that same row so the whole toolbar reads as one line.
// `menuOnly` is the Agents list's trailing ⋯: no toolbar, Follow up and Merge move INTO the menu, so
// every verb is still one click away. `onFollowUp` replaces the inline composer there (the agent's
// page has the conversation); without it the menu's Follow up opens the composer as the button does.
// `contextAt` (menuOnly) opens the SAME items as a right-click menu at that point — a second,
// controlled root over the one items fragment, so the two menus can't drift; `onOpen` adds Open.
export function WorkstreamActions({ row, hasWork = true, onBusy, compact = false, leading, menuOnly = false, onFollowUp, onOpen, contextAt, onContextClose }: {
  row: Row; hasWork?: boolean; onBusy?: (busy: boolean) => void; compact?: boolean; leading?: ReactNode; menuOnly?: boolean; onFollowUp?: () => void;
  onOpen?: () => void; contextAt?: { x: number; y: number } | null; onContextClose?: () => void;
}) {
  // Reopen the follow-up box on reload if a draft was left in progress, so nothing typed is lost.
  const [composing, setComposing] = useState(() => hasDraft(followUpDraftKey(row)));
  const [renaming, setRenaming] = useState(false);
  // The follow-up submit is optimistic — the box closes instantly while the launch (ensureWorktree +
  // upload + claude) runs for a few seconds. Show a spinner on the Follow up button meanwhile, so the
  // work isn't invisible.
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Wrap every action so it (a) surfaces errors — menu items are fire-and-forget, so a failed
  // promote/merge would otherwise vanish silently — as a failed-action notification (lib/notificationStore: the message, Copy,
  // Ask the orchestrator), never as text in the row, where it broke the Agents list's layout; the ⋯
  // keeps only a ✗ with the first line as its tooltip; and (b) reports busy up to the card, which
  // shows a loading overlay (actions like promote push + open a PR and take a few seconds).
  const fail = (action: string, e: unknown) => {
    setErr(e instanceof Error ? e.message : String(e));
    actionFailed({ action, title: row.title, repo: row.repo, branch: row.branch, prNumber: row.prNumber }, e);
  };
  const run = (action: string, fn: () => Promise<unknown>) => async () => {
    setErr(null); onBusy?.(true);
    try { await fn(); }
    catch (e) { fail(action, e); }
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
    const command = await cliCommand(row);
    try { await navigator.clipboard.writeText(command); } catch { window.prompt("Copy the CLI command:", command); }
  };
  const copyLink = async () => {
    if (!row.prUrl) return;
    try { await navigator.clipboard.writeText(row.prUrl); } catch { window.prompt("Copy the PR link:", row.prUrl); }
  };
  const copyBranch = async () => {
    try { await navigator.clipboard.writeText(row.branch); } catch { window.prompt("Copy the branch:", row.branch); }
  };
  const prActions = prMenuActions(row);
  const prPreview = prPreviewState(row, previewConfigured(row.repo));
  const mergeConfirm = isPr
    ? `Merge PR #${row.prNumber} "${row.title}" into ${baseBranch(row.repo)}? This can't be undone.`
    : `Merge ${row.branch} into ${baseBranch(row.repo)} locally? This can't be undone.`;

  // Icon-only in compact (dense) view; labelled otherwise. `icon` keeps every toolbar button a
  // consistent square so the row lines up regardless of which verbs are present.
  const icon = compact ? "icon" : "sm";
  const iconClass = compact ? "size-7" : undefined;
  const mergeLabel = `Merge${unreviewed ? " (unreviewed)" : ""}`;
  const items = (
    <>
      {menuOnly && (
        <>
          {onOpen && <DropdownMenuItem onSelect={onOpen}>Open</DropdownMenuItem>}
          {row.prUrl && <DropdownMenuItem onSelect={() => window.open(row.prUrl, "_blank", "noreferrer")}>Open PR #{row.prNumber}</DropdownMenuItem>}
          <DropdownMenuItem onSelect={run("Copy branch", copyBranch)}>Copy branch</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={submitting} onSelect={() => (onFollowUp ? onFollowUp() : setComposing(true))}>Follow up…</DropdownMenuItem>
          {row.lane === "MERGEABLE" && <DropdownMenuItem onSelect={() => { if (window.confirm(mergeConfirm)) run("Merge", () => merge(row))(); }}>{mergeLabel}</DropdownMenuItem>}
          <DropdownMenuSeparator />
        </>
      )}
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
        : <DropdownMenuItem disabled={!hasWork} onSelect={run("Promote", () => promote(row))}>Promote</DropdownMenuItem>)}
      {canMergeNow && row.lane !== "MERGEABLE" && (
        <DropdownMenuItem onSelect={() => { if (window.confirm(mergeConfirm)) run("Merge", () => merge(row))(); }}>
          Merge{unreviewed ? " (unreviewed)" : ""}
        </DropdownMenuItem>
      )}
      {/* Rename — fix a broken/auto title. AI suggests a name (editable); a PR renames on GitHub. */}
      <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename…</DropdownMenuItem>
      {/* Move the worktree to another instance (verbs.moveWorkstream). Not while its agent runs. */}
      {row.worktreePath && instanceChoices().filter((i) => i !== (row.instance ?? thisInstance())).map((to) => (
        <DropdownMenuItem key={to} disabled={row.agentStatus === "running"} onSelect={run(`Move to ${to}`, () => moveWorkstream(row, to))} title={row.agentStatus === "running" ? "Wait for the agent to finish first" : `Push the branch and re-open its worktree on ${to}; the next run starts a fresh session there`}>
          Move to {to}
        </DropdownMenuItem>
      ))}

      {/* PR — every action that needs an open PR, in one place (workstream.prMenuActions) */}
      {isPr && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>PR</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {prActions.includes("markReady") && <DropdownMenuItem onSelect={run("Mark ready", () => markReady(row))}>Mark ready for review</DropdownMenuItem>}
            {prActions.includes("moveToDraft") && <DropdownMenuItem onSelect={run("Move to draft", () => convertToDraft(row))}>Move to draft</DropdownMenuItem>}
            {prActions.includes("autoMerge") && (row.autoMergeEnabled
              ? <DropdownMenuItem onSelect={run("Disable auto-merge", () => disableAutoMerge(row))}>Disable auto-merge</DropdownMenuItem>
              : <DropdownMenuItem onSelect={run("Enable auto-merge", () => autoMerge(row))}>Enable auto-merge</DropdownMenuItem>)}
            {prActions.includes("autoMerge") && <DropdownMenuItem onSelect={run("Merge when green", () => mergeWhenGreen(row))} title="Orca squash-merges it once checks pass and it merges clean, under this repo's merge policy">Merge when green</DropdownMenuItem>}
            {/* One agent verb: conflicts, CI and review in a single run (store.addressPr). */}
            {prActions.includes("addressPr") && <DropdownMenuItem onSelect={run("Address PR", () => addressPr(row))} title="One run that resolves conflicts, fixes CI and addresses review threads/comments — whichever apply">Address PR</DropdownMenuItem>}
            {prPreview === "ready" && <DropdownMenuItem onSelect={() => window.open(row.previewUrl, "_blank", "noreferrer")}>Open PR preview</DropdownMenuItem>}
            {prPreview === "pending" && <DropdownMenuItem disabled>Deploying preview…</DropdownMenuItem>}
            {prPreview === "add" && <DropdownMenuItem onSelect={run("Add preview", () => addPreviewLabel(row))}>Add PR preview</DropdownMenuItem>}
            {prActions.includes("copyLink") && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={run("Copy link", copyLink)}>Copy link</DropdownMenuItem></>}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}

      <DropdownMenuSeparator />

      {/* Agent — provider-neutral work; resolve conflicts lives here only for a local branch (no PR) */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Agent</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {!isPr && conflicting && <DropdownMenuItem onSelect={run("Resolve conflicts", () => resolveConflicts(row))}>Resolve conflicts</DropdownMenuItem>}
          {/* Local only — see the card's copy menu. */}
          {!row.remote && <DropdownMenuItem onSelect={run("Copy CLI", copyCli)}>Copy CLI</DropdownMenuItem>}
          <DropdownMenuItem onSelect={run("Copy worktree", copyWorktree)}>Copy worktree</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      {/* Slack — only meaningful once there's a PR to link */}
      {isPr && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Slack</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={run("Slack message", () => sendSlack(row, "notify"))}>Send message{notified ? " again" : ""}</DropdownMenuItem>
            <DropdownMenuItem disabled={!notified} onSelect={run("Slack bump", () => sendSlack(row, "bump"))}>Send bump{bumpDue ? " (due)" : ""}</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}

      {/* Close/Discard — Close PR abandons an open PR (+cleanup); Discard only for pre-PR locals */}
      <DropdownMenuSeparator />
      {isPr ? (
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => { if (window.confirm(`Close PR #${row.prNumber} "${row.title}" without merging? Removes the worktree and local branch.`)) run("Close PR", () => closePr(row))(); }}
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
    </>
  );
  return (
    // `flex flex-col gap-2`, not `space-y-2`: a margin-based gap still reserves space for a
    // `display:none` sibling (the closed RenameDialog, or the TerminalDialog above this component),
    // which inflated this wrapper past the toolbar's own height and threw off the Actions cell's
    // vertical centering on every row. `gap` only spaces boxes the layout actually generates.
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!menuOnly && leading}
        {!menuOnly && <Button size={icon} className={iconClass} variant="soft" disabled={submitting || row.agentStatus === "running"} onClick={() => setComposing((v) => !v)} title="Follow up" aria-label="Follow up">
          {compact
            ? (submitting ? <Loader2 className="size-4 animate-spin" /> : <MessageSquarePlus className="size-3.5" />)
            : <>{submitting && <Loader2 className="size-4 animate-spin" />}Follow up</>}
        </Button>}
        {!menuOnly && row.lane === "MERGEABLE" && (
          <Button size={icon} className={iconClass} variant="success" onClick={() => { if (window.confirm(mergeConfirm)) run("Merge", () => merge(row))(); }} title={mergeLabel} aria-label={mergeLabel}>
            {compact ? <GitMerge className="size-3.5" /> : mergeLabel}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size={icon} className={iconClass} variant="ghost" title={err ? firstLine(err) : "Actions"} aria-label="Actions" data-state-error={err ? "" : undefined}>
              {err && <X className="text-destructive size-3.5" />}
              {compact ? (!err && <MoreVertical className="size-4" />) : <>Actions <ChevronDown className="size-3.5" /></>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={menuOnly ? "end" : "start"} className="min-w-[12rem]">
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
        {menuOnly && contextAt && (
          // Right-click: the same items, anchored to a zero-size trigger at the pointer. Radix gives it
          // the menu's keyboard handling (arrows, Enter, Esc) and closes it on an outside click.
          <DropdownMenu key={`${contextAt.x},${contextAt.y}`} open onOpenChange={(o) => { if (!o) onContextClose?.(); }}>
            <DropdownMenuTrigger asChild>
              <span data-slot="context-anchor" aria-hidden="true" tabIndex={-1} style={{ position: "fixed", left: contextAt.x, top: contextAt.y, width: 0, height: 0 }} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={0} data-slot="row-context-menu" aria-label={`Actions for ${row.title}`} className="min-w-[12rem]"
              onCloseAutoFocus={(e) => e.preventDefault()}>
              {items}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <RenameDialog row={row} open={renaming} onClose={() => setRenaming(false)} />
      {composing && (
        <FollowUpComposer
          row={row}
          onClose={() => setComposing(false)}
          // Launch failed: reopen with the (still-persisted) prompt and surface why.
          onFail={(msg) => { fail("Follow up", new Error(msg)); setComposing(true); }}
          onSubmitting={setSubmitting}
        />
      )}
    </div>
  );
}

// Rename a card. The name field is editable but "Suggest" fills it with an AI-generated title — the
// primary path when an auto-title came out broken. Saving edits the GitHub PR title for a PR (its title
// IS the card's) and always records it in enrichment. Native <dialog> for the backdrop/ESC/focus-trap.
function RenameDialog({ row, open, onClose }: { row: Row; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(row.title);
  const [busy, setBusy] = useState<null | "suggest" | "save">(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setTitle(row.title); setErr(null); d.showModal(); } // seed with the current title each open
    else if (!open && d.open) d.close();
  }, [open, row.title]);

  const suggest = async () => {
    setBusy("suggest"); setErr(null);
    try { setTitle(await suggestTitle(row)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const save = async () => {
    const next = title.trim();
    if (!next) return;
    setBusy("save"); setErr(null);
    try { await rename(row, next); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }} // backdrop click → close
      className="bg-card text-foreground m-auto w-[28rem] max-w-[90vw] rounded-lg border p-0 shadow-modal backdrop:bg-black/50"
    >
      <form className="flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="text-sm font-medium">Rename {row.prNumber ? `PR #${row.prNumber}` : "card"}</div>
        <input
          autoFocus
          aria-label="Card title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Card title"
          className="bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
        />
        {row.prNumber ? <p className="text-muted-foreground text-xs">Updates the GitHub PR title.</p> : null}
        {err && <p className="text-destructive text-xs break-words">{err}</p>}
        <div className="flex items-center justify-between gap-2">
          <Button type="button" size="sm" variant="soft" disabled={Boolean(busy)} onClick={suggest} title="Let the agent name it">
            {busy === "suggest" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-3.5" />} Suggest
          </Button>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={Boolean(busy) || !title.trim()}>
              {busy === "save" && <Loader2 className="size-4 animate-spin" />} Save
            </Button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

// Promote a local branch into a PR — choose ready/draft and toggle the repo's configured PR labels
// (config `prLabels`; entries with `default: true` start checked). Repos with none show no toggles.
function PromoteSubmenu({ row, disabled, run }: { row: Row; disabled?: boolean; run: (action: string, fn: () => Promise<unknown>) => () => void }) {
  const prLabels = useRepos().find((r) => r.name === row.repo)?.prLabels ?? [];
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(prLabels.map((l) => [l.name, l.default ?? false])));
  const labels = prLabels.filter((l) => checked[l.name]).map((l) => l.name);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>Promote to PR</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuLabel>Promote to PR</DropdownMenuLabel>
        {prLabels.map((l) => (
          <DropdownMenuCheckboxItem key={l.name} checked={checked[l.name] ?? false}
            onCheckedChange={(c) => setChecked((s) => ({ ...s, [l.name]: Boolean(c) }))} onSelect={(e) => e.preventDefault()}>
            {l.name}
          </DropdownMenuCheckboxItem>
        ))}
        {prLabels.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={run("Create PR", () => promote(row, { draft: false, labels }))}>Create PR (ready)</DropdownMenuItem>
        <DropdownMenuItem onSelect={run("Create draft PR", () => promote(row, { draft: true, labels }))}>Create draft PR</DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function FollowUpComposer(
  { row, onClose, onFail, onSubmitting }: { row: Row; onClose: () => void; onFail: (msg: string) => void; onSubmitting: (busy: boolean) => void },
) {
  const key = followUpDraftKey(row);
  // The composer's picker IS the card's pin — one persisted choice, surfaced here and on the card
  // header. Changing it re-pins the card, so every later action (Address PR, …) runs on it too; the
  // send below resolves the same pin, so no local mirror state to drift.
  return (
    <ChatComposer
      autoFocus
      optimistic
      persistKey={key}
      repo={row.repo}
      // ↑/↓ from an empty box recall past follow-ups sent on this branch — resend the last one after
      // an error without retyping. Kept in enrichment (row.followUps) until the branch ends.
      history={row.followUps}
      placeholder="Continue this work…"
      leading={
        <div className="flex min-w-0 w-full items-center overflow-hidden">
          <ModelPicker label="Model" value={modelFor(row)} ran={row.agentMeta?.model} onChange={(m) => setCardModel(row, m)} className="max-w-full" />
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
        try { await followUp(row, instruction, images); clearDraft(key); }
        catch (e) { onFail(e instanceof Error ? e.message : String(e)); }
        finally { onSubmitting(false); }
      }}
      onCancel={onClose}
    />
  );
}
