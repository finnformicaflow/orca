// The unified inbox and timeline (docs/research/integrations.md §6.2): every inbound message and
// event from every integration, newest first — its source, its sender, the workstream it belongs to
// and the state of Orca's reply — filtered by source, person, unread and muted, with the whole
// conversation (in and out) in a thread view. The rows are built on the server (shared/inbox.ts over
// the core's event, delivery and thread_link rows); this page only draws them. Each row's ⋯ and the
// thread view act on it: Reply where it came from (the `orca post` path), Link its conversation to a
// workstream, Mute its sender, mark it read. Opening a thread marks it read. The filters and the open
// thread live in the URL (?source= &person= &unread=1 &muted=1 &thread=), so a view is a link. On a
// desktop the thread opens beside the list; on a phone it replaces the list, with Back.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, BellOff, Bell, CheckCheck, Inbox as InboxIcon, Link2, Mail, MailOpen, MoreHorizontal, Reply, Send, X } from "lucide-react";
import { navigate, useSearch } from "@/lib/route";
import { poll } from "@/lib/poll";
import { cn } from "@/lib/utils";
import { useCoarse, useNarrow } from "@/lib/viewport";
import { actionFailed } from "@/lib/notificationStore";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tip } from "@/components/ui/tip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, RowSkeleton, StatusDot, VCard, type DotTone } from "@/components/console";
import { SourceChip } from "@/components/SourceChip";
import { api, type InboxPage, type InboxQuery, type InboxThread } from "../api";
import { useWorkstreams } from "../store";
import { ago } from "../workstream";
import { detailPath } from "./Agents";
import { deliveryLabel, parseConversation, sourceLabel, type InboxRow, type ReplyState, type ThreadItem } from "../../../shared/inbox";
import type { DeliveryState } from "../../../shared/integrations";

const EVERYONE = "*";

/** A failed inbox action is a notification (the console's rule), with the workstream when known. */
const failed = (action: string, e: unknown, ws?: { repo: string; branch: string }) =>
  actionFailed({ action, repo: ws?.repo ?? "inbox", branch: ws?.branch ?? "", title: "Inbox" }, e);

export function InboxPage() {
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const source = params.get("source") ?? "", person = params.get("person") ?? "", thread = params.get("thread") ?? "";
  const unread = params.get("unread") === "1", muted = params.get("muted") === "1";
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v); else next.delete(k);
    const qs = next.toString();
    navigate(`/inbox${qs ? `?${qs}` : ""}`);
  };
  const query: InboxQuery = { source, person, unread, muted };
  const queryRef = useRef(query);
  queryRef.current = query;
  const [page, setPage] = useState<InboxPage | null>(null);
  const [older, setOlder] = useState<InboxRow[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string>();
  const refetch = () => api.inbox(queryRef.current).then((p) => { setPage(p); setError(undefined); }, (e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    setPage(null); setOlder([]); setOlderCursor(undefined);
    return poll(refetch, 15_000);
  }, [source, person, unread, muted]);
  const cursor = olderCursor === undefined ? page?.older ?? null : olderCursor;
  const loadOlder = async () => {
    if (!cursor) return;
    const p = await api.inbox({ ...query, before: cursor });
    setOlder((o) => [...o, ...p.rows]);
    setOlderCursor(p.older);
  };
  const rows = page ? [...page.rows, ...older] : null;
  // Read state shows at once; the next poll confirms it.
  const markLocal = (ids: string[], read: boolean) => {
    const patch = (r: InboxRow) => (ids.includes(r.id) ? { ...r, read } : r);
    setPage((p) => p && { ...p, rows: p.rows.map(patch) });
    setOlder((o) => o.map(patch));
  };
  const markRead = (ids: string[], read = true) => {
    if (!ids.length) return;
    markLocal(ids, read);
    api.inboxRead(ids, read).then(refetch, (e) => failed(read ? "Mark as read" : "Mark as unread", e));
  };
  const narrow = useNarrow();
  const open = parseConversation(thread) ? thread : "";
  const openRow = (r: InboxRow) => { set({ thread: r.conversation }); };
  const filtered = !!(source || person || unread || muted);
  const list = (
    <div className="space-y-3">
      <Filters page={page} source={source} person={person} unread={unread} muted={muted} set={set}
        onMarkAll={rows && rows.some((r) => !r.read) ? () => markRead(rows.filter((r) => !r.read).map((r) => r.id)) : undefined} />
      <VCard slot="inbox-list" bodyClass="divide-y">
        {error && !page ? <Empty>Could not load the inbox: {error}</Empty>
          : rows === null ? <><RowSkeleton /><RowSkeleton /><RowSkeleton /></>
          : rows.length === 0 ? (
            <Empty icon={<InboxIcon />}>
              {filtered ? "No messages match these filters." : "No messages yet. Messages and events from linked integrations show here."}
            </Empty>
          )
          : rows.map((r) => <InboxRowView key={r.id} row={r} selected={open === r.conversation} onOpen={() => openRow(r)} onMarkRead={markRead} onChanged={refetch} />)}
        {cursor && rows && (
          <div className="flex justify-center px-4 py-2">
            <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>Load older</Button>
          </div>
        )}
      </VCard>
    </div>
  );
  const threadView = (back?: boolean) => (
    <ThreadView conversation={open} onClose={() => set({ thread: "" })} back={back} onChanged={refetch} onRead={(ids) => markLocal(ids, true)} />
  );
  if (open && narrow) return threadView(true);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      {open ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {list}
          <div className="lg:sticky lg:top-16">{threadView()}</div>
        </div>
      ) : list}
    </div>
  );
}

