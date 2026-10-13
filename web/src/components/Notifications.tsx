// The notification centre's two surfaces, in Geist: the toast stack bottom-left, growing up from
// just above the bell, and the bell at the sidebar's foot that opens the centre — a popover listing
// every notification by day. The stack copies branch-demo's inbox toasts (sonner's bottom-left
// stack: collapsed cards that spread on hover, slide-in / drop-out, swipe to dismiss, the count bar
// with Mark all as read, auto-hide paused while you look) with CSS transitions instead of the
// dependency, and is restyled flat: hairlines, 8px cards, the menu shadow only, black/white primary,
// blue accent. A notification is unread or read, and nothing is deleted from here: the ×, a swipe, a
// quick action or opening it marks it read (out of the stack, out of the centre's default Unread
// view, still under All). Every toast and centre row carries quick actions on hover (always, on a
// touch screen) as icon buttons with tooltips: its kind's one or two (Address PR, Fix, Reply, Retry,
// …; a failed action's Ask the orchestrator and Copy), then Open, always last — chosen by the pure `notificationActions` (workstream.ts), run by the
// store's existing verbs. A button you clicked that failed is one more kind (`action_failed`, a
// local row the store raises in this browser), so it shares the stack, the card and the centre. The decisions (what pops,
// what persists, the stack's layout and motion) are pure in shared/notifications.ts; the state is
// lib/notificationStore.ts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import {
  AlertTriangle, ArrowUpRight, Bell, BellOff, Bot, Check, CheckCheck, CircleAlert, CircleX, Copy, ExternalLink, FileText, GitPullRequest, GitPullRequestArrow, GitMerge, Hammer, MessageCircleQuestion,
  MessagesSquare, MonitorCheck, MonitorX, OctagonPause, Reply, RotateCcw, ScrollText, ShieldX, Square, Wrench, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { navigate } from "@/lib/route";
import { notifyDndAtom } from "@/lib/atoms";
import { markRead, pauseToasts, resumeToasts, restoreUnread, start, useNotifications } from "@/lib/notificationStore";
import { oneOf, persistedKey, usePersisted } from "@/lib/persisted";
import { useCoarse, useNarrow } from "@/lib/viewport";
import {
  COUNT_BAR_HEIGHT, COUNT_BAR_SPACE, filterNotifications, groupByDay, KIND_META, NOTIFICATION_FILTERS, notificationPath, stackAnchor, stackLayout, swipeAmount, swipeOut,
  TOAST_EXIT_MS, TOAST_WIDTH, toastMotion, toastStack, unreadCount, type Notification, type NotificationFilter, type NotificationKind, type StackAnchor, type SwipeDir, type ToastPlace,
} from "../../../shared/notifications";
import { addressPr, followUp, previewKeyOf, stopPreview, testLocally, useWorkstreams, type Row } from "../store";
import { ago, notificationActions, ORCHESTRATOR_REPO, RETRY_INSTRUCTION, type NotificationActionId, type NotificationActionSpec } from "../workstream";
import { autofixInstruction } from "../../../shared/agent";
import { ActionButton } from "@/components/ActionButton";
import { detailPath } from "@/views/Agents";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/console";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tip";
import { useOrchestrator } from "@/components/Terminal";
import type { ShortcutId } from "@/lib/shortcuts";

const ICON: Record<NotificationKind, typeof Bell> = {
  needs_input: MessageCircleQuestion, finished: Check, failed: CircleX, stopped: OctagonPause, check_failed: ShieldX,
  pr_ci_failed: AlertTriangle, pr_conflicts: GitPullRequestArrow, preview_ready: MonitorCheck, preview_failed: MonitorX, action_failed: CircleAlert,
  merged: GitMerge, merge_refused: GitPullRequest,
};
const TONE_TEXT = { ready: "text-geist-green", error: "text-geist-red", warning: "text-geist-warning-fg", queued: "text-geist-blue", neutral: "text-muted-foreground" } as const;

