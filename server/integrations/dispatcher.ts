// One path out (docs/research/integrations.md §3.5). The primary bridge claims due `delivery` rows
// with FOR UPDATE SKIP LOCKED and hands each to its sink: an adapter's `send` for a link, the
// orchestrator's inbox, a workstream follow-up, or the web. A failure backs off (5 s, 30 s, 2 min,
// 10 min, 1 h, respecting retryAfterMs); after the sixth attempt the row is dead and
// `orca.integration.failed` is published (the web hears it as an `integration_failed` notification).
import { afterAttempt, clip, digestEnvelope, paceWait, type DeliveryTarget, type Envelope, type OutboundMessage, type SendResult, type TargetKind } from "../../shared/integrations";
import type { Adapter } from "./adapter";
import * as router from "./router";
import * as store from "./store";

export type Sinks = {
  /** A started adapter for an integration on this process, or undefined. */
  adapter(integrationId: string): Adapter | undefined;
  orchestrator?(e: Envelope): Promise<SendResult>;
  workstream?(repo: string, branch: string, e: Envelope): Promise<SendResult>;
  web?(e: Envelope): Promise<SendResult>;
  /** Whether this process serves a non-link kind now (the orchestrator lives on ONE instance). */
  serves?(kind: TargetKind): boolean;
  /** A delivery died: tell the web (wired to notify.emit in index.ts). */
  dead?(d: store.Delivery, error: string): Promise<void>;
};

export const DISPATCH_POLL_MS = 5_000; // the safety-net poll (§3.5 rule 6)
export const SEND_LEASE_MS = 120_000; // a claimed row is due again if its sender died
const BATCH = 20;

let sinks: Sinks = { adapter: () => undefined };
let timer: ReturnType<typeof setInterval> | undefined;
let busy: Promise<number> | undefined;
let again = false;

export function configure(s: Sinks): void { sinks = s; }

/** The non-link target kinds this process serves: those it has a sink for. */
const servedKinds = (): TargetKind[] => (["orchestrator", "workstream", "web"] as const).filter((k) => sinks[k] && (sinks.serves?.(k) ?? true));

/** The message an adapter renders for an event. */
export const outbound = (e: Envelope): OutboundMessage => ({
  text: e.text, topic: e.topic,
  ...(e.title ? { title: e.title } : {}), ...(e.link?.url ? { url: e.link.url } : {}),
  ...(e.thread?.messageId ? { replyToExternalMsgId: e.thread.messageId } : {}),
  ...(e.attachments?.length ? { attachments: e.attachments } : {}),
});

// Outbound pace per (integration, target), in memory: one dispatcher per instance.
const sentAt = new Map<string, number[]>();
export const resetPace = (): void => sentAt.clear();

