// The web adapter: Orca's own UI as a target (docs/research/integrations.md §3.5 `web`). It wraps what
// exists. Inbound is the chat's `/api/orchestrator/message` (you, full grant — unchanged). Outbound is
// a notification row plus a bus push (notify.emit), keyed by the event's key: an Orca event already
// shown (notify.emit wrote it) dedupes to nothing, and an outside message or a dead delivery becomes
// a row in the bell's centre.
import type { Adapter } from "../adapter";
import type { Capabilities, DeliveryTarget, Envelope, SendResult } from "../../../shared/integrations";
import type { NotificationInput } from "../../../shared/notifications";

export const WEB_CAPS: Capabilities = { inbound: "none", outbound: true, threads: false, edits: false, reactions: false, attachments: false, maxTextLength: 10_000 };

/** The notification an event shows as in the web. */
export function webNotification(e: Pick<Envelope, "key" | "topic" | "scope" | "title" | "text" | "actor" | "link" | "source">): NotificationInput {
  const sender = e.actor?.external.name ?? e.actor?.external.id;
  return {
    key: e.key,
    kind: e.topic === "orca.integration.failed" ? "integration_failed" : "external_message",
    repo: e.scope?.repo ?? "", ...(e.scope?.branch ? { branch: e.scope.branch } : {}),
    title: e.title ?? (sender ? `${sender} via ${e.source.adapter}` : e.source.adapter),
    body: e.text.replace(/\s+/g, " ").trim().slice(0, 140),
    ...(e.link ? { link: e.link } : {}),
  };
}

/** `emit` is notify.emit, passed in so this module needs no database or bus of its own. */
export function webAdapter(emit: (n: NotificationInput) => Promise<unknown>): Adapter & { deliver(e: Envelope): Promise<SendResult> } {
  const deliver = async (e: Envelope): Promise<SendResult> => { await emit(webNotification(e)); return { ok: true }; };
  return {
    kind: "web",
    caps: WEB_CAPS,
    async start() {},
    async stop() {},
    deliver,
    async send(_t, msg, key) {
      return deliver({ id: key, key: `web:${key}`, topic: msg.topic ?? "ext.web.message", at: Date.now(), source: { adapter: "web" }, title: msg.title, text: msg.text, ...(msg.url ? { link: { url: msg.url } } : {}) });
    },
    async health() { return { ok: true }; },
  };
}

/** The bell's row for a dead delivery. Its key is the `orca.integration.failed` event's, so the
 *  event and the row are one thing. */
export function deadNotification(d: { id: number; attempts: number; target: DeliveryTarget; envelope: Pick<Envelope, "topic" | "scope"> }, error: string): NotificationInput {
  const where = d.target.kind === "link" ? `${d.target.adapter} ${d.target.externalId}` : d.target.kind;
  return webNotification({
    key: `delivery-dead:${d.id}`, topic: "orca.integration.failed", source: { adapter: "orca" },
    ...(d.envelope.scope ? { scope: d.envelope.scope } : {}),
    title: `Delivery to ${where} failed`, text: `${d.envelope.topic}: ${error || "failed"} (after ${d.attempts} attempts)`,
  });
}
