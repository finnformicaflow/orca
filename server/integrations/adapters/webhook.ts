// The generic webhook adapter (docs/research/integrations.md §5). Inbound: a script (repo-watch, a
// relay such as Hookdeck) POSTs JSON to `/api/integrations/<id>/inbound`, signed with the hook's
// secret: `x-orca-signature: sha256=<hex HMAC-SHA256 of the raw body>`. The body becomes an
// `ext.webhook.message` (or the `topic` it names) and goes through the core's gate and router like
// any other inbound event — the orchestrator by default. This replaces the unauthenticated
// `POST /api/orchestrator/event` for scripts; that route stays as an alias for instance-to-instance
// worker reports. Outbound: a delivery to a link whose external id is a URL is POSTed there as JSON,
// signed the same way, with the delivery id as `x-orca-delivery` (the receiver's idempotency key).
import { createHmac, createHash, timingSafeEqual } from "crypto";
import type { Adapter, AdapterContext, Connection } from "../adapter";
import type { Capabilities, InboundEnvelope, OutboundMessage, SendResult, Target, Topic } from "../../../shared/integrations";

export const sign = (secret: string, body: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** Constant-time check of a signature header. */
export function verify(secret: string, body: string, header: string | null): boolean {
  if (!secret || !header) return false;
  const want = Buffer.from(sign(secret, body)), got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const WEBHOOK_CAPS: Capabilities = {
  inbound: "relay", outbound: true, threads: false, edits: false, reactions: false, attachments: false, maxTextLength: 100_000,
};

/** The inbound body a script sends. Only `text` is required. */
export type WebhookBody = { text: string; key?: string; title?: string; topic?: string; repo?: string; branch?: string; url?: string; channel?: string };

/** The envelope for one inbound body. The key is the sender's `key`, else the body's hash, so a
 *  script that retries the same POST is one event. */
export function webhookEnvelope(connection: Connection, body: WebhookBody, raw: string, at = Date.now()): InboundEnvelope {
  const topic: Topic = typeof body.topic === "string" && /^ext\.webhook\.[a-z0-9_]+$/.test(body.topic) ? (body.topic as Topic) : "ext.webhook.message";
  return {
    key: `webhook:${connection.id}:${body.key ? String(body.key) : createHash("sha256").update(raw).digest("hex").slice(0, 32)}`,
    topic, at,
    source: { adapter: "webhook", integrationId: connection.id, channel: typeof body.channel === "string" ? body.channel : String(connection.config.channel ?? "inbound") },
    ...(body.repo ? { scope: { repo: String(body.repo), ...(body.branch ? { branch: String(body.branch) } : {}) } } : {}),
    text: String(body.text),
    ...(body.title ? { title: String(body.title) } : {}),
    ...(body.url ? { link: { url: String(body.url) } } : {}),
  };
}

export function webhookAdapter(connection: Connection): Adapter {
  let ctx: AdapterContext | undefined;
  let lastEventAt: number | undefined;
  const secret = () => ctx?.secret() ?? (connection.secretRef ? process.env[connection.secretRef] : undefined) ?? "";
  return {
    kind: "webhook",
    caps: WEBHOOK_CAPS,
    async start(c) { ctx = c; },
    async stop() { ctx = undefined; },
    async handle(req: Request, raw: string): Promise<Response> {
      const json = (data: unknown, status = 200) => Response.json(data, { status });
      if (!ctx) return json({ error: "integration not started" }, 503);
      if (!secret()) return json({ error: `${connection.secretRef ?? "the secret variable"} is not set on this instance` }, 503);
      if (!verify(secret(), raw, req.headers.get("x-orca-signature"))) return json({ error: "bad signature" }, 401);
      let body: WebhookBody;
      try { body = JSON.parse(raw); } catch { return json({ error: "body must be JSON" }, 400); }
      if (typeof body?.text !== "string" || !body.text.trim()) return json({ error: "text required" }, 400);
      const status = await ctx.ingest(webhookEnvelope(connection, body, raw));
      lastEventAt = Date.now();
      return json({ status }, status === "rejected" ? 403 : 200);
    },
    async send(target: Target, msg: OutboundMessage, key: string): Promise<SendResult> {
      const body = JSON.stringify({ key, topic: msg.topic, title: msg.title, text: msg.text, url: msg.url });
      try {
        const res = await fetch(target.externalId, {
          method: "POST",
          headers: { "content-type": "application/json", "x-orca-delivery": key, ...(secret() ? { "x-orca-signature": sign(secret(), body) } : {}) },
          body,
        });
        if (res.ok) return { ok: true };
        const retry = Number(res.headers.get("retry-after"));
        return { ok: false, retryable: res.status === 429 || res.status >= 500, ...(retry > 0 ? { retryAfterMs: retry * 1000 } : {}), error: `http ${res.status}` };
      } catch (e) {
        return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async health() {
      return secret() ? { ok: true, ...(lastEventAt ? { lastEventAt } : {}) } : { ok: false, detail: `${connection.secretRef ?? "secret"} is not set` };
    },
  };
}
