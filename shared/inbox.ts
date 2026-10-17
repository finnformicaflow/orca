// The unified inbox and timeline (docs/research/integrations.md §6.2, phase 8): one list of what
// came in from every integration, newest first, and one thread view across inbound and outbound.
// Generic over adapter kinds: it reads only the core's envelope, delivery target and thread link.
// Pure: the server builds the rows with it, the web renders them, the tests import it as is.
import { replyToOf, type DeliveryState, type DeliveryTarget, type Envelope } from "./integrations";

/** An inbox topic: every external event (`ext.*`) and every question the orchestrator asks you. */
export const isInboxTopic = (topic: string): boolean => topic.startsWith("ext.") || topic === "orca.question";

/** One conversation: a thread on a platform (Slack `channel:ts`, an email's root Message-ID,
 *  `owner/repo#12`), else the place itself (a DM channel, a mailbox, a hook). An event with
 *  neither is its own conversation (`event:<id>`). */
export type Conversation = { adapter: string; id: string };

/** The URL form of a conversation: `<adapter>|<id>`. The adapter never holds a `|`. */
export const conversationParam = (c: Conversation): string => `${c.adapter}|${c.id}`;
export function parseConversation(s: string | null | undefined): Conversation | undefined {
  if (!s) return undefined;
  const at = s.indexOf("|");
  if (at <= 0 || at === s.length - 1) return undefined;
  return { adapter: s.slice(0, at), id: s.slice(at + 1) };
}

export const OWN_EVENT = "event:";

export function inboundConversation(e: Pick<Envelope, "id" | "thread" | "source">): Conversation {
  if (e.thread) return { adapter: e.thread.adapter, id: e.thread.externalId };
  if (e.source.channel) return { adapter: e.source.adapter, id: e.source.channel };
  return { adapter: e.source.adapter, id: `${OWN_EVENT}${e.id}` };
}

/** Where an outbound link delivery went, as a conversation: its thread, else the place. */
export function outboundConversation(t: DeliveryTarget): Conversation | undefined {
  return t.kind === "link" ? { adapter: t.adapter, id: t.threadId ?? t.externalId } : undefined;
}

const same = (a: Conversation | undefined, b: Conversation | undefined): boolean => !!a && !!b && a.adapter === b.adapter && a.id === b.id;

/** A delivery that belongs to a conversation: every post in its thread, but at the place itself
 *  (a channel, a mailbox) only an explicit post — a subscription's broadcast to the channel (a CI
 *  failure, a question) is not a reply to the last person who wrote there, and nor is a pairing
 *  code sent to an unknown sender there (`pairing:<code>:reply`). */
export const inConversation = (d: Pick<OutboundRecord, "target" | "subscriptionId" | "envelope">, c: Conversation): boolean =>
  same(outboundConversation(d.target), c)
  && (d.target.kind === "link" && d.target.threadId ? true : d.subscriptionId === undefined && !d.envelope.key.startsWith(PAIRING_KEY));
const PAIRING_KEY = "pairing:";

/** One outbound delivery to a link, with its event (server/integrations/store.ts `linkDeliveries`). */
export type OutboundRecord = {
  deliveryId: number; eventId: string; at: number;
  /** The subscription that planned it; absent for an explicit target (`orca post`, a pairing reply). */
  subscriptionId?: number; state: DeliveryState; attempts: number; lastError?: string;
  target: DeliveryTarget; envelope: Pick<Envelope, "key" | "topic" | "text" | "title" | "scope">;
};

export type ThreadLinkRecord = { adapter: string; externalThreadId: string; linkId?: string; repo: string; branch: string };

export type Sender = { name: string; principalId?: string; principalName?: string; externalId?: string };

/** The state of the reply to one inbox row: the newest outbound delivery in its conversation at or
 *  after it (or, for a question, the newest delivery of the question itself). */
export type ReplyState = { state: DeliveryState; at: number; attempts: number; error?: string };

