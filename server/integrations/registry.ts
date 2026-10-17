// The adapter registry (docs/research/integrations.md §3.3, phase 1). A factory per kind; one running
// adapter per `integration` row. Adapters start ONLY on the primary bridge (primary.held()) of the
// instance the row names (`integration.instance`), so a socket is opened by exactly one process —
// Discord stays on the personal box, Slack on the work box, with the same code on both.
import * as db from "../db";
import * as primary from "../primary";
import { ORCA_SECRETS } from "../env";
import { secretRefRefusal, type AdapterKind, type AdapterMeta, type InboundEnvelope } from "../../shared/integrations";
import type { Adapter, AdapterContext, AdapterFactory, Connection } from "./adapter";
import * as router from "./router";
import * as store from "./store";
import { SLACK_CAPS, slackAdapter } from "./adapters/slack";
import { WEBHOOK_CAPS, webhookAdapter } from "./adapters/webhook";

const factories = new Map<AdapterKind, AdapterFactory>();
const metas = new Map<AdapterKind, AdapterMeta>();
const running = new Map<string, { adapter: Adapter; connection: Connection; abort: AbortController }>();

/** Register a kind. A later adapter (Discord, email, GitHub, Linear) adds one line here. `meta` is
 *  what Settings > Integrations shows for the kind (its card, its Connect form). */
export function register(kind: AdapterKind, factory: AdapterFactory, meta?: Omit<AdapterMeta, "kind">): void {
  factories.set(kind, factory);
  if (meta) metas.set(kind, { kind, ...meta });
}
register("slack", slackAdapter, { label: "Slack", caps: SLACK_CAPS, place: "channel", secretExample: "ORCA_SECRET_SLACK_BOT", help: "A bot token (xoxb-…). Invite the bot to each linked channel." });
register("webhook", webhookAdapter, { label: "Webhook", caps: WEBHOOK_CAPS, place: "hook", secretExample: "ORCA_SECRET_WEBHOOK", help: "Signed POSTs to /api/integrations/<id>/inbound (HMAC sha256 of the body)." });

/** Every registered kind with what the Settings page shows for it. A kind with no meta gets a plain one. */
export function kinds(): AdapterMeta[] {
  return [...factories.keys()].map((kind) => metas.get(kind) ?? {
    kind, label: kind, caps: { inbound: "none", outbound: true, threads: false, edits: false, reactions: false, attachments: false, maxTextLength: 4000 },
  });
}

/** Whether this process may run `c` now: enabled, on this instance, this process primary. */
export const runsHere = (c: Pick<Connection, "instance" | "enabled">, here = db.instanceName(), isPrimary = primary.held()): boolean =>
  isPrimary && c.enabled && c.instance === here;

export function context(connection: Connection, abort: AbortController): AdapterContext {
  return {
    connection,
    secret: () => (connection.secretRef ? process.env[connection.secretRef] : undefined) || undefined,
    ingest: (e: InboundEnvelope) => router.ingest(connection.id, e),
    cursor: { get: () => store.cursor(connection.id), set: (v) => store.setCursor(connection.id, v) },
    status: (s) => store.setIntegrationStatus(connection.id, { ...s, at: Date.now() }),
    log: (msg) => console.log(`orca: integration ${connection.kind}/${connection.id}: ${msg}`),
    signal: abort.signal,
  };
}

/** Start one connection, unless it is already running. A failed start is logged and recorded. */
export async function startOne(connection: Connection): Promise<boolean> {
  if (running.has(connection.id)) return true;
  const factory = factories.get(connection.kind);
  if (!factory) { console.error(`orca: integration ${connection.id}: no adapter for kind "${connection.kind}"`); return false; }
  const refusal = secretRefRefusal(connection.secretRef, ORCA_SECRETS);
  if (refusal) { console.error(`orca: integration ${connection.id}: ${refusal}`); return false; }
  const abort = new AbortController();
  const adapter = factory(connection);
  try {
    await adapter.start(context(connection, abort));
    running.set(connection.id, { adapter, connection, abort });
    await store.setIntegrationStatus(connection.id, { ok: true, startedAt: Date.now(), error: null }).catch(() => {});
    return true;
  } catch (e) {
    abort.abort();
    const error = e instanceof Error ? e.message : String(e);
    console.error(`orca: integration ${connection.id} did not start: ${error}`);
    await store.setIntegrationStatus(connection.id, { ok: false, error, at: Date.now() }).catch(() => {});
    return false;
  }
}

/** Start every enabled integration this instance runs, and stop any that no longer should (a row
 *  disabled, moved to another instance, or deleted). Idempotent: run it at startup and after a
 *  config change. A secondary bridge starts nothing. */
export async function sync(): Promise<string[]> {
  const mine = primary.held() ? (await store.integrations(db.instanceName())).filter((c) => runsHere(c)) : [];
  const want = new Set(mine.map((c) => c.id));
  for (const id of [...running.keys()]) if (!want.has(id)) await stopOne(id);
  for (const c of mine) await startOne(c);
  return [...running.keys()];
}

export async function stopOne(id: string): Promise<void> {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  r.abort.abort();
  await r.adapter.stop().catch((e) => console.error(`orca: integration ${id} stop failed`, e));
}

export async function stopAll(): Promise<void> {
  for (const id of [...running.keys()]) await stopOne(id);
}

/** The running adapter for an integration on this process (the dispatcher's link sink). */
export const adapterFor = (id: string): Adapter | undefined => running.get(id)?.adapter;
export const runningIds = (): string[] => [...running.keys()];

/** An HTTP request for `/api/integrations/<id>/inbound`. */
export async function handle(id: string, req: Request, body: string): Promise<Response> {
  const r = running.get(id);
  if (!r) {
    const row = await store.integration(id).catch(() => undefined);
    const where = row ? (row.instance !== db.instanceName() ? `it runs on ${row.instance}` : !row.enabled ? "it is disabled" : "it is not running on this bridge") : "no such integration";
    return Response.json({ error: `integration ${id}: ${where}` }, { status: 404 });
  }
  if (!r.adapter.handle) return Response.json({ error: `integration ${id} (${r.connection.kind}) takes no HTTP requests` }, { status: 405 });
  return r.adapter.handle(req, body);
}

/** Health of every integration this process runs (diagnostics, the later settings card). */
export async function health(): Promise<Record<string, { kind: string; ok: boolean; detail?: string; lastEventAt?: number }>> {
  const out: Record<string, { kind: string; ok: boolean; detail?: string; lastEventAt?: number }> = {};
  for (const [id, r] of running) {
    out[id] = { kind: r.connection.kind, ...(await r.adapter.health().catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }))) };
  }
  return out;
}
