import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRightLeft, ArrowUpRight, BellRing, Bot, Check, CheckCheck, ChevronDown, Copy, ExternalLink, FolderOpen, GitMerge, GitPullRequestArrow, GitPullRequestDraft, Globe,
  Link, Loader2, MessageSquarePlus, MoreVertical, Package, Pencil, Send, Sparkles, SquareTerminal, Tag, Trash2, Wrench, X, XCircle, Zap, type LucideIcon,
} from "lucide-react";
import {
  addPreviewLabel, addressPr, autoMerge, baseBranch, closePr, convertToDraft, discardDraft, ensureWorktree, followUp, instanceChoices, markReady, moveWorkstream, previewConfigured, thisInstance,
  cliCommand, disableAutoMerge, merge, modelFor, promote, rename, resolveConflicts, sendSlack, setCardModel, slackChannel, staleHours, suggestTitle, toggleFollow, useCachedReviewDigest, useRepos, useReviewDigest, type Row,
} from "../store";
import { firstLine, handoffDraftPath, prMenuActions, prPreviewState, quickActions, reviewProblems, shouldBump, type QuickActionId } from "../workstream";
import { reviewSig } from "./Review";
import { ActionButton } from "@/components/ActionButton";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import { actionFailed } from "@/lib/notificationStore";
import { confirmDialog, copyText, type ConfirmOptions } from "@/lib/dialogs";
import { ChatComposer } from "@/components/ChatComposer";
import { clearDraft, hasDraft } from "@/lib/composerDraft";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/ModelPicker";
import { BottomSheet } from "@/components/BottomSheet";
import { useNarrow } from "@/lib/viewport";
import { navigate } from "@/lib/route";
import { Input } from "@/components/ui/input";
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

// The icon a quick action wears (every quick action is icon-only, its label the tooltip).
const QUICK_ICONS: Record<QuickActionId, LucideIcon> = {
  createPr: GitPullRequestArrow, markReady: CheckCheck, addressPr: Wrench, slack: Send, merge: GitMerge, autoMerge: Zap, disableAutoMerge: Zap,
};

// The menu's parts. On a desktop they are the Radix menu's own items (the ⋯ dropdown and the
// right-click menu); on a phone the SAME fragment renders as a bottom sheet's large touch rows, each
// with its icon — one list, so the dropdown and the sheet can't drift. A submenu becomes a labelled
// group in the sheet (a disabled one a disabled fieldset). `SheetMenu` carries the sheet's close.
const SheetMenu = createContext<(() => void) | null>(null);
type Select = (e: Event) => void;
const SHEET_ROW = "active:bg-accent flex min-h-12 w-full items-center gap-3 rounded-md px-2 text-left text-[15px] outline-none select-none focus-visible:bg-accent disabled:opacity-50";

function Item({ icon: Icon, onSelect, disabled, className, children }: { icon?: LucideIcon; onSelect?: Select; disabled?: boolean; className?: string; children: ReactNode }) {
  const close = useContext(SheetMenu);
  if (!close) return <DropdownMenuItem onSelect={onSelect} disabled={disabled} className={className}>{children}</DropdownMenuItem>;
  return (
    <button type="button" role="menuitem" data-slot="sheet-item" disabled={disabled} className={cn(SHEET_ROW, className)}
      onClick={() => { const e = new Event("select", { cancelable: true }); onSelect?.(e); if (!e.defaultPrevented) close(); }}>
      {Icon && <Icon className="text-muted-foreground size-5 shrink-0" />}<span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function CheckItem({ icon: Icon, checked, onCheckedChange, onSelect, children }: { icon?: LucideIcon; checked: boolean; onCheckedChange: (c: boolean) => void; onSelect?: Select; children: ReactNode }) {
  const close = useContext(SheetMenu);
  if (!close) return <DropdownMenuCheckboxItem checked={checked} onCheckedChange={onCheckedChange} onSelect={onSelect}>{children}</DropdownMenuCheckboxItem>;
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} data-slot="sheet-item" className={SHEET_ROW}
      onClick={() => { const e = new Event("select", { cancelable: true }); onCheckedChange(!checked); onSelect?.(e); if (!e.defaultPrevented) close(); }}>
      {Icon && <Icon className="text-muted-foreground size-5 shrink-0" />}<span className="min-w-0 flex-1">{children}</span>
      {checked && <Check className="size-5 shrink-0" />}
    </button>
  );
}