export type InboxRow = {
  id: string; at: number; topic: string;
  /** `message` is a chat or email message, `question` the orchestrator's ask, `event` anything else
   *  (a push, an issue change, a webhook's own topic). */
  kind: "message" | "question" | "event";
  adapter: string; integrationId?: string; linkId?: string;
  sender?: Sender;
  title?: string; text: string; url?: string;
  conversation: string; // conversationParam
  workstream?: { repo: string; branch: string };
  reply?: ReplyState;
  /** You opened it (per user, `inbox_read`). */
  read: boolean;
  /** Its sender is muted (per user, `inbox_mute`); hidden unless the filter asks for muted rows. */
  muted: boolean;
  /** A message that came in on a link: Orca can answer it there (`replyRefusal`). */
  canReply: boolean;
  /** Its conversation is a real place or thread, not yet bound to a workstream (`thread_link`). */
  canLink: boolean;
};

/** The per-user inbox state the rows read: read event ids and muted senders (`muteKey`). */
export type InboxState = { read: ReadonlySet<string>; muted: ReadonlySet<string> };
export const muteKey = (adapter: string, externalId: string): string => `${adapter}:${externalId}`;
const NO_STATE: InboxState = { read: new Set(), muted: new Set() };

export const canReplyTo = (e: Pick<Envelope, "topic" | "source">): boolean =>
  inboxKind(e.topic) !== "question" && !!e.source.linkId && e.source.adapter !== "orca";

/** Why the inbox cannot answer an inbound event, or undefined when it can. The answer itself is
 *  `orca post --reply`'s (server/integrations/router.ts `replyToEvent`): the event's own channel
 *  (a catch-all link's `*` is no place) and its thread. */
export function replyRefusal(
  e: Pick<Envelope, "key" | "topic" | "source" | "thread">, text: string, link: { id: string; externalId: string } | undefined,
): string | undefined {
  if (!canReplyTo(e)) return "this event came in on no link, so there is nowhere to reply";
  if (!text.trim()) return "the reply is empty";
  if (!link || link.id !== e.source.linkId) return `the link "${e.source.linkId}" no longer exists`;
  if (!(replyToOf(e)?.channel ?? (link.externalId !== "*" ? link.externalId : undefined))) return "the event names no place to reply to";
  return undefined;
}

/** Text on a row: the first `INBOX_TEXT_MAX` characters. The thread view shows all of it. */
export const INBOX_TEXT_MAX = 400;

export const inboxKind = (topic: string): InboxRow["kind"] =>
  topic === "orca.question" ? "question" : /^ext\.[^.]+\.message$/.test(topic) ? "message" : "event";

export function senderOf(e: Pick<Envelope, "actor">, principals: ReadonlyMap<string, string>): Sender | undefined {
  if (!e.actor) return undefined;
  const ext = e.actor.external;
  const principalName = e.actor.principalId ? principals.get(e.actor.principalId) : undefined;
  return {
    name: principalName ?? ext.name ?? ext.id,
    ...(e.actor.principalId ? { principalId: e.actor.principalId } : {}),
    ...(principalName ? { principalName } : {}),
    externalId: ext.id,
  };
}

/** A person's filter id: the principal once paired, else `<adapter>:<external id>`. */
export const personId = (adapter: string, s: Sender): string => s.principalId ?? `${adapter}:${s.externalId ?? s.name}`;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The workstream an event belongs to: its thread's link, else its own scope. */
export function workstreamOf(e: Pick<Envelope, "thread" | "scope">, links: readonly ThreadLinkRecord[]): { repo: string; branch: string } | undefined {
  const tl = e.thread && links.find((l) => l.adapter === e.thread!.adapter && l.externalThreadId === e.thread!.externalId);
  if (tl) return { repo: tl.repo, branch: tl.branch };
  return e.scope?.repo && e.scope.branch ? { repo: e.scope.repo, branch: e.scope.branch } : undefined;
}

