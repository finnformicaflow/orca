// The notification centre's vocabulary and the pure decisions behind it, shared by the server (which
// decides WHAT an event is and writes it once) and the web (which decides how to show it). Flat: one
// row per event, no threads. Pure — no IO, so both sides and the tests import it as is.
import { parseAgentOutcome, type AgentOutcome, type StopReason, type TurnCheck } from "./agent";

export const NOTIFICATION_KINDS = [
  "needs_input", "finished", "failed", "stopped", "check_failed", "pr_ci_failed", "pr_conflicts", "preview_ready", "preview_failed", "action_failed",
  "merged", "merge_refused", "auto_address", "upkeep_gave_up", "draft_sent", "integration_failed", "external_message",
] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

/** Where a notification leads. The in-app page for a workstream is derived by the web from repo +
 *  branch (its PR page once it has one, else its local page), so only what the web can't derive is
 *  stored: an external `url` (a preview), a PR number, or the orchestrator's window. */
export type NotificationLink = { url?: string; pr?: number; orchestrator?: boolean };

export type Notification = {
  id: number;
  /** The instance where the event happened (recorded once, by it). */
  instance: string;
  repo: string;
  branch?: string;
  kind: NotificationKind;
  /** The workstream's title (else its branch) — what the toast is headed with. */
  title: string;
  /** One line. */
  body: string;
  link?: NotificationLink;
  createdAt: number;
  /** The one state a notification has: unread until this is set. Nothing is ever deleted by you —
   *  X, a quick action, Open and Mark all as read all just set it (rows go after 30 days). */
  readAt?: number;
  /** A LOCAL notification's extras (`action_failed`, raised in this browser and never stored — a
   *  button you clicked failed, which no other tab or machine needs to hear about): `label` names
   *  the failed verb in place of the kind's label ("Merge failed"), `copy` is what Copy puts on the
   *  clipboard and `ask` what Ask the orchestrator prefills. */
  label?: string;
  copy?: string;
  ask?: string;
  /** `draft_sent` only (also local, also never stored): what Undo and the title/Open action do for a
   *  just-sent new-draft toast — closures over the optimistic draft, since the branch it resolves to
   *  isn't known yet. */
  onUndo?: () => void;
  onOpen?: () => void;
};

/** What the emitter writes: a `key` makes the insert idempotent (unique per user), so a run that is
 *  finished twice (adopted after a restart, or the same repo answered by two instances) is one row. */
export type NotificationInput = Omit<Notification, "id" | "createdAt" | "readAt" | "instance"> & { key: string };

export type KindMeta = {
  label: string;
  /** The toast stays until dismissed (a problem, or something waiting on you); else it auto-hides. */
  persistent: boolean;
  /** Worth a browser notification when the tab is hidden. */
  urgent: boolean;
  tone: "ready" | "error" | "warning" | "queued" | "neutral";
};

export const KIND_META: Record<NotificationKind, KindMeta> = {
  needs_input: { label: "Needs input", persistent: true, urgent: true, tone: "queued" },
  finished: { label: "Finished", persistent: false, urgent: false, tone: "ready" },
  failed: { label: "Failed", persistent: true, urgent: true, tone: "error" },
  stopped: { label: "Stopped", persistent: true, urgent: false, tone: "warning" },
  check_failed: { label: "Check failed", persistent: true, urgent: true, tone: "error" },
  pr_ci_failed: { label: "CI failing", persistent: true, urgent: false, tone: "error" },
  pr_conflicts: { label: "Conflicts", persistent: true, urgent: false, tone: "warning" },
  preview_ready: { label: "Preview ready", persistent: false, urgent: false, tone: "ready" },
  preview_failed: { label: "Preview failed", persistent: true, urgent: false, tone: "error" },
  merged: { label: "Merged", persistent: false, urgent: false, tone: "ready" },
  merge_refused: { label: "Not merged", persistent: true, urgent: false, tone: "warning" },
  // Automatic PR upkeep (server/upkeep.ts): it started an Address PR on its own, or gave up on one.
  auto_address: { label: "Auto-addressing", persistent: false, urgent: false, tone: "queued" },
  upkeep_gave_up: { label: "Auto-upkeep gave up", persistent: true, urgent: false, tone: "warning" },
  action_failed: { label: "Action failed", persistent: true, urgent: false, tone: "error" },
  // The New-draft box's own toast (Shell.tsx AddNew): a draft was sent, with Undo while it's fresh.
  draft_sent: { label: "Sent", persistent: false, urgent: false, tone: "ready" },
  // The integrations layer (server/integrations/): a delivery to Slack, a webhook… gave up after its
  // retries, or a message from outside reached the web.
  integration_failed: { label: "Delivery failed", persistent: true, urgent: false, tone: "error" },
  external_message: { label: "Message", persistent: false, urgent: false, tone: "neutral" },
};

