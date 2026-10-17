// The Adapter contract (docs/research/integrations.md §3.3; how to write one: docs/integrations/
// ADAPTERS.md). One adapter per platform. The core owns everything else — dedupe, the permission
// gate, routing, the durable outbox, retry, threads — so an adapter only speaks its platform.
import type { AdapterKind, Capabilities, InboundEnvelope, OutboundMessage, SendResult, Target } from "../../shared/integrations";
export type { AdapterKind, Capabilities, InboundEnvelope, OutboundMessage, SendResult, Target } from "../../shared/integrations";

/** One `integration` row: an account, bot, mailbox or hook. Credentials are NOT on it — `secret()`
 *  reads the environment variable its `secretRef` names, so no token is ever stored or logged. */
export type Connection = {
  id: string;
  kind: AdapterKind;
  name: string;
  instance: string; // the ONE instance that runs it
  config: Record<string, unknown>; // the platform's non-secret settings (team id, mailbox, poll interval…)
  secretRef?: string; // an environment variable name: ORCA_SECRET_* or one of server/env.ts ORCA_SECRETS
  enabled: boolean;
};

/** What the core hands an adapter at start. */
export type AdapterContext = {
  connection: Connection;
  /** The token, from the environment; undefined when unset. Never pass it to an agent or a log. */
  secret(): string | undefined;
  /** Hand one inbound event to the core: dedupe on `key`, gate the sender, record, route.
   *  "duplicate" = seen before (a retry or a reconnect); "rejected" = the gate dropped it. */
  ingest(e: InboundEnvelope): Promise<"new" | "duplicate" | "rejected">;
  /** A poller's position (a timestamp, an ETag, an IMAP UID). Stored per integration. */
  cursor: { get(): Promise<string | undefined>; set(v: string): Promise<void> };
  /** Record health for the settings card (merged into `integration.status`). */
  status(s: { ok: boolean; detail?: string; lastEventAt?: number }): Promise<void>;
  log(msg: string): void;
  /** Aborted at stop: a socket or a poll loop ends when it fires. */
  signal: AbortSignal;
};

export interface Adapter {
  readonly kind: AdapterKind;
  readonly caps: Capabilities;
  /** Open sockets or start pollers. Called on the primary bridge of `connection.instance` only.
   *  Resolve when ready; keep a loop alive with `ctx.signal`, never by holding this promise. */
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  /** Render and send one delivery. Must be safe to call twice with the same `idempotencyKey` (the
   *  delivery id): email uses it as the Message-ID, a chat adapter returns `externalMsgId` so the
   *  core stores it before any retry. Never throw for a platform error: return `ok: false`. */
  send(target: Target, msg: OutboundMessage, idempotencyKey: string): Promise<SendResult>;
  /** A cheap live check for the settings card and its Test button. */
  health(): Promise<{ ok: boolean; detail?: string; lastEventAt?: number }>;
  /** A platform user's display name and stable id (pairing). */
  resolveUser?(externalId: string): Promise<{ id: string; name: string } | undefined>;
  /** An HTTP request routed to this integration (`/api/integrations/<id>/inbound`): webhooks, a
   *  relay's push, an OAuth callback. Only for `caps.inbound === "relay"`. */
  handle?(req: Request, body: string): Promise<Response>;
}

/** Builds an adapter for one connection. Registered per kind (server/integrations/registry.ts). */
export type AdapterFactory = (connection: Connection) => Adapter;
