// One path in (docs/research/integrations.md §3.1, §3.5). `ingest` is an adapter's door: dedupe,
// gate the sender against its link (§3.7), then `publish`. `publish` is everyone's: record the event
// once by its key and plan its deliveries in the same transaction, then kick the dispatcher.
import { randomUUID } from "crypto";
import { effectiveGrant, INBOUND_LIMIT, paceWait, planDeliveries, type Envelope, type Grant, type InboundEnvelope } from "../../shared/integrations";
import * as store from "./store";

/** Orca's own id: time-ordered, so `ORDER BY id` is arrival order. */
export const newEventId = (now = Date.now()): string => `${now.toString(36).padStart(9, "0")}-${randomUUID().slice(0, 12)}`;

type Kick = () => void;
let kick: Kick = () => {};
/** The dispatcher registers itself here (§3.5 rule 6: kick in-process after each insert). */
export const onPublished = (fn: Kick): void => { kick = fn; };

/** Record one event and route it. Idempotent on `key`. `grant` is set by `ingest` only; absent =
 *  Orca's own event, with the full grant. */
export async function publish(input: InboundEnvelope & { grant?: Grant }, now = Date.now()): Promise<{ status: "new" | "duplicate"; id: string; deliveries: number[] }> {
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
  const planned = planDeliveries(e, subs, links, threads, inbound);
  const r = await store.recordEvent(e, planned, now);
  if (r.status === "new" && r.deliveries.length) kick();
  return { ...r, id: e.id };
}

// Inbound pace per sender (§3.8): in memory, per process — one primary runs the adapters.
const recent = new Map<string, number[]>();

/** Reset the inbound pace (tests). */
export const resetPace = (): void => recent.clear();

/** The core's half of `ctx.ingest`. */
export async function ingest(integrationId: string, e: InboundEnvelope, now = Date.now()): Promise<"new" | "duplicate" | "rejected"> {
  // Dedupe first, so a platform retry of an accepted event is "duplicate", never a second pace hit.
  if (await store.event(e.key)) return "duplicate";
  const link = e.source.linkId ? await store.link(e.source.linkId)
    : e.source.channel ? await store.linkFor(integrationId, e.source.channel) : undefined;
  if (!link || link.integrationId !== integrationId) return "rejected"; // no link = nobody said Orca may listen here
  if (link.requireMention && e.mentioned === false) return "rejected";
  const who = `${integrationId}:${e.actor?.external.id ?? link.id}`;
  const times = recent.get(who) ?? [];
  if (paceWait(times, now, INBOUND_LIMIT.count, INBOUND_LIMIT.windowMs) > 0) return "rejected";
  recent.set(who, [...times.filter((t) => now - t < INBOUND_LIMIT.windowMs), now]);
  // A person is gated on who they are (an unknown sender gets nothing until paired); a sender with no
  // person behind it (a webhook, a poller) is authenticated by its integration and takes the link's level.
  const grant: Grant = e.actor
    ? effectiveGrant(link, await store.principalFor(e.actor.external.adapter, e.actor.external.id))
    : { level: link.level, repos: link.repos, linkId: link.id };
  if (grant.level === "notify") return "rejected";
  const principalId = grant.principalId;
  const r = await publish({
    ...e, source: { ...e.source, integrationId, linkId: link.id },
    ...(e.actor && principalId ? { actor: { ...e.actor, principalId } } : {}),
    grant,
  }, now);
  return r.status;
}