const chipClass = (on: boolean) => cn(
  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors",
  on ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground hover:border-foreground/30",
);

function Filters({ page, source, person, unread, muted, set, onMarkAll }: {
  page: InboxPage | null; source: string; person: string; unread: boolean; muted: boolean;
  set: (p: Record<string, string>) => void; onMarkAll?: () => void;
}) {
  const sources = page?.facets.sources ?? [], people = page?.facets.people ?? [];
  // A chip the window no longer holds still shows while it is the filter, so it can be turned off.
  const shown = source && !sources.some((s) => s.adapter === source) ? [...sources, { adapter: source, count: 0 }] : sources;
  const mutedCount = page?.facets.muted ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div role="group" aria-label="State" className="flex flex-wrap items-center gap-1.5">
        <button type="button" data-slot="inbox-unread" aria-pressed={unread} onClick={() => set({ unread: unread ? "" : "1" })} className={chipClass(unread)}>
          <StatusDot tone="queued" className="size-2" />Unread
          <span className="tabular-nums opacity-60">{page?.facets.unread ?? 0}</span>
        </button>
        {(mutedCount > 0 || muted) && (
          <button type="button" data-slot="inbox-muted" aria-pressed={muted} onClick={() => set({ muted: muted ? "" : "1" })} className={chipClass(muted)}>
            Muted<span className="tabular-nums opacity-60">{mutedCount}</span>
          </button>
        )}
      </div>
      <div role="group" aria-label="Source" className="flex flex-wrap items-center gap-1.5">
        <button type="button" data-slot="inbox-source" data-source="" aria-pressed={!source} onClick={() => set({ source: "" })} className={chipClass(!source)}>All sources</button>
        {shown.map((s) => (
          <button key={s.adapter} type="button" data-slot="inbox-source" data-source={s.adapter} aria-pressed={source === s.adapter}
            onClick={() => set({ source: source === s.adapter ? "" : s.adapter })} className={chipClass(source === s.adapter)}>
            {sourceLabel(s.adapter)}
            <span className="tabular-nums opacity-60">{s.count}</span>
          </button>
        ))}
      </div>
      <Select value={person || EVERYONE} onValueChange={(v) => set({ person: v === EVERYONE ? "" : v })}>
        <SelectTrigger data-slot="inbox-person" className="h-7 w-auto min-w-36 rounded-full text-[13px]" aria-label="Person">
          <span className="text-muted-foreground text-xs">From</span><SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={EVERYONE}>Everyone</SelectItem>
          {person && !people.some((p) => p.id === person) && <SelectItem value={person}>{person}</SelectItem>}
          {people.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} <span className="text-muted-foreground tabular-nums">{p.count}</span></SelectItem>)}
        </SelectContent>
      </Select>
      {(source || person || unread || muted) && (
        <button type="button" data-slot="clear-filters" onClick={() => set({ source: "", person: "", unread: "", muted: "" })} className="text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 px-1.5 text-[13px]">
          <X className="size-3.5" /> Clear
        </button>
      )}
      {onMarkAll && (
        <Tip label="Mark all as read">
          <Button variant="ghost" size="icon" data-slot="inbox-mark-all" className="ml-auto size-7" aria-label="Mark all as read" onClick={onMarkAll}><CheckCheck /></Button>
        </Tip>
      )}
    </div>
  );
}

