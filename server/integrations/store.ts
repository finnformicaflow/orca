// Every SQL statement of the integrations layer (tables: server/db.ts step 20261017-integrations).
// Through db.withRetry like every other query, so a dropped connection is retried and an outage is
// db.DbUnavailable. Every row carries user_id (db.currentUser()).
import * as db from "../db";
import { digestWindow, PAIRING_TTL_MS, type DeliveryState, type DeliveryTarget, type Envelope, type Level, type PlannedDelivery, type Subscription, type TargetKind } from "../../shared/integrations";
import type { Connection } from "./adapter";

const user = () => db.currentUser();

// ── integration (credentials: a variable NAME only) ─────────────────────────────────────────────

type IntegrationRow = { id: string; kind: string; name: string; instance: string; config: Record<string, unknown> | null; secret_ref: string | null; enabled: boolean };
const toConnection = (r: IntegrationRow): Connection => ({
  id: r.id, kind: r.kind, name: r.name, instance: r.instance, config: r.config ?? {},
  ...(r.secret_ref ? { secretRef: r.secret_ref } : {}), enabled: r.enabled,
});

export async function addIntegration(c: Connection): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`
      INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, enabled, created_at)
      VALUES (${c.id}, ${user()}, ${c.kind}, ${c.name}, ${c.instance}, ${c.config}, ${c.secretRef ?? null}, ${c.enabled}, ${Date.now()})
      ON CONFLICT (user_id, id) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, instance = EXCLUDED.instance,
        config = EXCLUDED.config, secret_ref = EXCLUDED.secret_ref, enabled = EXCLUDED.enabled`;
  });
}

/** Every integration, or only those an instance runs. */
export async function integrations(instance?: string): Promise<Connection[]> {
  return db.withRetry(async (sql) => {
    const rows = instance === undefined
      ? await sql`SELECT id, kind, name, instance, config, secret_ref, enabled FROM integration WHERE user_id = ${user()} ORDER BY id`
      : await sql`SELECT id, kind, name, instance, config, secret_ref, enabled FROM integration WHERE user_id = ${user()} AND instance = ${instance} ORDER BY id`;
    return (rows as IntegrationRow[]).map(toConnection);
  });
}

export async function integration(id: string): Promise<Connection | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, kind, name, instance, config, secret_ref, enabled FROM integration WHERE user_id = ${user()} AND id = ${id}`;
    const r = (rows as IntegrationRow[])[0];
    return r ? toConnection(r) : undefined;
  });
}

export async function setIntegrationStatus(id: string, status: Record<string, unknown>): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`UPDATE integration SET status = COALESCE(status, '{}'::jsonb) || ${status}::jsonb WHERE user_id = ${user()} AND id = ${id}`;
  });
}

// ── channel_link, principal, identity ────────────────────────────────────────────────────────────

export type Link = { id: string; integrationId: string; externalId: string; label?: string; level: Exclude<Level, "full">; repos: string[]; requireMention: boolean };
type LinkRow = { id: string; integration_id: string; external_id: string; label: string | null; level: Link["level"]; repos: string[]; require_mention: boolean };
const toLink = (r: LinkRow): Link => ({
  id: r.id, integrationId: r.integration_id, externalId: r.external_id, ...(r.label ? { label: r.label } : {}),
  level: r.level, repos: r.repos ?? [], requireMention: r.require_mention,
});

export async function addLink(l: Link): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`
      INSERT INTO channel_link (id, user_id, integration_id, external_id, label, level, repos, require_mention)
      VALUES (${l.id}, ${user()}, ${l.integrationId}, ${l.externalId}, ${l.label ?? null}, ${l.level}, ${sql.array(l.repos, "TEXT")}, ${l.requireMention})
      ON CONFLICT (user_id, id) DO UPDATE SET external_id = EXCLUDED.external_id, label = EXCLUDED.label,
        level = EXCLUDED.level, repos = EXCLUDED.repos, require_mention = EXCLUDED.require_mention`;
  });
}

export async function links(): Promise<Link[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, integration_id, external_id, label, level, repos, require_mention FROM channel_link WHERE user_id = ${user()}`;
    return (rows as LinkRow[]).map(toLink);
  });
}