function Sub({ label, disabled, children }: { label: string; disabled?: boolean; children: ReactNode }) {
  const close = useContext(SheetMenu);
  if (!close) return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  return (
    <fieldset role="group" aria-label={label} disabled={disabled} className="m-0 min-w-0 border-0 p-0">
      <div aria-hidden="true" className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">{label}</div>
      {children}
    </fieldset>
  );
}

function Label({ children }: { children: ReactNode }) {
  return useContext(SheetMenu) ? null : <DropdownMenuLabel>{children}</DropdownMenuLabel>; // the sheet's group already says it
}

function Sep() {
  return useContext(SheetMenu) ? <div role="separator" className="bg-border -mx-2 my-1 h-px" /> : <DropdownMenuSeparator />;
}

// Merge asks first everywhere it is offered (the menus and the quick action): it can't be undone.
const mergeConfirm = (row: Row): ConfirmOptions => ({
  title: row.prNumber ? `Merge PR #${row.prNumber}?` : `Merge ${row.branch}?`,
  description: row.prNumber
    ? `Merge "${row.title}" into ${baseBranch(row.repo)}. You cannot undo this.`
    : `Merge ${row.branch} into ${baseBranch(row.repo)} locally. You cannot undo this.`,
  confirmLabel: "Merge",
});