const STATE_TONE: Record<DeliveryState, DotTone> = { pending: "queued", sending: "building", sent: "ready", failed: "warning", dead: "error" };

function DeliveryBadge({ state, error, prefix }: { state: DeliveryState; error?: string; prefix?: string }) {
  const badge = (
    <span data-slot="delivery-state" data-state={state} className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs", state === "dead" ? "text-geist-red" : "text-muted-foreground")}>
      <StatusDot tone={STATE_TONE[state]} className="size-2" />{prefix ? `${prefix} ${deliveryLabel(state).toLowerCase()}` : deliveryLabel(state)}
    </span>
  );
  return error && state !== "sent" ? <Tip label={error}>{badge}</Tip> : badge;
}

const replyBadge = (r: ReplyState) => <DeliveryBadge state={r.state} error={r.error} prefix="Reply" />;

/** The workstream a row or thread belongs to, as a chip that opens its page. */
function WorkstreamChip({ repo, branch }: { repo: string; branch: string }) {
  const rows = useWorkstreams();
  const row = rows.find((r) => r.repo === repo && r.branch === branch);
  const to = (row && detailPath(row)) ?? `/${repo}/local/${encodeURIComponent(branch)}`;
  return (
    <a href={to} data-slot="workstream-chip" onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(to); }}
      className="hover:text-foreground text-muted-foreground inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-[11px]">
      <span className="shrink-0">{repo}</span><span aria-hidden="true">/</span><span className="min-w-0 truncate font-mono">{row?.title && row.title !== branch ? row.title : branch}</span>
    </a>
  );
}

const When = ({ at }: { at: number }) => (
  <Tip label={new Date(at).toLocaleString()}><span className="text-muted-foreground shrink-0 text-xs tabular-nums">{ago(at)}</span></Tip>
);

const KIND_LABEL: Record<InboxRow["kind"], string | undefined> = { message: undefined, question: "Question", event: "Event" };

/** The actions one event offers: in a row's ⋯ and in the thread view's ⋯. Reply only opens the
 *  composer (the caller's); the others act here. */