const KindIcon = ({ kind, className }: { kind: NotificationKind; className?: string }) => {
  const Icon = ICON[kind];
  return <Icon className={cn("size-4 shrink-0", TONE_TEXT[KIND_META[kind].tone], className)} aria-hidden="true" />;
};

/** A small muted tag before the title — which repo this is about. Left out for the orchestrator's
 *  own notifications (it has no repo behind it); truncated with ellipsis if the name runs long. */
const RepoLabel = ({ repo }: { repo: string }) =>
  repo && repo !== ORCHESTRATOR_REPO ? (
    <span data-slot="notification-repo" className="text-muted-foreground max-w-20 shrink-0 truncate text-xs" title={repo}>{repo}</span>
  ) : null;

/** Each quick action's icon (the label is its tooltip and aria-label); a shortcut where one exists. */
const ACTION_ICON: Record<NotificationActionId, typeof Bell> = {
  address: Wrench, viewPr: GitPullRequest, fix: Hammer, viewOutput: FileText, open: ArrowUpRight, reply: Reply, retry: RotateCcw,
  // openOrchestrator is exclusively the orchestrator's OWN notifications' Open action (see
  // notificationActions) — its icon is the orchestrator's own avatar everywhere else, not the panel
  // it opens.
  openChat: MessagesSquare, openPreview: ExternalLink, stopPreview: Square, retryPreview: RotateCcw, viewLog: ScrollText, openOrchestrator: Bot,
  ask: Bot, copy: Copy,
};

/** Copy a failed action's text; where the clipboard is refused (no secure context over the plain-http
 *  tailnet), a prompt with the text selected is the fallback. */
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch { window.prompt("Copy the error:", text); }
}

/** What a card says beside its title: the failed verb for a failed action ("Merge failed"), else
 *  the kind's own label. */
const labelOf = (n: Notification): string => n.label ?? KIND_META[n.kind].label;
const ACTION_SHORTCUT: Partial<Record<NotificationActionId, ShortcutId>> = { openOrchestrator: "orchestrator" };

/** Where a notification opens and what its quick actions do, resolved against the live rows (its
 *  PR page once it has a PR). Every handler is the store's own verb; nothing is re-implemented. */
function useNotificationActions() {
  const rows = useWorkstreams();
  const { ask: openOrchestrator } = useOrchestrator();
  const rowOf = (n: Notification): Row | undefined => rows.find((r) => r.repo === n.repo && r.branch === n.branch);
  const pathOf = (n: Notification, tail = ""): string | undefined => {
    const row = rowOf(n);
    const path = notificationPath(n, row ? detailPath(row) : undefined);
    return path && path + tail;
  };
  const go = (path: string | undefined) => { if (path) navigate(path); };
  /** The notification's own place: its workstream's Chat tab with the composer focused (the tab
   *  focuses it on mount; `?reply` as Reply sends) — the orchestrator's panel, composer focused, for
   *  its own wake. What the title and the Open action do. A preview's URL is its own action. */
  const openChatOf = (n: Notification) => go(pathOf(n, "/chat?reply=1"));
  const open = (n: Notification) => {
    void markRead([n.id]);
    if (n.link?.orchestrator) return void openOrchestrator();
    openChatOf(n);
  };
  const specs = (n: Notification): NotificationActionSpec[] => {
    const row = rowOf(n);
    return notificationActions(n, {
      row: Boolean(row), prUrl: Boolean(row?.prUrl), failedCheck: Boolean(row?.agentCheck && !row.agentCheck.ok),
      previewKey: Boolean(row && previewKeyOf(row)),
    });
  };
  /** An agent or preview verb: async, so it runs in an ActionButton (spinner → ✓/✗, the error toast). */
  const verb = (id: NotificationActionId, n: Notification): (() => Promise<unknown>) | undefined => {
    const row = rowOf(n);
    if (!row) return undefined;
    switch (id) {
      case "address": return () => addressPr(row);
      case "retry": return () => followUp(row, RETRY_INSTRUCTION);
      case "fix": return row.agentCheck ? () => followUp(row, autofixInstruction(row.agentCheck!)) : undefined;
      case "stopPreview": { const key = previewKeyOf(row); return key ? () => stopPreview(key) : undefined; }
      case "retryPreview": return () => testLocally(row);
      default: return undefined;
    }
  };
  /** A link: where it goes. */
  const link = (id: NotificationActionId, n: Notification): (() => void) | undefined => {
    switch (id) {
      case "open": case "reply": return () => openChatOf(n);
      case "openChat": case "viewOutput": return () => go(pathOf(n, "/chat"));
      case "viewLog": return () => go(pathOf(n, "/preview"));
      case "viewPr": { const url = rowOf(n)?.prUrl; return url ? () => void window.open(url, "_blank", "noopener") : undefined; }
      case "openPreview": return n.link?.url ? () => void window.open(n.link!.url, "_blank", "noopener") : undefined;
      case "openOrchestrator": return () => openOrchestrator();
      case "ask": return n.ask ? () => openOrchestrator(n.ask) : undefined;
      case "copy": return n.copy ? () => void copyText(n.copy!) : undefined;
      default: return undefined;
    }
  };
  return { open, specs, verb, link, rowOf };
}