async function sendOne(d: store.Delivery, now: number): Promise<SendResult | { deferUntil: number }> {
  const t: DeliveryTarget = d.target;
  try {
    if (t.kind === "link") {
      const a = sinks.adapter(t.integrationId);
      if (!a) return { ok: false, retryable: true, error: `integration ${t.integrationId} is not running on this bridge` };
      if (a.caps.rate) {
        const key = `${t.integrationId}:${t.externalId}`;
        const wait = paceWait(sentAt.get(key) ?? [], now, a.caps.rate.perTarget, a.caps.rate.windowMs);
        if (wait > 0) return { deferUntil: now + wait };
        sentAt.set(key, [...(sentAt.get(key) ?? []).filter((x) => now - x < a.caps.rate!.windowMs), now]);
      }
      const msg = outbound(d.envelope);
      const r = await a.send({ linkId: t.linkId, externalId: t.externalId, ...(t.threadId ? { threadId: t.threadId } : {}) }, { ...msg, text: clip(msg.text, a.caps.maxTextLength) }, String(d.id));
      // The first post about a workstream starts its thread on this link (§3.6): store it, so the
      // next post continues there and a reply in it reaches the workstream.
      const scope = d.envelope.scope;
      if (r.ok && r.threadId && !t.threadId && scope?.repo && scope.branch && a.caps.threads) {
        await store.setThreadLink({ adapter: t.adapter, externalThreadId: r.threadId, linkId: t.linkId, repo: scope.repo, branch: scope.branch });
      }
      return r;
    }
    const sink = t.kind === "workstream" ? sinks.workstream && ((e: Envelope) => sinks.workstream!(t.repo, t.branch, e)) : sinks[t.kind];
    if (!sink) return { ok: false, retryable: true, error: `no ${t.kind} sink on this bridge` };
    return await sink(d.envelope);
  } catch (e) {
    // A sink that throws is a bug or an outage, not a verdict: retry it.
    return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Claim and send every due delivery once. Returns how many were attempted. */
export async function dispatchOnce(now = Date.now()): Promise<number> {
  const running = [...new Set([...runningIds()])];
  const claimed = await store.claimDeliveries({ now, limit: BATCH, leaseMs: SEND_LEASE_MS, integrationIds: running, kinds: servedKinds() });
  // A digest's members go out as ONE send (§3.8): the rest of the window is claimed too, even when
  // the batch limit split it; the lowest id leads (its id is the idempotency key) and every member
  // takes the one result.
  const groups: store.Delivery[][] = [];
  const byDigest = new Map<string, store.Delivery[]>();
  for (const d of claimed) {
    if (!d.digestKey) { groups.push([d]); continue; }
    const g = byDigest.get(d.digestKey);
    if (g) g.push(d); else { const fresh = [d]; byDigest.set(d.digestKey, fresh); groups.push(fresh); }
  }
  for (const [key, g] of byDigest) g.push(...await store.claimDigest(key, now, SEND_LEASE_MS));
  for (const g of groups) {
    g.sort((a, b) => a.id - b.id);
    const lead = g[0]!;
    const one = g.length > 1 ? { ...lead, envelope: digestEnvelope(g.map((d) => d.envelope), lead.digestKey!) } : lead;
    const r = await sendOne(one, now);
    if ("deferUntil" in r) { for (const d of g) await store.deferDelivery(d.id, r.deferUntil); continue; }
    const next = afterAttempt(r, Math.max(...g.map((d) => d.attempts)), now);
    for (const d of g) await store.finishDelivery(d.id, { ...next, ...(r.ok ? { externalMsgId: r.externalMsgId } : { error: r.error }) });
    if (next.state === "dead") await died(one, r.ok ? "" : r.error);
  }
  return groups.reduce((n, g) => n + g.length, 0);
}

async function died(d: store.Delivery, error: string): Promise<void> {
  const where = d.target.kind === "link" ? `${d.target.adapter} ${d.target.externalId}` : d.target.kind;
  try {
    await router.publish({
      key: `delivery-dead:${d.id}`, topic: "orca.integration.failed", at: Date.now(), source: { adapter: "orca" },
      ...(d.envelope.scope ? { scope: d.envelope.scope } : {}),
      title: `Delivery to ${where} failed`, text: `${d.envelope.topic}: ${error || "failed"} (after ${d.attempts} attempts)`,
    });
    await sinks.dead?.(d, error);
  } catch (e) {
    console.error("orca: integration failure report failed", e);
  }
}

let runningIds: () => string[] = () => [];
/** The registry tells the dispatcher which integrations this process runs. */
export const setRunning = (fn: () => string[]): void => { runningIds = fn; };

/** Run a pass now (coalesced: a kick during a pass runs one more pass after it). */
export function kick(): void {
  if (!timer) return; // not started: this process does not dispatch
  if (busy) { again = true; return; }
  busy = dispatchOnce().catch((e) => { console.error("orca: delivery dispatch failed", e); return 0; })
    .finally(() => { busy = undefined; if (again) { again = false; kick(); } });
}

/** Start dispatching (the primary bridge only — index.ts wires it through primary.onPrimary). */
export function start(everyMs = DISPATCH_POLL_MS): void {
  if (timer) return;
  timer = setInterval(kick, everyMs);
  timer.unref?.();
  router.onPublished(kick);
  kick();
}

export async function stop(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  router.onPublished(() => {});
  await busy;
}
