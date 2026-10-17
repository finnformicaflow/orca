// The Slack adapter (docs/research/integrations.md §5, setup: docs/integrations/slack.md).
// OUTBOUND: `chat.postMessage` / `chat.update`. The old one Slack path stays as is: `postMessage` and
// `postAsUser` post from YOUR identity with a user token (`xoxp`, SLACK_TOKEN) — dependency-free, no
// model, so a post is deterministic and verbatim (/api/slack). A bot connection (an `integration`
// row, its bot token `xoxb` in ORCA_SECRET_SLACK_BOT) adds threads (`thread_ts`, thread id
// `channel:thread_ts`), edits, the retryable/fatal split and a 1-per-second pace per channel.
// INBOUND (the bot connection only): Socket Mode. The app-level token (`xapp`, the variable
// `config.appTokenRef` names, default ORCA_SECRET_SLACK_APP) opens a WebSocket through
// `apps.connections.open`; each envelope is acked, and a mention, a DM or a reply in a thread the bot
// started becomes one InboundMessage. No public URL, no dependency: Bun's own WebSocket.
import type { Adapter, AdapterContext, Connection } from "../adapter";
import { inboundEnvelope, secretRefRefusal, type Capabilities, type InboundMessage, type OutboundMessage, type SendResult, type Target } from "../../../shared/integrations";
import { ORCA_SECRETS } from "../../env";

const API = "https://slack.com/api/";

/** One Web API call. Slack answers HTTP 200 with `{ok:false,error}` for a logical failure; a network
 *  error comes back in the same shape. Never throws. `retryAfterMs` is Slack's Retry-After on a 429. */