export async function link(id: string): Promise<Link | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, integration_id, external_id, label, level, repos, require_mention FROM channel_link WHERE user_id = ${user()} AND id = ${id}`;
    const r = (rows as LinkRow[])[0];
    return r ? toLink(r) : undefined;
  });
}

/** The link for an external place on one integration (a Slack channel id, a mailbox). */
export async function linkFor(integrationId: string, externalId: string): Promise<Link | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, integration_id, external_id, label, level, repos, require_mention FROM channel_link
      WHERE user_id = ${user()} AND integration_id = ${integrationId} AND external_id = ${externalId}`;
    const r = (rows as LinkRow[])[0];
    return r ? toLink(r) : undefined;
  });
}

export type Principal = { id: string; name: string; maxLevel: Exclude<Level, "full"> };

export async function addPrincipal(p: Principal, identities: { adapter: string; externalId: string }[] = []): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql.begin(async (tx: Bun.SQL) => {
      await tx`INSERT INTO principal (id, user_id, name, max_level) VALUES (${p.id}, ${user()}, ${p.name}, ${p.maxLevel})
        ON CONFLICT (user_id, id) DO UPDATE SET name = EXCLUDED.name, max_level = EXCLUDED.max_level`;
      for (const i of identities) {
        await tx`INSERT INTO identity (user_id, adapter, external_id, principal_id) VALUES (${user()}, ${i.adapter}, ${i.externalId}, ${p.id})
          ON CONFLICT (user_id, adapter, external_id) DO UPDATE SET principal_id = EXCLUDED.principal_id`;
      }
    });
  });
}

/** The paired person behind a platform user, or undefined (unknown senders get nothing inbound). */
export async function principalFor(adapter: string, externalId: string): Promise<Principal | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`
      SELECT p.id, p.name, p.max_level FROM identity i JOIN principal p ON p.user_id = i.user_id AND p.id = i.principal_id
      WHERE i.user_id = ${user()} AND i.adapter = ${adapter} AND i.external_id = ${externalId}`;
    const r = (rows as { id: string; name: string; max_level: Principal["maxLevel"] }[])[0];
    return r ? { id: r.id, name: r.name, maxLevel: r.max_level } : undefined;
  });
}

// ── subscription ─────────────────────────────────────────────────────────────────────────────────

export async function addSubscription(s: Omit<Subscription, "id">): Promise<number> {
  return db.withRetry(async (sql) => {
    const rows = await sql`
      INSERT INTO subscription (user_id, topic_pattern, filter, target_kind, target_id, digest_seconds)
      VALUES (${user()}, ${s.topicPattern}, ${s.filter}, ${s.targetKind}, ${s.targetId ?? null}, ${s.digestSeconds ?? null})
      RETURNING id`;
    return Number(rows[0].id);
  });
}

export async function removeSubscription(id: number): Promise<void> {
  return db.withRetry(async (sql) => { await sql`DELETE FROM subscription WHERE user_id = ${user()} AND id = ${id}`; });
}