/** The inbox rows, newest first, from the core's event, delivery and thread_link rows. */
export function inboxRows(events: readonly Envelope[], outbound: readonly OutboundRecord[], links: readonly ThreadLinkRecord[], principals: ReadonlyMap<string, string>, state: InboxState = NO_STATE): InboxRow[] {
  return events.filter((e) => isInboxTopic(e.topic)).map((e) => {
    const conv = inboundConversation(e);
    const kind = inboxKind(e.topic);
    let reply: OutboundRecord | undefined;
    for (const d of outbound) {
      const mine = d.eventId === e.id || (d.at >= e.at && inConversation(d, conv));
      if (mine && (!reply || d.at > reply.at || (d.at === reply.at && d.deliveryId > reply.deliveryId))) reply = d;
    }
    const sender = senderOf(e, principals);
    const workstream = workstreamOf(e, links);
    return {
      id: e.id, at: e.at, topic: e.topic, kind, adapter: e.source.adapter,
      ...(e.source.integrationId ? { integrationId: e.source.integrationId } : {}),
      ...(e.source.linkId ? { linkId: e.source.linkId } : {}),
      ...(sender ? { sender } : {}),
      ...(e.title ? { title: e.title } : {}),
      text: clip(e.text, INBOX_TEXT_MAX),
      ...(e.link?.url ? { url: e.link.url } : {}),
      conversation: conversationParam(conv),
      ...(workstream ? { workstream } : {}),
      ...(reply ? { reply: { state: reply.state, at: reply.at, attempts: reply.attempts, ...(reply.lastError ? { error: reply.lastError } : {}) } } : {}),
      read: state.read.has(e.id),
      muted: !!e.actor && state.muted.has(muteKey(e.actor.external.adapter, e.actor.external.id)),
      canReply: canReplyTo(e),
      canLink: kind !== "question" && !conv.id.startsWith(OWN_EVENT) && !links.some((l) => l.adapter === conv.adapter && l.externalThreadId === conv.id),
    };
  }).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
}

/** `unread` keeps the rows you have not opened; `muted` shows ONLY muted senders' rows (they are
 *  hidden otherwise). */
export type InboxFilter = { source?: string; person?: string; unread?: boolean; muted?: boolean };

export function filterInbox(rows: readonly InboxRow[], f: InboxFilter): InboxRow[] {
  return rows.filter((r) => r.muted === !!f.muted && (!f.unread || !r.read)
    && (!f.source || r.adapter === f.source) && (!f.person || (r.sender && personId(r.adapter, r.sender) === f.person)));
}

export type InboxFacets = { sources: { adapter: string; count: number }[]; people: { id: string; name: string; count: number }[]; unread: number; muted: number };

/** The filter chips: every source and every person in the rows not muted, with counts, most first;
 *  how many of those are unread, and how many rows are muted. */
export function inboxFacets(all: readonly InboxRow[]): InboxFacets {
  const sources = new Map<string, number>(), people = new Map<string, { name: string; count: number }>();
  const rows = all.filter((r) => !r.muted);
  for (const r of rows) {
    sources.set(r.adapter, (sources.get(r.adapter) ?? 0) + 1);
    if (r.sender) {
      const id = personId(r.adapter, r.sender);
      const p = people.get(id);
      people.set(id, { name: p?.name ?? r.sender.name, count: (p?.count ?? 0) + 1 });
    }
  }
  const byCount = <T extends { count: number }>(a: T & { k: string }, b: T & { k: string }) => b.count - a.count || a.k.localeCompare(b.k);
  return {
    unread: rows.filter((r) => !r.read).length, muted: all.length - rows.length,
    sources: [...sources].map(([adapter, count]) => ({ adapter, count, k: adapter })).sort(byCount).map(({ k: _k, ...s }) => s),
    people: [...people].map(([id, p]) => ({ id, ...p, k: p.name })).sort(byCount).map(({ k: _k, ...p }) => p),
  };
}

/** One line of the thread view: a message in (with its sender) or a delivery out (with its state). */
export type ThreadItem =
  | { dir: "in"; id: string; at: number; adapter: string; topic: string; sender?: Sender; title?: string; text: string; url?: string }
  | { dir: "out"; id: string; at: number; adapter: string; topic: string; to: string; title?: string; text: string; state: DeliveryState; attempts: number; error?: string };