/** A notification's quick-action row of size-7 ghost icon buttons, each with its tooltip: its kind's
 *  actions (the first primary, in the foreground colour), Open always last and — in the centre,
 *  while unread — the ×. Hidden until the card or row is hovered or focused, always shown on a touch
 *  screen. Every action is optimistic: the toast/row closes or marks read AT ONCE, the verb (or
 *  navigation) runs after — never waited on. A verb that fails shows a failed-action notification with why
 *  (as on the board) and, if the notification was unread, puts it back — the click shouldn't have to
 *  wait on a launch to know whether it worked. */
function QuickActions({ n, shown, onDismiss, className }: {
  n: Notification; shown: boolean; onDismiss?: () => void; className?: string;
}) {
  const actions = useNotificationActions();
  const row = actions.rowOf(n);
  const read = () => void markRead([n.id]);
  return (
    <div data-slot="notification-actions" data-shown={shown}
      className={cn("flex items-center gap-1 transition-opacity duration-150", !shown && "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100", className)}>
      {actions.specs(n).map((a) => {
        const Icon = ACTION_ICON[a.id];
        const btn = cn("size-7", a.primary ? "text-foreground" : "text-muted-foreground hover:text-foreground");
        const run = actions.verb(a.id, n);
        const go = run ? undefined : actions.link(a.id, n);
        if (!run && !go) return null;
        return (
          <Tip key={a.id} label={a.label} shortcut={ACTION_SHORTCUT[a.id]}>
            {run ? (
              <ActionButton size="icon" variant="ghost" className={btn} label={a.label}
                failure={{ action: a.label, title: n.title, repo: n.repo, branch: n.branch ?? "", prNumber: row?.prNumber }}
                onRun={async () => {
                  const wasUnread = !n.readAt;
                  read(); // close/mark-read at once; the verb runs in the background below
                  try {
                    await run();
                  } catch (e) {
                    if (wasUnread) restoreUnread([n.id]);
                    throw e;
                  }
                }}>
                <Icon className="size-3.5" />
              </ActionButton>
            ) : (
              <Button variant="ghost" size="icon" className={btn} aria-label={a.label} onClick={() => { read(); go!(); }}><Icon className="size-3.5" /></Button>
            )}
          </Tip>
        );
      })}
      {onDismiss && <Tip label="Mark as read"><Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground size-7" aria-label="Mark as read" onClick={onDismiss}><X className="size-3.5" /></Button></Tip>}
    </div>
  );
}

// ---- the toast stack ----

/** Where the stack sits, re-measured from the bell whenever the window or the sidebar's foot
 *  changes size (collapsing the sidebar moves the bell). */
function useStackAnchor(active: boolean): StackAnchor {
  const narrow = useNarrow();
  const measure = useCallback((): StackAnchor => {
    const rect = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)?.getBoundingClientRect();
    return stackAnchor(rect("notifications-bell"), rect("sidebar-foot"), { width: window.innerWidth, height: window.innerHeight }, narrow, rect("bottom-bar")?.height || undefined);
  }, [narrow]);
  const [anchor, setAnchor] = useState<StackAnchor>(measure);
  useLayoutEffect(() => {
    if (!active) return;
    const update = () => setAnchor((prev) => {
      const next = measure();
      return next.left === prev.left && next.bottom === prev.bottom && next.right === prev.right ? prev : next;
    });
    update();
    window.addEventListener("resize", update);
    const foot = document.querySelector('[data-slot="sidebar-foot"]');
    const ro = foot && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : undefined;
    if (foot) ro?.observe(foot);
    return () => { window.removeEventListener("resize", update); ro?.disconnect(); };
  }, [active, measure]);
  return anchor;
}