export async function subscriptions(): Promise<Subscription[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT id, topic_pattern, filter, target_kind, target_id, digest_seconds FROM subscription
      WHERE user_id = ${user()} AND enabled ORDER BY id`;
    return (rows as { id: number; topic_pattern: string; filter: Record<string, string> | null; target_kind: TargetKind; target_id: string | null; digest_seconds: number | null }[])
      .map((r) => ({
        id: Number(r.id), topicPattern: r.topic_pattern, filter: r.filter ?? {}, targetKind: r.target_kind,
        ...(r.target_id ? { targetId: r.target_id } : {}), ...(r.digest_seconds ? { digestSeconds: r.digest_seconds } : {}),
      }));
  });
}

// ── thread_link (external thread ↔ workstream) ───────────────────────────────────────────────────

export type ThreadLink = { adapter: string; externalThreadId: string; linkId?: string; repo: string; branch: string };

/** Bind an external thread to a workstream. A thread is bound once: a second bind is ignored. */
export async function setThreadLink(t: ThreadLink): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`INSERT INTO thread_link (user_id, adapter, external_thread_id, link_id, repo, branch, created_at)
      VALUES (${user()}, ${t.adapter}, ${t.externalThreadId}, ${t.linkId ?? null}, ${t.repo}, ${t.branch}, ${Date.now()})
      ON CONFLICT (user_id, adapter, external_thread_id) DO NOTHING`;
  });
}

/** The workstream an inbound thread belongs to. */
export async function threadLink(adapter: string, externalThreadId: string): Promise<ThreadLink | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT adapter, external_thread_id, link_id, repo, branch FROM thread_link
      WHERE user_id = ${user()} AND adapter = ${adapter} AND external_thread_id = ${externalThreadId}`;
    const r = (rows as { adapter: string; external_thread_id: string; link_id: string | null; repo: string; branch: string }[])[0];
    return r ? { adapter: r.adapter, externalThreadId: r.external_thread_id, ...(r.link_id ? { linkId: r.link_id } : {}), repo: r.repo, branch: r.branch } : undefined;
  });
}

/** link id → thread id for one workstream: where an outbound post about it continues. */
export async function threadsForWorkstream(repo: string, branch: string): Promise<Map<string, string>> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT link_id, external_thread_id FROM thread_link
      WHERE user_id = ${user()} AND repo = ${repo} AND branch = ${branch} AND link_id IS NOT NULL ORDER BY created_at`;
    return new Map((rows as { link_id: string; external_thread_id: string }[]).map((r) => [r.link_id, r.external_thread_id]));
  });
}

// ── integration_cursor ───────────────────────────────────────────────────────────────────────────

export async function cursor(integrationId: string): Promise<string | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT value FROM integration_cursor WHERE user_id = ${user()} AND integration_id = ${integrationId}`;
    return (rows as { value: string }[])[0]?.value;
  });
}

export async function setCursor(integrationId: string, value: string): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`INSERT INTO integration_cursor (user_id, integration_id, value, updated_at) VALUES (${user()}, ${integrationId}, ${value}, ${Date.now()})
      ON CONFLICT (user_id, integration_id) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
  });
}

// ── event + delivery ─────────────────────────────────────────────────────────────────────────────

export type { PlannedDelivery } from "../../shared/integrations";

/** Record one event and its deliveries in ONE transaction (§3.5 rules 1-2). A known key inserts
 *  nothing and returns "duplicate", so a platform retry, a Gateway resume or a poll overlap is one
 *  event with one set of deliveries. */
export async function recordEvent(e: Envelope, planned: PlannedDelivery[], now = Date.now()): Promise<{ status: "new" | "duplicate"; deliveries: number[] }> {
  return db.withRetry(async (sql) => {
    let out: { status: "new" | "duplicate"; deliveries: number[] } = { status: "duplicate", deliveries: [] };
    await sql.begin(async (tx: Bun.SQL) => {
      const ins = await tx`INSERT INTO event (id, user_id, key, topic, envelope, created_at)
        VALUES (${e.id}, ${user()}, ${e.key}, ${e.topic}, ${e as unknown as Record<string, unknown>}, ${now})
        ON CONFLICT (user_id, key) DO NOTHING RETURNING id`;
      if (!ins.length) { out = { status: "duplicate", deliveries: [] }; return; }
      const ids: number[] = [];
      for (const d of planned) {
        // A digest subscription's delivery waits for its window's end, keyed with its siblings.
        const digest = d.digestSeconds && d.subscriptionId != null ? digestWindow(d.subscriptionId, d.digestSeconds, now) : undefined;
        const rows = await tx`INSERT INTO delivery (user_id, event_id, subscription_id, target, next_at, created_at, digest_key)
          VALUES (${user()}, ${e.id}, ${d.subscriptionId}, ${d.target as unknown as Record<string, unknown>}, ${digest?.nextAt ?? now}, ${now}, ${digest?.key ?? null})
          ON CONFLICT (event_id, subscription_id) DO NOTHING RETURNING id`;
        if (rows.length) ids.push(Number(rows[0].id));
      }
      out = { status: "new", deliveries: ids };
    });
    return out;
  });
}

export async function event(key: string): Promise<Envelope | undefined> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT envelope FROM event WHERE user_id = ${user()} AND key = ${key}`;
    return (rows as { envelope: Envelope }[])[0]?.envelope;
  });
}