/** How long a non-persistent toast stays. */
export const TOAST_AUTO_HIDE_MS = 6_000;
/** A toast older than this when it arrives (a catch-up after a long absence) is not popped. */
export const TOAST_FRESH_MS = 10 * 60_000;

/** Strip the Markdown an agent's report prose is written in down to plain text — a notification
 *  card has no renderer, so `**bold**`, `` `code` ``, `[text](url)` and a stray heading/list marker
 *  otherwise show their literal syntax. Order matters: bold before the italic markers it's built
 *  from, so `**x**` doesn't leave a single `*x*` behind. Line-anchored patterns (`^`) run before
 *  `oneLine` collapses the text to one line. */
export const stripMarkdown = (text: string): string => text
  .replace(/^\s{0,3}#{1,6}\s+/gm, "")
  .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/__([^_]+)__/g, "$1")
  .replace(/\*([^*\n]+)\*/g, "$1")
  .replace(/_([^_\n]+)_/g, "$1");

const oneLine = (text: string, max = 140): string => {
  const line = stripMarkdown(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The agent asked you something. Nobody has a cleaner signal than the reply itself (a question is
 *  still `end_turn`, see StopReason), so: a run blocked on a tool confirmation, or a reply whose last
 *  line is a question. The outcome's prose is preferred over the raw response when it exists. */
export function asksForInput(input: { stopReason?: StopReason; response?: string; outcome?: AgentOutcome }): boolean {
  if (input.stopReason === "requires_action") return true;
  const text = (input.outcome ? [input.outcome.outcome, ...input.outcome.remaining].join("\n") : input.response) ?? "";
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return /\?\s*$/.test(last.replace(/[*_`]+$/, ""));
}

/** What a finished run is, as a notification — or nothing, for a run nobody needs telling about. */
export function runNotification(run: {
  repo: string; branch: string; runId: string; title?: string; status: "done" | "error" | "stopped";
  stopReason?: StopReason; response?: string; outcome?: AgentOutcome; error?: string;
  /** The orchestrator's own wake: only a problem or a question is reported. */
  orchestrator?: boolean;
  /** A queued follow-up (an autofix) took straight over: not idle, so no "finished". */
  continued?: boolean;
  /** A compact is housekeeping. */
  compact?: boolean;
}): NotificationInput | undefined {
  if (run.compact) return undefined;
  // The structured outcome when the caller has it, else parsed from the reply (the same sections).
  run = { ...run, outcome: run.outcome ?? (run.response ? parseAgentOutcome(run.response) : undefined) };
  const base = { repo: run.repo, branch: run.branch, title: run.title || run.branch, link: run.orchestrator ? { orchestrator: true } : undefined };
  if (run.status === "error") {
    return { ...base, kind: "failed", key: `run:${run.runId}:failed`, body: oneLine(run.error || run.response || "The run failed.") };
  }
  if (run.status === "stopped") {
    if (run.orchestrator) return undefined; // you pressed Stop on it; nothing to tell
    return { ...base, kind: "stopped", key: `run:${run.runId}:stopped`, body: "Stopped. The work so far stands; reply to redirect." };
  }
  if (asksForInput(run)) {
    const text = run.outcome ? [run.outcome.outcome, ...run.outcome.remaining].join("\n") : run.response ?? "";
    const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
    return { ...base, kind: "needs_input", key: `run:${run.runId}:needs_input`, body: oneLine(last) };
  }
  if (run.orchestrator || run.continued) return undefined;
  return { ...base, kind: "finished", key: `run:${run.runId}:finished`, body: oneLine(run.outcome?.outcome || run.response || "Done.") };
}

/** Orca's check failed over a run's commit. Separate from the run's own notification: a run can be
 *  "finished" by its own account and still have failed the gate — and an autofix continuing the
 *  branch does not make the failure less worth knowing. */
export function checkNotification(run: { repo: string; branch: string; runId: string; title?: string; check?: TurnCheck }): NotificationInput | undefined {
  if (!run.check || run.check.ok) return undefined;
  return {
    repo: run.repo, branch: run.branch, title: run.title || run.branch, kind: "check_failed", key: `check:${run.runId}`,
    body: oneLine(`${run.check.command} exited ${run.check.exitCode}`),
  };
}

/** A preview that came up (with the URL to open) or didn't. `startedAt` is in the key, so a re-spin
 *  of the same worktree is its own event. */
export function previewNotification(p: {
  repo: string; branch?: string; title: string; key: string; startedAt: number;
  ready: boolean; url?: string; error?: string;
}): NotificationInput {
  return p.ready
    ? { repo: p.repo, branch: p.branch, title: p.title, kind: "preview_ready", key: `preview:${p.key}:${p.startedAt}:ready`, body: p.url ? oneLine(p.url) : "Running.", link: p.url ? { url: p.url } : undefined }
    : { repo: p.repo, branch: p.branch, title: p.title, kind: "preview_failed", key: `preview:${p.key}:${p.startedAt}:failed`, body: oneLine(p.error || "A service did not come up.") };
}

/** What an open PR's state says: CI failing once per head commit, conflicts once per PR. Read off
 *  the ordinary PR list, so it costs nothing extra. The CI key is the COMMIT, never the set of
 *  failing checks: that set changes while checks run, re-run and flap on one commit (lint fails,
 *  then lint + test, then test after a re-run), and each new set was a new key — the same failure
 *  notified three times. A new push failing again is news; without a head SHA, once per PR. */
export function prNotifications(repo: string, prs: {
  number: number; title: string; branch: string; state: string; ciStatus: string; mergeable: string; failingChecks?: string[]; head?: string;
}[]): NotificationInput[] {
  const out: NotificationInput[] = [];
  for (const pr of prs) {
    if (pr.state !== "OPEN") continue;
    const base = { repo, branch: pr.branch, title: pr.title || pr.branch, link: { pr: pr.number } };
    if (pr.ciStatus === "failing") {
      const checks = [...(pr.failingChecks ?? [])].sort();
      out.push({ ...base, kind: "pr_ci_failed", key: `pr-ci:${repo}#${pr.number}${pr.head ? `@${pr.head}` : ""}`, body: checks.length ? oneLine(`Failing: ${checks.join(", ")}`) : "CI is failing." });
    }
    if (pr.mergeable === "CONFLICTING") {
      out.push({ ...base, kind: "pr_conflicts", key: `pr-conflict:${repo}#${pr.number}`, body: "Has merge conflicts with its base." });
    }
  }
  return out;
}

/** How many are unread — the bell's badge and the centre's Unread count. */
export const unreadCount = (list: Pick<Notification, "readAt">[]): number => list.filter((n) => !n.readAt).length;

/** The centre's one filter: Unread (the default — a read row drops out of it) or All (read ones too). */
export const NOTIFICATION_FILTERS = ["unread", "all"] as const;
export type NotificationFilter = typeof NOTIFICATION_FILTERS[number];
export const filterNotifications = <T extends Pick<Notification, "readAt">>(list: T[], filter: NotificationFilter): T[] =>
  filter === "all" ? list : list.filter((n) => !n.readAt);

/** The centre's rows grouped by calendar day, newest group (and row) first. */
export function groupByDay<T extends Pick<Notification, "createdAt">>(list: T[], now = Date.now()): { label: string; items: T[] }[] {
  const dayOf = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const today = dayOf(now);
  const label = (day: number) => day === today ? "Today" : day === today - 86_400_000 ? "Yesterday"
    : new Date(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const groups = new Map<number, T[]>();
  for (const n of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    const day = dayOf(n.createdAt);
    (groups.get(day) ?? groups.set(day, []).get(day)!).push(n);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([day, items]) => ({ label: label(day), items }));
}

/** Per-kind "show a toast" preferences; a kind absent from the map is on. */
export type ToastPrefs = Partial<Record<NotificationKind, boolean>>;

/** Kinds whose content, for an ORCHESTRATED workstream, is already relayed into the orchestrator's
 *  own conversation as a worker report (`agent.onRunFinished`'s workerEvent, or the merge queue's
 *  report for "the orchestrator's PRs") — a second toast for it on a phone is pure noise over a
 *  conversation that already said it. A preview's status, a local action failure and a just-sent
 *  draft are never relayed, orchestrated or not, so they're left out. */
export const ORCHESTRATOR_RELAYED_KINDS: NotificationKind[] =
  NOTIFICATION_KINDS.filter((k) => k !== "preview_ready" && k !== "preview_failed" && k !== "action_failed" && k !== "draft_sent");

/** Whether a notification's content already shows in the orchestrator's own chat: its OWN wake
 *  (`link.orchestrator` — literally a turn of that conversation) always does; a relayed kind on a
 *  workstream the orchestrator is running does too. */
export function echoesOrchestratorChat(n: Pick<Notification, "kind" | "link">, orchestrated: boolean): boolean {
  if (n.link?.orchestrator) return true;
  return orchestrated && ORCHESTRATOR_RELAYED_KINDS.includes(n.kind);
}

/** Whether a notification pops up: not while do-not-disturb is on, not a kind switched off, and not
 *  one older than the fresh window (a catch-up after an hour away is for the centre, not the corner).
 *  On a phone (`mobile`), never while the orchestrator's chat is open, and never for a notification
 *  whose content already shows there (`echoesOrchestratorChat`) — it stays in the centre instead.
 *  Desktop is unaffected: `mobile` false (the default) skips both checks entirely. */
export function shouldToast(n: Pick<Notification, "kind" | "createdAt" | "readAt" | "link">, opts: {
  dnd: boolean; prefs: ToastPrefs; now?: number; mobile?: boolean; orchestratorOpen?: boolean; orchestrated?: boolean;
}): boolean {
  if (opts.dnd || n.readAt) return false;
  if (opts.prefs[n.kind] === false) return false;
  if ((opts.now ?? Date.now()) - n.createdAt >= TOAST_FRESH_MS) return false;
  if (opts.mobile && (opts.orchestratorOpen || echoesOrchestratorChat(n, Boolean(opts.orchestrated)))) return false;
  return true;
}

/** A browser notification while the tab is hidden: the urgent kinds only. */
export const shouldNotifyBrowser = (n: Pick<Notification, "kind">, opts: { enabled: boolean; hidden: boolean; dnd: boolean }): boolean =>
  opts.enabled && opts.hidden && !opts.dnd && KIND_META[n.kind].urgent;

// ---- browser notifications: what the Settings switch can do in this browser ----
// The switch used to ask for the permission and, on any answer but "granted", quietly set itself
// back off. Over the plain-http tailnet that answer is always "denied" (the Notification API needs a
// secure context, and the browser refuses it without a prompt), so the switch never turned on and
// said nothing. Now the page reads the state first and shows how to allow it instead of a dead switch.
export type BrowserPermission = "granted" | "default" | "denied" | "insecure" | "unsupported";

/** The browser's notification permission, read off `globalThis` (a parameter, so tests pass a fake). */
export function browserPermission(g: { isSecureContext?: boolean; Notification?: { permission?: string } } = globalThis as never): BrowserPermission {
  if (g.isSecureContext === false) return "insecure";
  if (!g.Notification) return "unsupported";
  const p = g.Notification.permission;
  return p === "granted" || p === "denied" ? p : "default";
}

/** The switch reads on only when the stored choice is on AND the browser will show one. */
export const browserNotifyChecked = (enabled: boolean, p: BrowserPermission): boolean => enabled && p === "granted";

/** The note that replaces the switch where it can do nothing; null where the switch works. */
export function browserNotifyNote(p: BrowserPermission): string | null {
  if (p === "denied") return "This browser blocks notifications for Orca. Allow them in the site settings (the icon left of the address), then reload.";
  if (p === "insecure") return "Browser notifications need HTTPS or localhost. Open Orca at a secure address to use them.";
  if (p === "unsupported") return "This browser has no notifications. On an iPhone, add Orca to the Home Screen first.";
  return null;
}

// ---- the toast stack: branch-demo's inbox toasts, which are sonner's bottom-left stack ----
// Re-implemented with CSS transitions (no dependency), with sonner's numbers: three visible, a 14px
// lift between collapsed cards each 5% smaller, spread on hover by the real heights plus the gap,
// 400ms transform / opacity / height, 200ms before a removed card unmounts, a swipe of 45px (or a
// flick) dismisses, and the auto-hide clock pauses while the stack is expanded, touched or hidden.

/** How many toasts show, collapsed or expanded (the bell's centre has the rest). */
export const STACK_VISIBLE = 3;
/** The gap between expanded cards, and the lift between collapsed ones. */
export const STACK_GAP = 14;
/** Each collapsed card behind the front one is this much smaller. */
export const STACK_SCALE_STEP = 0.05;
/** A removed card plays its exit for this long before it unmounts. */
export const TOAST_EXIT_MS = 200;
/** The stack's width (sonner's). */
export const TOAST_WIDTH = 356;
/** The count bar under the stack, and the space the stack leaves for it. */
export const COUNT_BAR_HEIGHT = 27;
export const COUNT_BAR_SPACE = COUNT_BAR_HEIGHT + 4;
export const SWIPE_THRESHOLD = 45;
export const SWIPE_VELOCITY = 0.11;

/** The toast stack as rendered: newest first, the top few showing, the rest counted. Pure, so the
 *  stacking rules are testable without a DOM. */
export function toastStack<T extends Pick<Notification, "id" | "createdAt">>(toasts: T[]): { ordered: T[]; visible: T[]; hidden: number } {
  const ordered = [...toasts].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const visible = ordered.slice(0, STACK_VISIBLE);
  return { ordered, visible, hidden: ordered.length - visible.length };
}

/** Where one card sits: `heights` are the live cards' natural heights, newest first. Collapsed, the
 *  front card is in place and each one behind is lifted 14px and shrunk 5%, clipped to the front
 *  card's height; expanded, each sits above the ones before it, a gap apart. */
export type ToastPlace = { index: number; front: boolean; visible: boolean; offset: number; height?: number; transform: string };
export function stackLayout(heights: number[], expanded: boolean): ToastPlace[] {
  let before = 0;
  return heights.map((h, index) => {
    const offset = before + index * STACK_GAP;
    before += h;
    const front = index === 0;
    const base = { index, front, visible: index < STACK_VISIBLE, offset };
    if (expanded) return { ...base, height: h, transform: `translateY(${-offset}px)` };
    if (front) return { ...base, transform: "translateY(0px)" };
    return { ...base, height: heights[0], transform: `translateY(${-index * STACK_GAP}px) scale(${+(1 - index * STACK_SCALE_STEP).toFixed(2)})` };
  });
}

/** A card's motion state, as sonner's CSS draws it: it slides up from below the stack on mount, and
 *  on removal the front card drops back down, an expanded one drops from where it was, and a
 *  collapsed one behind sinks a little (500ms) as it fades. */
export function toastMotion(place: ToastPlace, s: { mounted: boolean; removed: boolean; expanded: boolean }): { transform: string; opacity: number; slow?: boolean } {
  if (s.removed) {
    if (place.front) return { transform: "translateY(100%)", opacity: 0 };
    if (s.expanded) return { transform: `translateY(calc(${-place.offset}px + 100%))`, opacity: 0 };
    return { transform: "translateY(40%)", opacity: 0, slow: true };
  }
  if (!s.mounted) return { transform: "translateY(100%)", opacity: 0 };
  return { transform: place.transform, opacity: place.visible ? 1 : 0 };
}

/** A drag on a card: the axis locks on the first pixel; toward the stack's own edges (left, down)
 *  it follows the pointer, the other way it is dampened. Released past 45px, or flicked, it is gone
 *  that way; otherwise it springs back (undefined). */
export type SwipeDir = "left" | "right" | "up" | "down";
export function swipeAmount(axis: "x" | "y", delta: number): number {
  const free = axis === "x" ? delta < 0 : delta > 0;
  if (free) return delta;
  const damped = delta * (1 / (1.5 + Math.abs(delta) / 20));
  return Math.abs(damped) < Math.abs(delta) ? damped : delta;
}
export function swipeOut(axis: "x" | "y", amount: number, ms: number): SwipeDir | undefined {
  if (Math.abs(amount) < SWIPE_THRESHOLD && Math.abs(amount) / Math.max(ms, 1) <= SWIPE_VELOCITY) return undefined;
  return axis === "x" ? (amount > 0 ? "right" : "left") : (amount > 0 ? "down" : "up");
}

/** The auto-hide clock: it runs down only while the stack is neither hovered, touched nor hidden;
 *  a pause keeps what is left, a resume runs that remainder (not the whole delay again). */
export type HideClock = { remaining: number; since?: number };
export const clockStart = (ms: number, now: number, paused = false): HideClock => (paused ? { remaining: ms } : { remaining: ms, since: now });
export const clockPause = (c: HideClock, now: number): HideClock => (c.since === undefined ? c : { remaining: Math.max(0, c.remaining - (now - c.since)) });
export const clockResume = (c: HideClock, now: number): HideClock => (c.since === undefined ? { remaining: c.remaining, since: now } : c);

/** Where the stack anchors: bottom-left, its foot just above the bell, its left edge on the sidebar
 *  foot's padding (the stack grows upward from there). Narrow, or with no bell on screen (the
 *  sidebar is off-canvas), it falls back to full width above the phone's bottom bar. */
export type StackAnchor = { left: number; bottom: number; right?: number };
export const MOBILE_STACK_OFFSET = 16;
export function stackAnchor(bell: { left: number; top: number; width: number } | undefined, foot: { left: number } | undefined, viewport: { width: number; height: number }, narrow: boolean, bottomBar = 64): StackAnchor {
  if (narrow || !bell || bell.width === 0) return { left: MOBILE_STACK_OFFSET, right: MOBILE_STACK_OFFSET, bottom: bottomBar + MOBILE_STACK_OFFSET };
  const left = Math.max(8, Math.min((foot?.left ?? bell.left) + 8, viewport.width - TOAST_WIDTH - 8));
  return { left, bottom: Math.max(8, viewport.height - bell.top + 8) };
}

/** The in-app route a notification opens: its PR page when it names one, else the workstream's page
 *  — resolved by the caller against the live rows (`rowPath`), falling back to the local page. */
export function notificationPath(n: Pick<Notification, "repo" | "branch" | "link">, rowPath?: string | null): string | undefined {
  if (n.link?.pr) return `/${n.repo}/prs/${n.link.pr}`;
  if (rowPath) return rowPath;
  if (n.branch) return `/${n.repo}/local/${encodeURIComponent(n.branch)}`;
  return undefined;
}