const useDocumentHidden = () => {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
};

type Gone = { n: Notification; place: ToastPlace };

/** Bottom-left, its foot just above the bell (full width above the bottom bar on a phone), so the
 *  orchestrator's window in the bottom-right corner never shares its corner. A failed action is
 *  one of these cards too (`action_failed`), not a stack of its own. Newest in front; three show, the rest wait (the bell has them all). Past one, the cards
 *  collapse behind the front one over a count bar with Mark all as read; hovering spreads them, and
 *  while the stack is hovered, touched or the tab hidden, nothing auto-hides. A finished run or a
 *  ready preview hides itself (still unread in the centre); a problem or a question stays until you
 *  dismiss it — the ✕ or a swipe left/down, which mark it read. */
export function ToastHost() {
  const { toasts } = useNotifications();
  useEffect(() => { start(); }, []);
  const [expanded, setExpanded] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const hidden = useDocumentHidden();
  const [heights, setHeights] = useState<Map<number, number>>(() => new Map());
  const [gone, setGone] = useState<Gone[]>([]);
  const stack = useMemo(() => toastStack(toasts), [toasts]);
  const layout = useMemo(() => stackLayout(stack.ordered.map((n) => heights.get(n.id) ?? 0), expanded), [stack, heights, expanded]);
  const anchor = useStackAnchor(toasts.length + gone.length > 0);
  const { open } = useNotificationActions();

  // A card that leaves the store stays rendered where it was, for its exit — noticed during render
  // (not in an effect), so the same element carries on and keeps its swipe-out.
  const [seen, setSeen] = useState<{ ordered: Notification[]; layout: ToastPlace[] }>({ ordered: [], layout: [] });
  if (seen.ordered !== stack.ordered || seen.layout !== layout) {
    const live = new Set(stack.ordered.map((n) => n.id));
    const leaving = seen.ordered.flatMap((n, i) => (live.has(n.id) || !seen.layout[i] ? [] : [{ n, place: seen.layout[i]! }]));
    setSeen({ ordered: stack.ordered, layout });
    if (leaving.length) setGone((g) => [...g.filter((x) => !leaving.some((l) => l.n.id === x.n.id)), ...leaving]);
  }
  const scheduled = useRef(new Set<number>());
  useEffect(() => {
    for (const { n } of gone) {
      if (scheduled.current.has(n.id)) continue;
      scheduled.current.add(n.id);
      setTimeout(() => {
        scheduled.current.delete(n.id);
        setGone((g) => g.filter((x) => x.n.id !== n.id));
        setHeights((h) => { const m = new Map(h); m.delete(n.id); return m; });
      }, TOAST_EXIT_MS);
    }
  }, [gone]);
  const leaving = gone.filter((g) => !stack.ordered.some((n) => n.id === g.n.id));

  useEffect(() => { if (toasts.length <= 1) setExpanded(false); }, [toasts.length]);
  const paused = expanded || interacting || hidden;
  useEffect(() => { if (paused) pauseToasts(); else resumeToasts(); }, [paused]);
  useEffect(() => () => resumeToasts(), []);

  const onHeight = useCallback((id: number, h: number) => setHeights((m) => (m.get(id) === h ? m : new Map(m).set(id, h))), []);
  if (!toasts.length && !leaving.length) return null;
  const showCount = toasts.length > 1;
  const width: CSSProperties = anchor.right !== undefined ? { right: anchor.right } : { width: TOAST_WIDTH };
  return (
    <>
      <div data-slot="notification-host" data-expanded={expanded || undefined} role="region" aria-label="Notification centre"
        // z-[60]: above the sidebar (z-50 — a toast anchored above the bell would otherwise paint
        // underneath it) and the orchestrator's side panel (z-40), still under native <dialog>s
        // (the command palette, Add New).
        className="fixed z-[60]" style={{ left: anchor.left, bottom: anchor.bottom + (showCount ? COUNT_BAR_SPACE : 0), ...width }}
        onMouseEnter={() => setExpanded(true)} onMouseMove={() => setExpanded(true)}
        onMouseLeave={() => { if (!interacting) setExpanded(false); }}
        onPointerDown={() => setInteracting(true)} onPointerUp={() => setInteracting(false)}
        onKeyDown={(e) => { if (e.key === "Escape") setExpanded(false); }}>
        {[
          ...stack.ordered.map((n, i) => (
            <Toast key={n.id} n={n} place={layout[i]!} expanded={expanded} count={stack.ordered.length} onHeight={onHeight}
              onOpen={() => open(n)} />
          )),
          ...leaving.map(({ n, place }) => (
            <Toast key={n.id} n={n} place={place} expanded={expanded} count={stack.ordered.length} removed onHeight={onHeight} onOpen={() => open(n)} />
          )),
        ]}
      </div>
      {showCount && (
        <div data-slot="notification-count" className="bg-card fixed z-[60] flex items-center justify-between rounded-lg border pl-3 pr-1 text-xs shadow-menu"
          style={{ left: anchor.left, bottom: anchor.bottom, height: COUNT_BAR_HEIGHT, ...width }}>
          <button type="button" className="text-muted-foreground hover:text-foreground" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
            {toasts.length} notifications
          </button>
          <Button variant="ghost" size="sm" className="h-5 px-2 text-xs" onClick={() => void markRead(toasts.map((t) => t.id))}>Mark all as read</Button>
        </div>
      )}
    </>
  );
}