export type Delivery = {
  id: number; eventId: string; subscriptionId?: number; target: DeliveryTarget; state: DeliveryState;
  attempts: number; nextAt: number; lastError?: string; externalMsgId?: string; envelope: Envelope;
  digestKey?: string;
};
type DeliveryRow = { id: number; event_id: string; subscription_id: number | null; target: DeliveryTarget; state: DeliveryState; attempts: number; next_at: number; last_error: string | null; external_msg_id: string | null; envelope: Envelope; digest_key?: string | null };
const toDelivery = (r: DeliveryRow): Delivery => ({
  id: Number(r.id), eventId: r.event_id, ...(r.subscription_id != null ? { subscriptionId: Number(r.subscription_id) } : {}),
  target: r.target, state: r.state, attempts: Number(r.attempts), nextAt: Number(r.next_at),
  ...(r.last_error ? { lastError: r.last_error } : {}), ...(r.external_msg_id ? { externalMsgId: r.external_msg_id } : {}), envelope: r.envelope,
  ...(r.digest_key ? { digestKey: r.digest_key } : {}),
});

/** Claim due deliveries (§3.5 rule 3): FOR UPDATE SKIP LOCKED, so two dispatchers never take one
 *  row. A claimed row is `sending` with a lease (`next_at` = now + leaseMs): a dispatcher that dies
 *  mid-send leaves it due again when the lease ends. `integrationIds` are the link targets this
 *  process can send to (its started adapters); `kinds` the non-link targets it serves. */
export async function claimDeliveries(opts: { now: number; limit: number; leaseMs: number; integrationIds: string[]; kinds: TargetKind[] }): Promise<Delivery[]> {
  return db.withRetry(async (sql) => {
    const ids = opts.integrationIds.length ? opts.integrationIds : [""];
    const kinds = opts.kinds.length ? opts.kinds : [""];
    const rows = await sql`
      UPDATE delivery d SET state = 'sending', attempts = d.attempts + 1, next_at = ${opts.now + opts.leaseMs}
      FROM event e
      WHERE e.id = d.event_id AND d.id IN (
        SELECT id FROM delivery
        WHERE user_id = ${user()} AND state IN ('pending', 'sending', 'failed') AND next_at <= ${opts.now}
          AND ((target->>'kind' = 'link' AND target->>'integrationId' IN ${sql(ids)}) OR (target->>'kind' <> 'link' AND target->>'kind' IN ${sql(kinds)}))
        ORDER BY next_at, id LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.event_id, d.subscription_id, d.target, d.state, d.attempts, d.next_at, d.last_error, d.external_msg_id, d.digest_key, e.envelope`;
    return (rows as DeliveryRow[]).map(toDelivery);
  });
}

/** The rest of a digest (same key) not yet claimed: claimed now, so its window goes out as ONE send
 *  even when the batch limit split it. */
export async function claimDigest(key: string, now: number, leaseMs: number): Promise<Delivery[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`
      UPDATE delivery d SET state = 'sending', attempts = d.attempts + 1, next_at = ${now + leaseMs}
      FROM event e
      WHERE e.id = d.event_id AND d.id IN (
        SELECT id FROM delivery WHERE user_id = ${user()} AND digest_key = ${key} AND state IN ('pending', 'failed')
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id, d.event_id, d.subscription_id, d.target, d.state, d.attempts, d.next_at, d.last_error, d.external_msg_id, d.digest_key, e.envelope`;
    return (rows as DeliveryRow[]).map(toDelivery);
  });
}