export async function slackApi(token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; retryAfterMs?: number; [k: string]: unknown }> {
  try {
    const res = await fetch(API + method, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as { ok: boolean; error?: string };
    const retry = Number(res.headers?.get?.("retry-after"));
    return res.status === 429 && retry > 0 ? { ...data, ok: false, error: data.error ?? "ratelimited", retryAfterMs: retry * 1000 } : data;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const userToken = () => process.env.SLACK_TOKEN ?? "";

/** Today's post, byte for byte: `{channel, text}` to chat.postMessage as the user. Pure I/O. */
export async function postMessage(channel: string, text: string): Promise<{ ok: boolean; error?: string; channel?: string }> {
  if (!userToken()) return { ok: false, error: "SLACK_TOKEN is not set" };
  const { retryAfterMs: _r, ...data } = await slackApi(userToken(), "chat.postMessage", { channel, text });
  return data as { ok: boolean; error?: string; channel?: string };
}

/** Errors a retry cannot fix (auth, a wrong channel, a bad message). */
const FATAL = new Set([
  "not_authed", "invalid_auth", "account_inactive", "token_revoked", "token_expired", "no_permission", "missing_scope",
  "channel_not_found", "is_archived", "not_in_channel", "msg_too_long", "no_text", "cant_update_message", "message_not_found", "edit_window_closed",
  "SLACK_TOKEN is not set", "no token",
]);

/** A thread id is `channel:thread_ts` (§3.6); the ts part is what Slack wants. */
export const threadTs = (threadId?: string): string | undefined => threadId?.includes(":") ? threadId.slice(threadId.indexOf(":") + 1) : threadId || undefined;
/** The channel part of a thread id: a reply goes where its thread is, even when the link names
 *  something else (the `im` link of every DM). */
export const threadChannel = (threadId?: string): string | undefined => threadId?.includes(":") ? threadId.slice(0, threadId.indexOf(":")) : undefined;

export const SLACK_CAPS: Capabilities = {
  inbound: "none", outbound: true, threads: true, edits: true, reactions: false, attachments: false,
  maxTextLength: 39_000, rate: { perTarget: 1, windowMs: 1_000 },
};
/** A bot connection with Socket Mode on. */
export const SLACK_SOCKET_CAPS: Capabilities = { ...SLACK_CAPS, inbound: "socket" };

/** The external id of the link that takes every DM to the bot: one link, the person's own level caps it. */
export const DM_LINK = "im";
/** The default name of the app-level token's variable. */
export const APP_TOKEN_REF = "ORCA_SECRET_SLACK_APP";

/** The parts of a Slack `message` / `app_mention` event Orca reads. */
export type SlackEvent = {
  type?: string; subtype?: string; user?: string; bot_id?: string; text?: string; ts?: string;
  channel?: string; channel_type?: string; thread_ts?: string; parent_user_id?: string; event_ts?: string;
};

/** Message subtypes that are a person writing. Every other subtype (edits, deletes, joins, bots) is not. */
const PERSON_SUBTYPES = new Set(["", "file_share", "thread_broadcast"]);

/** Slack's three escaped characters, back to plain text. */
const unescape = (t: string): string => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** One Socket Mode event as an InboundMessage, or undefined when it is not for Orca (pure).
 *  - The event id is `team:channel:ts`: a mention comes as `app_mention` AND as `message`; both are one event.
 *  - The thread is `channel:thread_ts`, or `channel:ts` for a top-level message, so a reply starts a
 *    thread under it. `messageId` is the message's own ts.
 *  - `mentioned`: an @-mention of the bot, a DM, or a reply in a thread the bot started.
 *  - A DM's channel is `im` (DM_LINK); its real channel rides in the thread id. */
export function slackInbound(ev: SlackEvent, me: { team: string; botUserId: string; integrationId?: string }): InboundMessage | undefined {
  if (ev.type !== "message" && ev.type !== "app_mention") return undefined;
  if (!PERSON_SUBTYPES.has(ev.subtype ?? "") || ev.bot_id || !ev.user || ev.user === me.botUserId) return undefined;
  if (!ev.channel || !ev.ts) return undefined;
  const dm = ev.channel_type === "im" || (ev.type === "message" && ev.channel.startsWith("D"));
  const tag = `<@${me.botUserId}>`;
  const raw = ev.text ?? "";
  const mentioned = ev.type === "app_mention" || dm || raw.includes(tag) || (!!ev.thread_ts && ev.parent_user_id === me.botUserId);
  const text = unescape(raw.split(tag).join("").replace(/[ \t]{2,}/g, " ").trim());
  if (!text) return undefined;
  return {
    adapter: "slack",
    ...(me.integrationId ? { integrationId: me.integrationId } : {}),
    channel: dm ? DM_LINK : ev.channel,
    eventId: `${me.team}:${ev.channel}:${ev.ts}`,
    from: { adapter: "slack", id: ev.user },
    text,
    thread: { adapter: "slack", externalId: `${ev.channel}:${ev.thread_ts ?? ev.ts}`, messageId: ev.ts },
    mentioned,
    at: Math.round(Number(ev.ts) * 1000) || Date.now(),
  };
}

/** Reconnect backoff: 1 s doubling to 30 s; a Retry-After wins when longer. */
export const reconnectDelay = (failures: number, retryAfterMs = 0): number => Math.max(Math.min(1_000 * 2 ** Math.max(0, failures - 1), 30_000), retryAfterMs);

/** The text a delivery posts: the title linked to its URL (Slack mrkdwn), then the text. */
export function render(msg: OutboundMessage): string {
  const head = msg.title ? (msg.url ? `<${msg.url}|${msg.title}>` : `*${msg.title}*`) : msg.url ? `<${msg.url}>` : "";
  return head ? `${head}\n${msg.text}` : msg.text;
}

export function slackAdapter(connection: Connection): Adapter {
  const token = () => (connection.secretRef ? process.env[connection.secretRef] : undefined) ?? "";
  // Socket Mode is on for a bot connection unless its config says `socket: false`; never for "post as me".
  const socketOn = connection.secretRef !== "SLACK_TOKEN" && connection.config.socket !== false;
  const appRef = typeof connection.config.appTokenRef === "string" ? connection.config.appTokenRef : APP_TOKEN_REF;
  let ctx: AdapterContext | undefined;
  let ws: WebSocket | undefined;
  let connected = false;
  let lastEventAt: number | undefined;
  let lastError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let me = { team: "", botUserId: "" };

  /** Open one Socket Mode connection. Resolves on `hello`; rejects when Slack refuses. */
  const connect = async (): Promise<void> => {
    const appToken = process.env[appRef] ?? "";
    const open = await slackApi(appToken, "apps.connections.open", {});
    if (!open.ok || typeof open.url !== "string") throw Object.assign(new Error(`apps.connections.open: ${open.error ?? "no url"}`), { retryAfterMs: open.retryAfterMs, fatal: FATAL.has(open.error ?? "") });
    await new Promise<void>((resolve, reject) => {
      const sock = new WebSocket(open.url as string);
      ws = sock;
      let hello = false;
      const helloTimer = setTimeout(() => { if (!hello) { sock.close(); reject(new Error("no hello from Slack in 10 s")); } }, 10_000);
      sock.addEventListener("message", (m) => {
        let msg: { type?: string; envelope_id?: string; reason?: string; payload?: { team_id?: string; event?: SlackEvent } };
        try { msg = JSON.parse(String(m.data)); } catch { return; }
        // Ack first: Slack resends an envelope it gets no ack for in 3 s.
        if (msg.envelope_id) sock.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        if (msg.type === "hello") { hello = true; clearTimeout(helloTimer); connected = true; lastError = undefined; void ctx?.status({ ok: true, detail: `connected as ${me.botUserId}` }).catch(() => {}); resolve(); return; }
        if (msg.type === "disconnect") { ctx?.log(`Slack asked to reconnect (${msg.reason ?? "no reason"})`); sock.close(); return; }
        if (msg.type !== "events_api" || !msg.payload?.event || !ctx) return;
        const inbound = slackInbound(msg.payload.event, { team: msg.payload.team_id ?? me.team, botUserId: me.botUserId, integrationId: connection.id });
        if (!inbound) return;
        lastEventAt = Date.now();
        void ctx.ingest(inboundEnvelope(inbound)).catch((e) => ctx?.log(`ingest failed: ${e instanceof Error ? e.message : String(e)}`));
      });
      sock.addEventListener("close", () => {
        clearTimeout(helloTimer);
        if (ws === sock) { ws = undefined; connected = false; }
        if (!hello) reject(new Error("the socket closed before hello"));
        else scheduleReconnect(1);
      });
      sock.addEventListener("error", () => { /* "close" follows */ });
    });
  };

  /** Reconnect after a drop or a refusal, until stop. */
  const scheduleReconnect = (failures: number, retryAfterMs = 0): void => {
    if (!ctx || ctx.signal.aborted) return;
    void ctx.status({ ok: false, detail: lastError ?? "reconnecting" }).catch(() => {});
    timer = setTimeout(() => {
      if (!ctx || ctx.signal.aborted) return;
      connect().catch((e: Error & { retryAfterMs?: number }) => {
        lastError = e.message;
        ctx?.log(`reconnect failed: ${e.message}`);
        scheduleReconnect(failures + 1, e.retryAfterMs);
      });
    }, reconnectDelay(failures, retryAfterMs));
  };

  const close = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const sock = ws;
    ws = undefined;
    connected = false;
    sock?.close();
  };

  return {
    kind: "slack",
    caps: socketOn ? SLACK_SOCKET_CAPS : SLACK_CAPS,
    async start(c: AdapterContext) {
      ctx = c;
      if (!socketOn) return;
      const refusal = secretRefRefusal(appRef, ORCA_SECRETS);
      if (refusal) throw new Error(refusal);
      if (!token()) throw new Error(`${connection.secretRef ?? "the bot token variable"} is not set`);
      if (!process.env[appRef]) throw new Error(`${appRef} is not set (the app-level token, for Socket Mode)`);
      const auth = await slackApi(token(), "auth.test", {});
      if (!auth.ok || typeof auth.user_id !== "string") throw new Error(`auth.test: ${auth.error ?? "no user_id"}`);
      me = { team: String(auth.team_id ?? ""), botUserId: auth.user_id };
      c.signal.addEventListener("abort", close, { once: true });
      try {
        await connect();
      } catch (e) {
        const err = e as Error & { retryAfterMs?: number; fatal?: boolean };
        if (err.fatal) throw err; // a bad app token: the registry records it
        lastError = err.message;
        c.log(`first connect failed: ${err.message}; retrying`);
        scheduleReconnect(1, err.retryAfterMs);
      }
    },
    async stop() { close(); ctx = undefined; },
    async send(target: Target, msg: OutboundMessage): Promise<SendResult> {
      if (!token()) return { ok: false, retryable: false, error: `${connection.secretRef ?? "the token variable"} is not set` };
      const text = msg.title || msg.url ? render(msg) : msg.text;
      const channel = threadChannel(target.threadId) ?? target.externalId;
      const r = msg.edit && target.messageId
        ? await slackApi(token(), "chat.update", { channel, ts: target.messageId, text })
        : await slackApi(token(), "chat.postMessage", { channel, text, ...(threadTs(target.threadId) ? { thread_ts: threadTs(target.threadId) } : {}) });
      if (!r.ok) return { ok: false, retryable: !FATAL.has(r.error ?? ""), ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}), error: r.error ?? "unknown error" };
      const ts = typeof r.ts === "string" ? r.ts : undefined;
      const posted = typeof r.channel === "string" ? r.channel : channel;
      return { ok: true, ...(ts ? { externalMsgId: ts } : {}), ...(ts || target.threadId ? { threadId: target.threadId ?? `${posted}:${ts}` } : {}) };
    },
    async health() {
      if (!token()) return { ok: false, detail: `${connection.secretRef ?? "token"} is not set` };
      if (socketOn && ctx) return connected ? { ok: true, detail: `Socket Mode connected as ${me.botUserId}`, ...(lastEventAt ? { lastEventAt } : {}) } : { ok: false, detail: lastError ?? "Socket Mode reconnecting" };
      const r = await slackApi(token(), "auth.test", {});
      return r.ok ? { ok: true, detail: `signed in as ${String(r.user ?? "?")}` } : { ok: false, detail: r.error };
    },
    async resolveUser(externalId: string) {
      if (!token()) return undefined;
      // A read method: Slack takes its arguments as a query or a form, never as JSON.
      const r = await slackApi(token(), `users.info?user=${encodeURIComponent(externalId)}`, {});
      const u = r.user as { id?: string; name?: string; real_name?: string; profile?: { display_name?: string } } | undefined;
      return r.ok && u?.id ? { id: u.id, name: u.profile?.display_name || u.real_name || u.name || u.id } : undefined;
    },
  };
}

/** The user-token connection behind /api/slack: "post as me". Not a row — it exists wherever SLACK_TOKEN is set. */
export const USER_CONNECTION: Connection = { id: "slack-user", kind: "slack", name: "Slack (as you)", instance: "*", config: {}, secretRef: "SLACK_TOKEN", enabled: true };

/** /api/slack's post through the adapter: the same body, the same token, the same error text. */
export async function postAsUser(channel: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!userToken()) return { ok: false, error: "SLACK_TOKEN is not set" };
  const r = await slackAdapter(USER_CONNECTION).send({ externalId: channel }, { text }, "");
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