function Toast({ n, place, expanded, count, removed = false, onHeight, onOpen }: {
  n: Notification; place: ToastPlace; expanded: boolean; count: number; removed?: boolean;
  onHeight: (id: number, h: number) => void; onOpen: () => void;
}) {
  const meta = KIND_META[n.kind];
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [swiping, setSwiping] = useState(false);
  const [out, setOut] = useState<SwipeDir>();
  const drag = useRef<{ x: number; y: number; at: number; axis?: "x" | "y"; amount: number }>();
  const [hover, setHover] = useState(false);
  const coarse = useCoarse();
  useEffect(() => { setMounted(true); }, []);
  // The natural height (not the clipped one a collapsed card behind is given), kept current.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || removed) return;
    const was = el.style.height;
    el.style.height = "auto";
    onHeight(n.id, el.getBoundingClientRect().height);
    el.style.height = was;
  }, [mounted, n.id, n.title, n.body, removed, onHeight]);

  const setSwipe = (x: number, y: number) => {
    ref.current?.style.setProperty("--swipe-x", `${x}px`);
    ref.current?.style.setProperty("--swipe-y", `${y}px`);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 2 || removed || (e.target as HTMLElement).closest("button")) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, at: Date.now(), amount: 0 };
    setSwiping(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || (window.getSelection()?.toString().length ?? 0) > 0) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.axis && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (!d.axis) return;
    d.amount = swipeAmount(d.axis, d.axis === "x" ? dx : dy);
    setSwipe(d.axis === "x" ? d.amount : 0, d.axis === "y" ? d.amount : 0);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = undefined;
    setSwiping(false);
    if (!d?.axis) return;
    const dir = swipeOut(d.axis, d.amount, Date.now() - d.at);
    if (dir) { setOut(dir); void markRead([n.id]); } else setSwipe(0, 0);
  };

  const motion = toastMotion(place, { mounted, removed, expanded });
  // A swiped-out card keeps its place; its keyframes carry it off.
  const y = out ? place.transform : motion.transform;
  const style = {
    "--y": y, opacity: out ? 1 : motion.opacity, zIndex: count - place.index + (removed ? 1 : 0),
    height: !removed && place.height !== undefined && place.height > 0 && (expanded || !place.front) ? place.height : undefined,
  } as CSSProperties;
  return (
    <div ref={ref} data-slot="notification-toast" data-kind={n.kind} role="status" tabIndex={0}
      data-front={place.front} data-index={place.index} data-visible={place.visible} data-expanded={expanded} data-mounted={mounted}
      data-removed={removed} data-swiping={swiping} data-swipe-out={out} data-slow={(motion.slow && !out) || undefined}
      aria-hidden={!place.visible || undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onMouseEnter={() => setHover(true)} onMouseMove={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className="group bg-card text-foreground absolute bottom-0 left-0 flex w-full flex-col gap-2 rounded-lg border p-3 shadow-menu outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50"
      style={style}>
      <div className="flex items-start gap-2">
        <KindIcon kind={n.kind} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-sm leading-5">
            <RepoLabel repo={n.repo} />
            <button type="button" data-slot="notification-title" className="truncate font-medium hover:underline" onClick={onOpen}>{n.title}</button>
            <span className={cn("shrink-0 text-xs", TONE_TEXT[meta.tone])}>{labelOf(n)}</span>
          </div>
          {n.body && <div className="text-muted-foreground line-clamp-2 text-xs leading-5 break-words">{n.body}</div>}
        </div>
        <Button variant="ghost" size="icon" className="-mt-1 -mr-1 size-6" aria-label="Mark as read" title="Mark as read" onClick={() => void markRead([n.id])}><X className="size-3.5" /></Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span data-slot="notification-time" className="text-muted-foreground shrink-0 text-xs">{ago(n.createdAt)}{n.instance ? ` · ${n.instance}` : ""}</span>
        {!removed && <QuickActions n={n} shown={hover || coarse} />}
      </div>
    </div>
  );
}

// ---- the bell and the centre ----

/** The bell at the sidebar's foot, with the unread count; opens the centre. */
export function NotificationBell({ collapsed = false }: { collapsed?: boolean }) {
  const { list } = useNotifications();
  const dnd = useAtomValue(notifyDndAtom);
  useEffect(() => { start(); }, []);
  const unread = unreadCount(list);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-slot="notifications-bell" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} title="Notifications"
          className={cn("text-muted-foreground hover:text-foreground hover:bg-accent relative inline-flex size-8 shrink-0 items-center justify-center rounded-md", collapsed && "md:mx-auto")}>
          {dnd ? <BellOff className="size-4" /> : <Bell className="size-4" />}
          {unread > 0 && (
            <span data-slot="notifications-unread" className="bg-geist-blue absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold text-white tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[24rem] max-w-[calc(100vw-2rem)] p-0">
        <NotificationPanel />
      </PopoverContent>
    </Popover>
  );
}

const isFilter = oneOf(...NOTIFICATION_FILTERS);

/** The centre: one compact header — the title, Unread (with its count) / All, Mark all as read — over
 *  the rows by day. It opens on Unread (remembered per browser), so a row you've read or dismissed is
 *  out of the way yet one click off under All. A click marks the row read and opens it. */
export function NotificationPanel() {
  const { list } = useNotifications();
  const dnd = useAtomValue(notifyDndAtom);
  const [filter, setFilter] = usePersisted<NotificationFilter>(persistedKey("notificationFilter"), "unread", isFilter);
  const { open } = useNotificationActions();
  const unread = unreadCount(list);
  const groups = groupByDay(filterNotifications(list, filter));
  return (
    <div data-slot="notification-centre" className="flex max-h-[70vh] flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <h3 className="text-sm font-medium">Notifications</h3>
        <span className="flex-1" />
        <Segmented<NotificationFilter> label="Show" value={filter} onChange={setFilter} options={[
          { value: "unread", label: <>Unread{unread > 0 && <Kbd data-slot="notification-unread-count" className="ml-1">{unread > 99 ? "99+" : unread}</Kbd>}</> },
          { value: "all", label: "All" },
        ]} />
        <button type="button" aria-label="Mark all as read" title="Mark all as read" onClick={() => void markRead("all")} disabled={!unread}
          className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-50">
          <CheckCheck className="size-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-10 text-center text-sm">
            <span className="rounded-full border p-2.5">{dnd ? <BellOff className="size-4" /> : <Bell className="size-4" />}</span>
            {filter === "unread" && list.length ? "You're all caught up." : "No notifications yet."}
            {dnd && <span className="text-xs">Do not disturb is on.</span>}
          </div>
        ) : groups.map((g) => (
          <section key={g.label} data-slot="notification-group">
            {/* z-10: a row below is `position: relative` (for its absolute quick-actions strip), so
                without an explicit z-index it paints ABOVE this sticky header once scrolled under it
                — the opaque bg-card alone doesn't stop that (see Chat.tsx's day divider, same fix). */}
            <h4 className="text-muted-foreground bg-card sticky top-0 z-10 border-b px-3 py-1.5 text-xs font-medium">{g.label}</h4>
            <ul className="divide-y">
              {g.items.map((n) => (
                <CentreRow key={n.id} n={n} onOpen={() => open(n)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** One row of the centre: a click opens it; hovering (or a touch screen) shows its quick actions
 *  over the row's foot, beside the time — its kind's verbs and, while unread, the × (mark read). */
function CentreRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const coarse = useCoarse();
  return (
    <li className="group hover:bg-accent/40 relative" onMouseEnter={() => setHover(true)} onMouseMove={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" data-slot="notification-row" data-kind={n.kind} data-unread={n.readAt ? undefined : ""} onClick={onOpen}
        className={cn("flex w-full items-start gap-2.5 px-3 pt-2.5 pb-10 text-left", n.readAt && "opacity-70")}>
        <KindIcon kind={n.kind} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 text-sm leading-5">
            <RepoLabel repo={n.repo} />
            <span className="truncate font-medium">{n.title}</span>
            <span className={cn("shrink-0 text-xs", TONE_TEXT[KIND_META[n.kind].tone])}>{labelOf(n)}</span>
          </span>
          {n.body && <span className="text-muted-foreground block truncate text-xs leading-5">{n.body}</span>}
          <span className="text-muted-foreground block text-xs">{ago(n.createdAt)}{n.instance ? ` · ${n.instance}` : ""}</span>
        </span>
        {!n.readAt && <span data-slot="unread-dot" className="bg-geist-blue mt-2 size-1.5 shrink-0 rounded-full" aria-label="unread" />}
      </button>
      <QuickActions n={n} shown={hover || coarse} onDismiss={n.readAt ? undefined : () => void markRead([n.id])} className="absolute right-2 bottom-1.5 left-9 justify-end" />
    </li>
  );
}