/** Record the outcome of one attempt. `externalMsgId` is stored as soon as it is known (§3.5 rule 5). */
export async function finishDelivery(id: number, r: { state: DeliveryState; nextAt: number; error?: string; externalMsgId?: string }): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`UPDATE delivery SET state = ${r.state}, next_at = ${r.nextAt}, last_error = ${r.error ?? null},
      external_msg_id = COALESCE(${r.externalMsgId ?? null}, external_msg_id)
      WHERE user_id = ${user()} AND id = ${id}`;
  });
}

/** Put a claimed row back without spending an attempt (the outbound pace said wait). */
export async function deferDelivery(id: number, nextAt: number): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`UPDATE delivery SET state = 'pending', attempts = GREATEST(attempts - 1, 0), next_at = ${nextAt} WHERE user_id = ${user()} AND id = ${id}`;
  });
}

/** Deliveries, newest first (diagnostics, the later dead-letter card, tests). */
export async function deliveries(opts: { state?: DeliveryState; limit?: number } = {}): Promise<Delivery[]> {
  return db.withRetry(async (sql) => {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = opts.state
      ? await sql`SELECT d.id, d.event_id, d.subscription_id, d.target, d.state, d.attempts, d.next_at, d.last_error, d.external_msg_id, d.digest_key, e.envelope
          FROM delivery d JOIN event e ON e.id = d.event_id WHERE d.user_id = ${user()} AND d.state = ${opts.state} ORDER BY d.id DESC LIMIT ${limit}`
      : await sql`SELECT d.id, d.event_id, d.subscription_id, d.target, d.state, d.attempts, d.next_at, d.last_error, d.external_msg_id, d.digest_key, e.envelope
          FROM delivery d JOIN event e ON e.id = d.event_id WHERE d.user_id = ${user()} ORDER BY d.id DESC LIMIT ${limit}`;
    return (rows as DeliveryRow[]).map(toDelivery);
  });
}

/** Dead deliveries back to pending (the later "Retry all" button). */
export async function retryDead(now = Date.now()): Promise<number> {
  return db.withRetry(async (sql) => {
    const rows = await sql`UPDATE delivery SET state = 'pending', attempts = 0, next_at = ${now} WHERE user_id = ${user()} AND state = 'dead' RETURNING id`;
    return rows.length;
  });
}

/** Drop events past retention (deliveries go with them). Raw payloads are debug data only. */
export const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;
export async function pruneEvents(now = Date.now()): Promise<void> {
  return db.withRetry(async (sql) => {
    await sql`DELETE FROM event WHERE user_id = ${user()} AND created_at < ${now - EVENT_RETENTION_MS}
      AND NOT EXISTS (SELECT 1 FROM delivery d WHERE d.event_id = event.id AND d.state IN ('pending', 'sending', 'failed'))`;
  });
}

// ── pairing_code ─────────────────────────────────────────────────────────────────────────────────

export type Pairing = {
  code: string; integrationId: string; adapter: string; externalId: string; name?: string; linkId?: string;
  createdAt: number; expiresAt: number; state: "pending" | "approved" | "denied"; principalId?: string;
};
type PairingRow = { code: string; integration_id: string; adapter: string; external_id: string; name: string | null; link_id: string | null; created_at: number; expires_at: number; state: Pairing["state"]; principal_id: string | null };
const toPairing = (r: PairingRow): Pairing => ({
  code: r.code, integrationId: r.integration_id, adapter: r.adapter, externalId: r.external_id,
  ...(r.name ? { name: r.name } : {}), ...(r.link_id ? { linkId: r.link_id } : {}),
  createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), state: r.state, ...(r.principal_id ? { principalId: r.principal_id } : {}),
});

/** The sender's live pending code, or a new one. `fresh` says whether it was just made (only a new
 *  code is sent to the sender, so a chatty stranger gets one reply per hour, not one per message). */
