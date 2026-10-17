// One path in (docs/research/integrations.md §3.1, §3.5). `ingest` is an adapter's door: dedupe,
// gate the sender against its link (§3.7), then `publish`. `publish` is everyone's: record the event
// once by its key and plan its deliveries in the same transaction, then kick the dispatcher.
import { randomUUID } from "crypto";
import { effectiveGrant, INBOUND_LIMIT, paceWait, pairingCode, pairingReply, planDeliveries, replyToOf, PAIRING_CODE_LENGTH, type ConversationRef, type Envelope, type Grant, type InboundEnvelope, type PlannedDelivery, type ReplyTo } from "../../shared/integrations";
import { replyRefusal } from "../../shared/inbox";
import * as store from "./store";

/** Orca's own id: time-ordered, so `ORDER BY id` is arrival order. */
export const newEventId = (now = Date.now()): string => `${now.toString(36).padStart(9, "0")}-${randomUUID().slice(0, 12)}`;

type Kick = () => void;
let kick: Kick = () => {};
/** The dispatcher registers itself here (§3.5 rule 6: kick in-process after each insert). */
export const onPublished = (fn: Kick): void => { kick = fn; };

/** Record one event and route it. Idempotent on `key`. `grant` is set by `ingest` only; absent =
 *  Orca's own event, with the full grant. `extra` are deliveries to explicit targets beside the
 *  subscriptions' (`orca post`, `orca ask-user`, a pairing reply). */
export async function publish(input: InboundEnvelope & { grant?: Grant }, now = Date.now(), extra: PlannedDelivery[] = []): Promise<{ status: "new" | "duplicate"; id: string; deliveries: number[] }> {
  const e: Envelope = { ...input, id: newEventId(now) };
  const [subs, allLinks, conns, threads, inbound] = await Promise.all([
    store.subscriptions(),
    store.links(),
    store.integrations(),
    e.scope?.repo && e.scope.branch ? store.threadsForWorkstream(e.scope.repo, e.scope.branch) : Promise.resolve(new Map<string, string>()),
    e.thread ? store.threadLink(e.thread.adapter, e.thread.externalId) : Promise.resolve(undefined),
  ]);
  const kinds = new Map(conns.map((c) => [c.id, c.kind]));
  const links = new Map(allLinks.map((l) => [l.id, { integrationId: l.integrationId, adapter: kinds.get(l.integrationId) ?? "?", externalId: l.externalId }]));
  const planned = [...planDeliveries(e, subs, links, threads, inbound), ...extra];
  const r = await store.recordEvent(e, planned, now);
  if (r.status === "new" && r.deliveries.length) kick();
  return { ...r, id: e.id };
}

/** `orca post`: one `orca.message` with one explicit delivery to a link, so the dispatcher sends it
 *  through the link's adapter and retries a failure. `reply` answers an inbound event where it came
 *  from: its place (a catch-all link's DM, not "*") and its thread. `thread` rides the envelope, so an
 *  email answer is an `In-Reply-To`. Used by `orca post [--reply]` and the inbox's Reply. */
export async function post(link: store.Link, text: string, opts: {
  reply?: ReplyTo; threadId?: string; scope?: { repo: string; branch?: string }; thread?: ConversationRef; key?: string;
} = {}, now = Date.now()): Promise<{ id: string; delivery?: number; externalId: string; threadId?: string }> {
  const conn = await store.integration(link.integrationId);
  const threadId = opts.reply ? opts.reply.threadId : opts.threadId;
  const externalId = opts.reply?.channel ?? link.externalId;
  const r = await publish({
    key: opts.key ?? `post:${randomUUID()}`, topic: "orca.message", at: now, source: { adapter: "orca", linkId: link.id },
    ...(opts.scope ? { scope: opts.scope } : {}), ...(opts.thread ? { thread: opts.thread } : {}), text,
  }, now, [{ subscriptionId: null, target: {
    kind: "link", integrationId: link.integrationId, adapter: conn?.kind ?? "?", linkId: link.id, externalId, ...(threadId ? { threadId } : {}),
  } }]);
  return { id: r.id, ...(r.deliveries[0] !== undefined ? { delivery: r.deliveries[0] } : {}), externalId, ...(threadId ? { threadId } : {}) };
}

/** The inbox's Reply (docs/research/integrations.md §6.2): `post` with the event's own `replyToOf`,
 *  the place and thread `orca post --reply` uses. The refusals are pure (shared/inbox.ts). */
export async function replyToEvent(eventId: string, text: string, now = Date.now()): Promise<{ eventId: string; delivery?: number }> {
  const e = await store.eventById(eventId);
  if (!e) throw new Error(`no event ${eventId}`);
  const link = e.source.linkId ? await store.link(e.source.linkId) : undefined;
  const refusal = replyRefusal(e, text, link);
  if (refusal) throw new Error(refusal);
  const r = await post(link!, text.trim(), {
    reply: replyToOf(e), ...(e.scope?.repo ? { scope: { repo: e.scope.repo, ...(e.scope.branch ? { branch: e.scope.branch } : {}) } } : {}),
    ...(e.thread ? { thread: e.thread } : {}), key: `reply:${eventId}:${randomUUID()}`,
  }, now);
  return { eventId: r.id, ...(r.delivery !== undefined ? { delivery: r.delivery } : {}) };
}