// `compact` renders the toolbar as icon-only buttons (dense view). The toolbar opens with the
// state-aware quick actions (QuickActionButtons) and then `leading` — the Test / Preview control — so
// the quick icons always sit immediately left of it; `quick={false}` leaves them to the caller (the
// comfortable Board card puts them on its preview line). `menuOnly` is the Agents list's trailing ⋯:
// no toolbar, Follow up and Merge move INTO the menu, so every verb is still one click away (the row
// renders its quick icons itself, left of its preview cell). `onFollowUp` replaces the inline composer there (the agent's
// page has the conversation); without it the menu's Follow up opens the composer as the button does.
// `contextAt` (menuOnly) opens the SAME items as a right-click menu at that point — a second,
// controlled root over the one items fragment, so the two menus can't drift; `onOpen` adds Open.
export function WorkstreamActions({ row, hasWork = true, onBusy, compact = false, leading, quick = true, tipSide, menuOnly = false, onFollowUp, onOpen, contextAt, onContextClose }: {
  row: Row; hasWork?: boolean; onBusy?: (busy: boolean) => void; compact?: boolean; leading?: ReactNode; quick?: boolean; tipSide?: "top" | "bottom"; menuOnly?: boolean; onFollowUp?: () => void;
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
  const repoInfo = useRepos().find((r) => r.name === row.repo);

  // Copy shortcuts adopt a missing worktree first. Copy CLI intentionally lives both here and in
  // the card's top-right copy menu: this submenu is discoverable while the icon is faster.
  const copyWorktree = async () => {
    const path = row.worktreePath ?? (await ensureWorktree(row));
    await copyText(path, "worktree path");
  };
  const copyCli = async () => {
    const command = await cliCommand(row);
    await copyText(command, "CLI command");
  };
  const copyLink = async () => {
    if (!row.prUrl) return;
    await copyText(row.prUrl, "PR link");
  };
  const copyBranch = async () => {
    await copyText(row.branch, "branch");
  };
  const prActions = prMenuActions(row);
  const prPreview = prPreviewState(row, previewConfigured(row.repo));
  const confirmMerge = async () => { if (await confirmDialog(mergeConfirm(row))) await run("Merge", () => merge(row))(); };

  // Icon-only in compact (dense) view; labelled otherwise. `icon` keeps every toolbar button a
  // consistent square so the row lines up regardless of which verbs are present.
  const icon = compact ? "icon" : "sm";
  const iconClass = compact ? "size-7" : undefined;
  const mergeLabel = `Merge${unreviewed ? " (unreviewed)" : ""}`;
  const narrow = useNarrow();
  const [sheetOpen, setSheetOpen] = useState(false);
  const trigger = (onClick?: () => void) => (
    <Button size={icon} className={iconClass} variant="ghost" aria-label="Actions" data-state-error={err ? "" : undefined}
      {...(onClick && { onClick, "aria-haspopup": "menu" as const, "aria-expanded": sheetOpen })}>
      {err && <X className="text-destructive size-3.5" />}
      {compact ? (!err && <MoreVertical className="size-4" />) : <>Actions <ChevronDown className="size-3.5" /></>}
    </Button>
  );
  const items = (
    <>
      {menuOnly && (
        <>
          {onOpen && <Item icon={ArrowUpRight} onSelect={onOpen}>Open</Item>}
          {row.prUrl && <Item icon={ExternalLink} onSelect={() => window.open(row.prUrl, "_blank", "noreferrer")}>Open PR #{row.prNumber}</Item>}
          <Item icon={Copy} onSelect={run("Copy branch", copyBranch)}>Copy branch</Item>
          <Sep />
          <Item icon={MessageSquarePlus} disabled={submitting} onSelect={() => (onFollowUp ? onFollowUp() : setComposing(true))}>Follow up…</Item>
          {row.lane === "MERGEABLE" && <Item icon={GitMerge} onSelect={() => void confirmMerge()}>{mergeLabel}</Item>}
          <Sep />
        </>
      )}
      {/* Follow: put the card on autopilot — Orca watches the PR and fires the agent to resolve
          conflicts / fix CI / address review comments as they appear. */}
      {isPr && (
        <>
          <CheckItem icon={Bot} checked={Boolean(row.following)} onCheckedChange={() => toggleFollow(row)} onSelect={(e) => e.preventDefault()}>
            Follow PR (auto-fix)
          </CheckItem>
          <Sep />
        </>
      )}
      {/* Lifecycle: promote a local branch, or merge from a lane where Merge isn't already a header button */}
      {isLocalLane && (row.hasRemote
        ? <PromoteSubmenu row={row} disabled={!hasWork} run={run} />
        : <Item icon={GitPullRequestArrow} disabled={!hasWork} onSelect={run("Promote", () => promote(row))}>Promote</Item>)}
      {canMergeNow && row.lane !== "MERGEABLE" && (
        <Item icon={GitMerge} onSelect={() => void confirmMerge()}>
          Merge{unreviewed ? " (unreviewed)" : ""}
        </Item>
      )}
      {/* Rename — fix a broken/auto title. AI suggests a name (editable); a PR renames on GitHub. */}
      <Item icon={Pencil} onSelect={() => setRenaming(true)}>Rename…</Item>
      {/* Pack this chat for another Orca server (the Handoffs page; nothing is sent until Send). */}
      <Item icon={Package} onSelect={() => navigate(handoffDraftPath(row))}>Hand off…</Item>
      {/* Move the worktree to another instance (verbs.moveWorkstream). Not while its agent runs. */}
      {row.worktreePath && instanceChoices().filter((i) => i !== (row.instance ?? thisInstance())).map((to) => {
        const moveItem = <Item icon={ArrowRightLeft} key={to} disabled={row.agentStatus === "running"} onSelect={run(`Move to ${to}`, () => moveWorkstream(row, to))}>Move to {to}</Item>;
        return row.agentStatus === "running" ? <Tip key={to} label="Wait for the agent to finish first">{moveItem}</Tip> : moveItem;
      })}

      {/* PR — every action that needs an open PR, in one place (workstream.prMenuActions) */}
      {isPr && (
        <Sub label="PR">
            {prActions.includes("markReady") && <Item icon={CheckCheck} onSelect={run("Mark ready", () => markReady(row))}>Mark ready for review</Item>}
            {prActions.includes("moveToDraft") && <Item icon={GitPullRequestDraft} onSelect={run("Move to draft", () => convertToDraft(row))}>Move to draft</Item>}
            {prActions.includes("autoMerge") && (row.autoMergeEnabled
              ? <Item icon={Zap} onSelect={run("Disable auto-merge", () => disableAutoMerge(row))}>Disable auto-merge</Item>
              : <Item icon={Zap} onSelect={run("Enable auto-merge", () => autoMerge(row))}>Enable auto-merge</Item>)}
            {/* One agent verb: conflicts, CI and review in a single run (store.addressPr). */}
            {prActions.includes("addressPr") && <Item icon={Wrench} onSelect={run("Address PR", () => addressPr(row))}>Address PR</Item>}
            {prPreview === "ready" && <Item icon={Globe} onSelect={() => window.open(row.previewUrl, "_blank", "noreferrer")}>Open PR preview</Item>}
            {prPreview === "pending" && <Item icon={Globe} disabled>Deploying preview…</Item>}
            {prPreview === "add" && <Item icon={Globe} onSelect={run("Add preview", () => addPreviewLabel(row))}>Add PR preview</Item>}
            {prActions.includes("copyLink") && <><Sep /><Item icon={Link} onSelect={run("Copy link", copyLink)}>Copy link</Item></>}
          </Sub>
      )}

      <Sep />

      {/* Agent — provider-neutral work; resolve conflicts lives here only for a local branch (no PR) */}
      <Sub label="Agent">
          {!isPr && conflicting && <Item icon={Wrench} onSelect={run("Resolve conflicts", () => resolveConflicts(row))}>Resolve conflicts</Item>}
          {/* Local only — see the card's copy menu. */}
          {!row.remote && <Item icon={SquareTerminal} onSelect={run("Copy CLI", copyCli)}>Copy CLI</Item>}
          <Item icon={FolderOpen} onSelect={run("Copy worktree", copyWorktree)}>Copy worktree</Item>
        </Sub>

      {/* Slack — only meaningful once there's a PR to link */}
      {isPr && (
        <Sub label="Slack">
            <Item icon={Send} onSelect={run("Slack message", () => sendSlack(row, "notify"))}>Send message{notified ? " again" : ""}</Item>
            <Item icon={BellRing} disabled={!notified} onSelect={run("Slack bump", () => sendSlack(row, "bump"))}>Send bump{bumpDue ? " (due)" : ""}</Item>
          </Sub>
      )}

      {/* Close/Discard — Close PR abandons an open PR (+cleanup); Discard only for pre-PR locals */}
      <Sep />
      {isPr ? (
        <Item icon={XCircle}
          className="text-destructive focus:text-destructive"
          onSelect={() => void (async () => {
            if (await confirmDialog({ title: `Close PR #${row.prNumber}?`, description: `Close "${row.title}" without a merge. This removes the worktree and the local branch.`, confirmLabel: "Close PR", destructive: true })) await run("Close PR", () => closePr(row))();
          })()}
        >
          Close PR
        </Item>
      ) : (
        <Item icon={Trash2}
          className="text-destructive focus:text-destructive"
          onSelect={() => void (async () => {
            if (await confirmDialog({ title: `Discard "${row.title}"?`, description: `This removes the worktree and the branch ${row.branch}. You cannot undo this.`, confirmLabel: "Discard", destructive: true })) await discardDraft(row);
          })()}
        >
          Discard
        </Item>
      )}
    </>
  );
  return (
    // `flex flex-col gap-2`, not `space-y-2`: a margin-based gap still reserves space for a
    // `display:none` sibling (the closed RenameDialog, or the TerminalDialog above this component),
    // which inflated this wrapper past the toolbar's own height and threw off the Actions cell's
    // vertical centering on every row. `gap` only spaces boxes the layout actually generates.
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {!menuOnly && quick && <QuickActionButtons row={row} hasWork={hasWork} onBusy={onBusy} tipSide={tipSide} />}
        {!menuOnly && leading}
        {!menuOnly && <Button size={icon} className={iconClass} variant="soft" disabled={submitting || row.agentStatus === "running"} onClick={() => setComposing((v) => !v)} aria-label="Follow up">
          {compact
            ? (submitting ? <Loader2 className="size-4 animate-spin" /> : <MessageSquarePlus className="size-3.5" />)
            : <>{submitting && <Loader2 className="size-4 animate-spin" />}Follow up</>}
        </Button>}
        {narrow ? (
          // A phone: the ⋯ opens the items as a bottom sheet — on a tap only, never a long-press.
          <>
            {err ? <Tip label={firstLine(err)}>{trigger(() => setSheetOpen(true))}</Tip> : trigger(() => setSheetOpen(true))}
            <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={row.title} slot="actions-sheet">
              <SheetMenu.Provider value={() => setSheetOpen(false)}>
                <div role="menu" aria-label={`Actions for ${row.title}`} className="-mx-2 -my-2 flex flex-col">{items}</div>
              </SheetMenu.Provider>
            </BottomSheet>
          </>
        ) : (
          <DropdownMenu>
            {err ? <Tip label={firstLine(err)}><DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger></Tip> : <DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>}
            <DropdownMenuContent align={menuOnly ? "end" : "start"} className="min-w-[12rem]">
              {items}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {menuOnly && contextAt && !narrow && (
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
        <Input
          autoFocus
          aria-label="Card title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Card title"
          className="bg-background h-9 px-3"
        />
        {row.prNumber ? <p className="text-muted-foreground text-xs">Updates the GitHub PR title.</p> : null}
        {err && <p className="text-destructive text-xs break-words">{err}</p>}
        <div className="flex items-center justify-between gap-2">
          <Button type="button" size="sm" variant="soft" disabled={Boolean(busy)} onClick={suggest}>
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
    <Sub label="Promote to PR" disabled={disabled}>
      <Label>Promote to PR</Label>
      {prLabels.map((l) => (
        <CheckItem icon={Tag} key={l.name} checked={checked[l.name] ?? false}
          onCheckedChange={(c) => setChecked((s) => ({ ...s, [l.name]: Boolean(c) }))} onSelect={(e) => e.preventDefault()}>
          {l.name}
        </CheckItem>
      ))}
      {prLabels.length > 0 && <Sep />}
      <Item icon={GitPullRequestArrow} onSelect={run("Create PR", () => promote(row, { draft: false, labels }))}>Create PR (ready)</Item>
      <Item icon={GitPullRequestDraft} onSelect={run("Create draft PR", () => promote(row, { draft: true, labels }))}>Create draft PR</Item>
    </Sub>
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
      // ↑/↓ recall past follow-ups sent on this branch — resend the last one after an error without
      // retyping. Kept in enrichment (row.followUps, oldest first) until the branch ends.
      history={[...new Set([...(row.followUps ?? [])].reverse())]}
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

/** The workstream's state-aware quick actions (workstream.quickActions — the ONE mapping the header,
 *  the Board card and the Agents rows share) as icon-only ghost buttons, each with its tooltip: the
 *  notification quick actions' style (size-7, first in the foreground colour, the rest muted; spinner
 *  → ✓/✗; a failure is an action-failed notification). Each runs the existing store verb its ⋯ menu
 *  item runs. A disabled one says why in its tooltip. Below md only the first two show. `peek` reads
 *  the review digest only if it is already cached (an Agents row: never one fetch per row); without
 *  it, the actions are decided on what the row itself knows. Clicks never reach an enclosing row. */
export function QuickActionButtons({ row, hasWork = true, onBusy, peek = false, tipSide = "top", className }: {
  row: Row; hasWork?: boolean; onBusy?: (busy: boolean) => void; peek?: boolean; tipSide?: "top" | "bottom"; className?: string;
}) {
  const repoInfo = useRepos().find((r) => r.name === row.repo);
  const fetched = useReviewDigest(row.repo, peek ? undefined : row.prNumber, reviewSig(row));
  const cached = useCachedReviewDigest(row.repo, peek ? row.prNumber : undefined);
  const digest = peek ? cached : fetched;
  const actions = quickActions(row, {
    hasWork, reviewProblems: digest && reviewProblems(digest), slackChannel: Boolean(slackChannel(row.repo)),
  });
  if (!actions.length) return null;
  const defaultLabels = (repoInfo?.prLabels ?? []).filter((l) => l.default).map((l) => l.name);
  const verb = (id: QuickActionId, slackKind?: "notify" | "bump"): (() => Promise<unknown>) => {
    switch (id) {
      case "createPr": return () => (row.hasRemote ? promote(row, { draft: false, labels: defaultLabels }) : promote(row));
      case "markReady": return () => markReady(row);
      case "addressPr": return () => addressPr(row);
      case "slack": return () => sendSlack(row, slackKind ?? "notify");
      case "merge": return () => merge(row);
      case "autoMerge": return () => autoMerge(row);
      case "disableAutoMerge": return () => disableAutoMerge(row);
    }
  };
  return (
    <div data-slot="quick-actions" className={cn("flex items-center gap-1", className)} onClick={(e) => e.stopPropagation()}>
      {actions.map((a, i) => {
        const Icon = QUICK_ICONS[a.id];
        const run = verb(a.id, a.slackKind);
        return (
          <Tip key={a.id} label={a.disabled ?? a.tip ?? a.label} side={tipSide} className={i >= 2 ? "max-md:hidden" : undefined}>
            <span data-quick-action={a.id} className="inline-flex">
              <ActionButton size="icon" variant="ghost" label={a.label} disabled={Boolean(a.disabled)}
                className={cn("size-7", i === 0 ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                confirm={a.id === "merge" ? mergeConfirm(row) : undefined}
                failure={{ action: a.label, title: row.title, repo: row.repo, branch: row.branch, prNumber: row.prNumber }}
                onRun={async () => { onBusy?.(true); try { await run(); } finally { onBusy?.(false); } }}>
                {/* Auto-merge already on: a filled bolt, so the state reads at a glance. */}
                <Icon className={cn("size-3.5", a.on && "fill-current text-purple-700 dark:text-purple-400")} />
              </ActionButton>
            </span>
          </Tip>
        );
      })}
    </div>
  );
}