export async function pairingFor(p: { integrationId: string; adapter: string; externalId: string; name?: string; linkId?: string }, newCode: () => string, now = Date.now()): Promise<{ pairing: Pairing; fresh: boolean }> {
  return db.withRetry(async (sql) => {
    const live = await sql`SELECT code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id FROM pairing_code
      WHERE user_id = ${user()} AND adapter = ${p.adapter} AND external_id = ${p.externalId} AND state = 'pending' AND expires_at > ${now}
      ORDER BY created_at DESC LIMIT 1`;
    if (live.length) return { pairing: toPairing((live as PairingRow[])[0]!), fresh: false };
    for (let i = 0; i < 5; i++) {
      const rows = await sql`INSERT INTO pairing_code (user_id, code, integration_id, adapter, external_id, name, link_id, created_at, expires_at)
        VALUES (${user()}, ${newCode()}, ${p.integrationId}, ${p.adapter}, ${p.externalId}, ${p.name ?? null}, ${p.linkId ?? null}, ${now}, ${now + PAIRING_TTL_MS})
        ON CONFLICT (user_id, code) DO NOTHING
        RETURNING code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id`;
      if (rows.length) return { pairing: toPairing((rows as PairingRow[])[0]!), fresh: true };
    }
    throw new Error("could not make a unique pairing code");
  });
}

/** Pending, unexpired codes, newest first (the API now, the Settings page later). */
export async function pendingPairings(now = Date.now()): Promise<Pairing[]> {
  return db.withRetry(async (sql) => {
    const rows = await sql`SELECT code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id FROM pairing_code
      WHERE user_id = ${user()} AND state = 'pending' AND expires_at > ${now} ORDER BY created_at DESC`;
    return (rows as PairingRow[]).map(toPairing);
  });
}

/** Approve a code: in one transaction, make the principal (or reuse one: an id that exists keeps its
 *  name and level unless given) and bind the sender's identity to it. A new principal defaults to
 *  the sender's display name and "ask". Refuses an unknown, used or expired code. */
export async function approvePairing(code: string, principal: { id: string; name?: string; maxLevel?: Exclude<Level, "full"> }, now = Date.now()): Promise<Pairing> {
  return db.withRetry(async (sql) => {
    let out: Pairing | undefined;
    await sql.begin(async (tx: Bun.SQL) => {
      const rows = await tx`SELECT code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id FROM pairing_code
        WHERE user_id = ${user()} AND code = ${code.trim().toUpperCase()} FOR UPDATE`;
      const p = (rows as PairingRow[])[0];
      if (!p) throw new Error(`no pairing code ${code}`);
      if (p.state !== "pending") throw new Error(`pairing code ${code} is already ${p.state}`);
      if (Number(p.expires_at) <= now) throw new Error(`pairing code ${code} has expired; ask the sender to write again for a new one`);
      await tx`INSERT INTO principal (id, user_id, name, max_level)
        VALUES (${principal.id}, ${user()}, ${principal.name ?? p.name ?? p.external_id}, ${principal.maxLevel ?? "ask"})
        ON CONFLICT (user_id, id) DO UPDATE SET name = COALESCE(${principal.name ?? null}::text, principal.name),
          max_level = COALESCE(${principal.maxLevel ?? null}::text, principal.max_level)`;
      await tx`INSERT INTO identity (user_id, adapter, external_id, principal_id) VALUES (${user()}, ${p.adapter}, ${p.external_id}, ${principal.id})
        ON CONFLICT (user_id, adapter, external_id) DO UPDATE SET principal_id = EXCLUDED.principal_id`;
      const done = await tx`UPDATE pairing_code SET state = 'approved', principal_id = ${principal.id}, decided_at = ${now}
        WHERE user_id = ${user()} AND code = ${p.code}
        RETURNING code, integration_id, adapter, external_id, name, link_id, created_at, expires_at, state, principal_id`;
      out = toPairing((done as PairingRow[])[0]!);
    });
    return out!;
  });
}

export async function denyPairing(code: string, now = Date.now()): Promise<boolean> {
  return db.withRetry(async (sql) => {
    const rows = await sql`UPDATE pairing_code SET state = 'denied', decided_at = ${now}
      WHERE user_id = ${user()} AND code = ${code.trim().toUpperCase()} AND state = 'pending' RETURNING code`;
    return rows.length > 0;
  });
}