// Inbound pace per sender (§3.8): in memory, per process — one primary runs the adapters.
const recent = new Map<string, number[]>();

/** Reset the inbound pace (tests). */
export const resetPace = (): void => recent.clear();

/** The core's half of `ctx.ingest`. */
export async function ingest(integrationId: string, e: InboundEnvelope, now = Date.now()): Promise<"new" | "duplicate" | "rejected"> {
  // Dedupe first, so a platform retry of an accepted event is "duplicate", never a second pace hit.
  if (await store.event(e.key)) return "duplicate";
  // A link for the exact place, else for a wider place that holds it (`source.parents`), else the
  // integration's catch-all link (external_id "*": DMs, a bot's every channel). No link = nobody
  // said Orca may listen there.
  const link = e.source.linkId ? await store.link(e.source.linkId) : e.source.channel ? await firstLink(integrationId, [e.source.channel, ...(e.source.parents ?? []), "*"]) : undefined;
  if (!link || link.integrationId !== integrationId) return "rejected"; // no link = nobody said Orca may listen here
  if (link.requireMention && e.mentioned === false) return "rejected";
  const who = `${integrationId}:${e.actor?.external.id ?? link.id}`;
  const times = recent.get(who) ?? [];
  if (paceWait(times, now, INBOUND_LIMIT.count, INBOUND_LIMIT.windowMs) > 0) return "rejected";
  recent.set(who, [...times.filter((t) => now - t < INBOUND_LIMIT.windowMs), now]);
  // A person is gated on who they are (an unknown sender gets nothing until paired); a sender with no
  // person behind it (a webhook, a poller) is authenticated by its integration and takes the link's level.
  const principal = e.actor ? await store.principalFor(e.actor.external.adapter, e.actor.external.id) : undefined;
  if (e.actor && !principal) {
    if (link.level !== "notify") await requestPairing(integrationId, link.id, e, now);
    return "rejected";
  }
  const grant: Grant = e.actor ? effectiveGrant(link, principal) : { level: link.level, repos: link.repos, linkId: link.id };
  // A notify link takes nothing in — except, when its integration says so (`config.machineEventsOnNotify`),
  // a machine event (no person: a poller, a webhook). That event is recorded and fans out to its
  // subscriptions (the web, other links) with the grant "notify", so no agent acts on it.
  if (grant.level === "notify" && (e.actor || !(await machineEventsOnNotify(integrationId)))) return "rejected";
  const principalId = grant.principalId;
  const r = await publish({
    ...e, source: { ...e.source, integrationId, linkId: link.id },
    ...(e.actor && principalId ? { actor: { ...e.actor, principalId } } : {}),
    grant,
  }, now);
  return r.status;
}

/** The integration's switch for machine events on a notify link. Off unless set to exactly `true`. */
async function machineEventsOnNotify(integrationId: string): Promise<boolean> {
  return (await store.integration(integrationId))?.config.machineEventsOnNotify === true;
}

async function firstLink(integrationId: string, places: string[]): Promise<store.Link | undefined> {
  for (const p of places) { const l = await store.linkFor(integrationId, p); if (l) return l; }
  return undefined;
}

/** An unknown sender on a linked place: their pending code, or a new one. A NEW code is sent back to
 *  them on the same place (a durable delivery, so a send failure retries) and shown in the bell. The
 *  message itself is dropped: they send it again once you approve (POST /api/integrations/pairing/approve). */
async function requestPairing(integrationId: string, linkId: string, e: InboundEnvelope, now: number): Promise<void> {
  const who = e.actor!.external;
  const { pairing, fresh } = await store.pairingFor(
    { integrationId, adapter: who.adapter, externalId: who.id, name: who.name, linkId },
    () => pairingCode(crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH))), now);
  if (!fresh) return;
  const name = who.name ?? who.id;
  const source = { adapter: "orca", integrationId, linkId };
  await publish({
    key: `pairing:${pairing.code}:reply`, topic: "orca.message", at: now, source, text: pairingReply(pairing.code),
    ...(e.thread ? { thread: e.thread } : {}),
  }, now, [{ subscriptionId: null, target: {
    kind: "link", integrationId, adapter: e.source.adapter, linkId,
    externalId: e.source.channel ?? (await store.link(linkId))?.externalId ?? "", ...(e.thread ? { threadId: e.thread.externalId } : {}),
  } }]);
  await publish({
    key: `pairing:${pairing.code}`, topic: "orca.pairing.requested", at: now, source, actor: e.actor,
    title: `Pairing request from ${name}`, text: `${name} (${who.adapter}:${who.id}) wants to talk to Orca. Approve code ${pairing.code} to pair.`,
  }, now, [{ subscriptionId: null, target: { kind: "web" } }]);
}