/** The whole conversation, oldest first: what came in and what Orca sent back, on one timeline.
 *  `linkLabels` names the place each delivery went (link id → label). */
export function threadItems(events: readonly Envelope[], outbound: readonly OutboundRecord[], principals: ReadonlyMap<string, string>, linkLabels: ReadonlyMap<string, string> = new Map()): ThreadItem[] {
  const seen = new Set<number>();
  const items: ThreadItem[] = [
    ...events.map((e): ThreadItem => {
      const sender = senderOf(e, principals);
      return {
        dir: "in", id: e.id, at: e.at, adapter: e.source.adapter, topic: e.topic,
        ...(sender ? { sender } : {}), ...(e.title ? { title: e.title } : {}), text: e.text, ...(e.link?.url ? { url: e.link.url } : {}),
      };
    }),
    ...outbound.filter((d) => !seen.has(d.deliveryId) && seen.add(d.deliveryId)).map((d): ThreadItem => {
      const t = d.target.kind === "link" ? d.target : undefined;
      return {
        dir: "out", id: `d${d.deliveryId}`, at: d.at, adapter: t?.adapter ?? d.target.kind, topic: d.envelope.topic,
        to: t ? linkLabels.get(t.linkId) ?? t.externalId : d.target.kind,
        ...(d.envelope.title ? { title: d.envelope.title } : {}), text: d.envelope.text,
        state: d.state, attempts: d.attempts, ...(d.lastError ? { error: d.lastError } : {}),
      };
    }),
  ];
  return items.sort((a, b) => a.at - b.at || (a.dir === b.dir ? 0 : a.dir === "in" ? -1 : 1));
}

/** The chips on a workstream card: each integration kind it has a thread on, once (repo::branch → kinds). */
export function threadSources(links: readonly ThreadLinkRecord[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of links) {
    const k = `${l.repo}::${l.branch}`;
    const have = out.get(k) ?? [];
    if (!have.includes(l.adapter)) out.set(k, [...have, l.adapter]);
  }
  return out;
}

const LABELS: Record<string, string> = {
  slack: "Slack", discord: "Discord", email: "Email", webhook: "Webhook", github: "GitHub", linear: "Linear", web: "Web", orca: "Orca",
};
/** A source's display name. An unknown kind shows its own name, first letter up. */
export const sourceLabel = (adapter: string): string => LABELS[adapter] ?? (adapter ? adapter[0]!.toUpperCase() + adapter.slice(1) : "?");

const STATE_LABELS: Record<DeliveryState, string> = { pending: "Queued", sending: "Sending", sent: "Sent", failed: "Retrying", dead: "Failed" };
export const deliveryLabel = (s: DeliveryState): string => STATE_LABELS[s];

/** What the thread view can do: reply to its newest event that came in on a link, link the
 *  conversation to a workstream, mute its newest sender, and which events are still unread. */
export type ThreadActions = { replyTo?: string; canLink: boolean; sender?: { eventId: string; name: string; muted: boolean }; unread: string[] };

export function threadActions(events: readonly Envelope[], linked: boolean, state: InboxState, principals: ReadonlyMap<string, string> = new Map()): ThreadActions {
  const newest = [...events].reverse();
  const reply = newest.find(canReplyTo);
  const who = newest.find((e) => e.actor);
  const first = events[0];
  return {
    ...(reply ? { replyTo: reply.id } : {}),
    canLink: !linked && !!first && inboxKind(first.topic) !== "question" && !inboundConversation(first).id.startsWith(OWN_EVENT),
    ...(who ? { sender: { eventId: who.id, name: senderOf(who, principals)!.name, muted: state.muted.has(muteKey(who.actor!.external.adapter, who.actor!.external.id)) } } : {}),
    unread: events.filter((e) => !state.read.has(e.id)).map((e) => e.id),
  };
}