function ActionsMenu({ eventId, canReply, canLink, sender, read, onReply, onMarkRead, onChanged, slot, ws }: {
  eventId: string; canReply: boolean; canLink: boolean; sender?: { name: string; muted: boolean }; read?: boolean;
  onReply?: () => void; onMarkRead?: (read: boolean) => void; onChanged: () => void; slot: string; ws?: { repo: string; branch: string };
}) {
  const workstreams = useWorkstreams().filter((r) => r.lane !== "DONE");
  const link = (repo: string, branch: string) => api.inboxLink(eventId, repo, branch).then(onChanged, (e) => failed("Link to workstream", e, { repo, branch }));
  const mute = (on: boolean) => api.inboxMute(eventId, on).then(onChanged, (e) => failed(on ? "Mute sender" : "Unmute sender", e, ws));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" data-slot={slot} className="size-7 shrink-0" aria-label="Actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {canReply && onReply && <DropdownMenuItem data-slot="action-reply" onSelect={onReply}><Reply />Reply</DropdownMenuItem>}
        {canLink && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-slot="action-link"><Link2 />Link to workstream</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
              {workstreams.length === 0 ? <DropdownMenuItem disabled>No open workstreams</DropdownMenuItem>
                : workstreams.map((w) => (
                  <DropdownMenuItem key={`${w.repo}::${w.branch}`} data-slot="link-target" data-branch={w.branch} onSelect={() => void link(w.repo, w.branch)}>
                    <span className="text-muted-foreground shrink-0 text-xs">{w.repo}</span><span className="truncate">{w.title}</span>
                  </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {onMarkRead && read !== undefined && (
          <DropdownMenuItem data-slot="action-read" onSelect={() => onMarkRead(!read)}>{read ? <><Mail />Mark as unread</> : <><MailOpen />Mark as read</>}</DropdownMenuItem>
        )}
        {sender && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-slot="action-mute" onSelect={() => void mute(!sender.muted)}>
              {sender.muted ? <><Bell />Unmute {sender.name}</> : <><BellOff />Mute {sender.name}</>}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The reply composer: Enter sends (a newline on a touch screen; Shift+Enter anywhere). A failed
 *  send is a notification and the text stays in the box. */
function ReplyBox({ eventId, to, onSent, onCancel, autoFocus, ws }: { eventId: string; to: string; onSent: () => void; onCancel?: () => void; autoFocus?: boolean; ws?: { repo: string; branch: string } }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const coarse = useCoarse();
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await api.inboxReply(eventId, t); setText(""); onSent(); }
    catch (e) { failed("Reply", e, ws); }
    finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); }
    if (e.key === "Enter" && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };
  return (
    <div data-slot="reply-box" className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} autoFocus={autoFocus} rows={3}
        placeholder={`Reply to ${to}…`} aria-label="Reply" className="min-h-20 resize-none text-[13px] max-md:text-base" />
      <div className="flex items-center justify-end gap-2">
        {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
        <Button size="sm" data-slot="reply-send" disabled={!text.trim() || busy} onClick={() => void send()}><Send />Send</Button>
      </div>
    </div>
  );
}

function InboxRowView({ row, selected, onOpen, onMarkRead, onChanged }: {
  row: InboxRow; selected: boolean; onOpen: () => void; onMarkRead: (ids: string[], read: boolean) => void; onChanged: () => void;
}) {
  const who = row.sender?.name ?? (row.kind === "question" ? "Orchestrator" : sourceLabel(row.adapter));
  const kind = KIND_LABEL[row.kind];
  const [replying, setReplying] = useState(false);
  return (
    <div role="button" tabIndex={0} data-slot="inbox-row" data-kind={row.kind} data-read={row.read} aria-current={selected || undefined}
      onClick={onOpen} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); } }}
      className={cn("flex cursor-pointer gap-3 px-4 py-3 text-sm outline-none", selected ? "bg-accent" : "hover:bg-accent/40 focus-visible:bg-accent/40")}>
      <div className="relative mt-0.5 shrink-0">
        <SourceChip adapter={row.adapter} iconOnly className="size-6 justify-center rounded-full p-0 [&>svg]:size-3.5" />
        {!row.read && <span data-slot="unread-dot" className="bg-geist-blue ring-card absolute -top-0.5 -left-0.5 size-2 rounded-full ring-2" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span data-slot="inbox-sender" className={cn("min-w-0 truncate", row.read ? "font-medium" : "font-semibold")}>{who}</span>
          {kind && <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 text-[10px] leading-4 font-medium uppercase">{kind}</span>}
          <span className="ml-auto" />
          <When at={row.at} />
          <ActionsMenu slot="row-actions" eventId={row.id} canReply={row.canReply} canLink={row.canLink} read={row.read} ws={row.workstream}
            sender={row.sender ? { name: row.sender.name, muted: row.muted } : undefined}
            onReply={() => setReplying(true)} onMarkRead={(read) => onMarkRead([row.id], read)} onChanged={onChanged} />
        </div>
        {row.title && <div className="truncate text-[13px]">{row.title}</div>}
        <div data-slot="inbox-text" className="text-muted-foreground line-clamp-2 text-[13px] break-words">{row.text}</div>
        {(row.workstream || row.reply) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {row.workstream && <WorkstreamChip repo={row.workstream.repo} branch={row.workstream.branch} />}
            {row.reply && replyBadge(row.reply)}
          </div>
        )}
        {replying && (
          <div className="pt-1">
            <ReplyBox eventId={row.id} to={who} autoFocus ws={row.workstream} onCancel={() => setReplying(false)} onSent={() => { setReplying(false); onChanged(); }} />
          </div>
        )}
      </div>
    </div>
  );
}

/** One conversation, oldest first: inbound on the left under the sender, Orca's deliveries on the
 *  right with their state, and Reply at the foot. Polled while it is open; opening it marks its
 *  events read. */
export function ThreadView({ conversation, onClose, back, onChanged, onRead }: {
  conversation: string; onClose: () => void; back?: boolean; onChanged?: () => void; onRead?: (ids: string[]) => void;
}) {
  const [t, setT] = useState<InboxThread | null>(null);
  const [error, setError] = useState<string>();
  const [replying, setReplying] = useState(false);
  const load = () => api.inboxThread(conversation).then((r) => { setT(r); setError(undefined); }, (e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    setT(null); setReplying(false);
    return poll(load, 10_000);
  }, [conversation]);
  const unread = t?.unread.join(",") ?? "";
  useEffect(() => {
    if (!t?.unread.length) return;
    onRead?.(t.unread);
    api.inboxRead(t.unread).then(() => onChanged?.(), () => {});
  }, [unread]);
  const changed = () => { void load(); onChanged?.(); };
  const c = parseConversation(conversation)!;
  const sender = t?.sender;
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      {back && <Button variant="ghost" size="icon" className="-ml-2 size-8" aria-label="Back" onClick={onClose}><ArrowLeft /></Button>}
      <SourceChip adapter={c.adapter} />
      <span className="min-w-0 truncate font-mono text-xs">{c.id.startsWith("event:") ? "Event" : c.id}</span>
    </span>
  );
  const anchor = t?.replyTo ?? sender?.eventId ?? t?.items.find((i) => i.dir === "in")?.id;
  const aside = (
    <>
      {t?.workstream && <WorkstreamChip repo={t.workstream.repo} branch={t.workstream.branch} />}
      {t && anchor && (t.canLink || sender) && (
        <ActionsMenu slot="thread-actions" eventId={anchor} canReply={false} canLink={t.canLink} ws={t.workstream}
          sender={sender ? { name: sender.name, muted: sender.muted } : undefined} onChanged={changed} />
      )}
      {!back && <Button variant="ghost" size="icon" className="size-7" aria-label="Close thread" onClick={onClose}><X /></Button>}
    </>
  );
  const to = sender?.name ?? sourceLabel(c.adapter);
  return (
    <VCard slot="inbox-thread" title={title} aside={aside} bodyClass="divide-y">
      <div className="space-y-4 p-4">
        {error && !t ? <Empty>Could not load the thread: {error}</Empty>
          : t === null ? <><RowSkeleton /><RowSkeleton /></>
          : t.items.length === 0 ? <Empty>Nothing in this conversation.</Empty>
          : t.items.map((i) => <ThreadLine key={i.id} item={i} />)}
      </div>
      {t?.replyTo && (
        <div data-slot="thread-reply" className="p-4">
          {replying
            ? <ReplyBox eventId={t.replyTo} to={to} autoFocus ws={t.workstream} onCancel={() => setReplying(false)} onSent={() => { setReplying(false); changed(); }} />
            : (
              <Button variant="outline" size="sm" data-slot="thread-reply-open" onClick={() => setReplying(true)}>
                <Reply />Reply in {sourceLabel(c.adapter)}
              </Button>
            )}
        </div>
      )}
    </VCard>
  );
}

function ThreadLine({ item }: { item: ThreadItem }) {
  const body: ReactNode = (
    <>
      {item.title && <div className="mb-1 font-medium">{item.title}</div>}
      <div className="break-words whitespace-pre-wrap">{item.text}</div>
    </>
  );
  if (item.dir === "in") return (
    <div data-slot="thread-item" data-dir="in" className="flex max-w-[85%] flex-col items-start gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">{item.sender?.name ?? sourceLabel(item.adapter)}</span>
        <When at={item.at} />
      </div>
      <div className="bg-card rounded-lg border px-3 py-2 text-[13px]">{body}</div>
      {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline">Open in {sourceLabel(item.adapter)}</a>}
    </div>
  );
  return (
    <div data-slot="thread-item" data-dir="out" className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
      <div className="flex items-center gap-2 text-xs">
        <When at={item.at} />
        <span className="font-medium">Orca</span>
        <span className="text-muted-foreground">to {item.to}</span>
      </div>
      <div className="bg-accent rounded-lg px-3 py-2 text-[13px]">{body}</div>
      <DeliveryBadge state={item.state} error={item.error} />
    </div>
  );
}
