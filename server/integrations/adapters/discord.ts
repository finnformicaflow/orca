// The Discord adapter (docs/research/integrations.md §5, phase 2; setup: docs/integrations/discord.md).
// Two-way and dependency-free: a hand Gateway client over Bun's WebSocket for inbound, REST for
// outbound. The core owns everything else — the gate (link level, the person, the link's repos),
// dedupe, retries, pacing and the thread → workstream map — so this file only speaks Discord.
//
// Inbound: a message that @-mentions the bot in a linked channel (or in a thread of one), or a DM —
// under the link `config.dmLink` names, else the integration's catch-all link ("*"). A thread's messages carry
// `thread` (its channel id) and its PARENT channel as `source.channel`, so the link is the parent's.
// A top-level mention gets `thread` = its own message id: Discord gives a thread started from a
// message that message's id, so once the core accepts the event the adapter opens that thread and
// the conversation continues there — one request, one thread.
// Outbound: a post to the link's channel, or into `target.threadId`; a first post for a workstream
// (no thread yet) opens a thread on itself and returns its id, which the core keeps as that
// workstream's thread on the link. Edits PATCH the message. A 429 is retryable with Discord's
// `retry_after`. The bot token is `secretRef` (ORCA_SECRET_DISCORD_BOT) — never logged, never in `raw`.
import type { Adapter, AdapterContext, Connection } from "../adapter";
import { clip, inboundEnvelope, type Capabilities, type OutboundMessage, type SendResult, type Target, type Topic } from "../../../shared/integrations";

export const API = "https://discord.com/api/v10";

// Gateway intents: GUILDS (thread parents), GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT
// (privileged: switch it on in the Developer Portal too, or the content arrives empty).
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
/** Close codes no reconnect can fix: bad token, bad or disallowed intents, bad shard/version. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Discord's limits: content is cut at 2000 characters; about 5 messages per 5s per channel. */
export const DISCORD_CAPS: Capabilities = {
  inbound: "socket", outbound: true, threads: true, edits: true, reactions: false, attachments: false,
  maxTextLength: 2000, rate: { perTarget: 5, windowMs: 5_000 },
};

/** The WebSocket constructor the Gateway uses. A test swaps in a fake server. */
export const gateway = { WebSocket: globalThis.WebSocket as unknown as new (url: string) => WebSocketLike, baseBackoffMs: 1_000 };
export type WebSocketLike = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
};

type Rest = { ok: boolean; status: number; data: Record<string, unknown>; retryAfterMs?: number; error?: string };

/** One REST call. Never throws: a network error is `status: 0`. Pure I/O. */
export async function discordApi(token: string, method: string, path: string, body?: unknown): Promise<Rest> {
  try {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bot ${token}`, "content-type": "application/json", "user-agent": "DiscordBot (https://github.com/finnformica/orca, 1)" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, status: res.status, data };
    // 429: `retry_after` (seconds, a float) in the body, else the Retry-After header.
    const after = Number(data.retry_after ?? res.headers?.get?.("retry-after"));
    return { ok: false, status: res.status, data, error: `${res.status} ${String(data.message ?? res.statusText ?? "error")}`, ...(after > 0 ? { retryAfterMs: Math.ceil(after * 1000) } : {}) };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A failed call as the core's SendResult: retry a network error, a 429 or a 5xx; never auth, a
 *  missing channel or a bad message. */
export const failure = (r: Rest): SendResult => ({
  ok: false, retryable: r.status === 0 || r.status === 429 || r.status >= 500,
  ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}), error: r.error ?? "unknown error",
});

// The embed style of the build posts in the same server (agency-tooling build-notifications):
// a coloured embed with a linked title. Colour by what happened.
const COLOR = { info: 0x5865f2, warning: 0xfaa61a, grey: 0x99aab5, good: 0x57f287 };
export function colorFor(topic?: Topic): number {
  const t = String(topic ?? "");
  if (/fail|conflict|refused|gave_up|error/.test(t)) return COLOR.warning;
  if (/stopped|cancel/.test(t)) return COLOR.grey;
  if (/merged|ready|finished|done/.test(t)) return COLOR.good;
  return COLOR.info;
}

/** The message body: plain content for a reply (no title), an embed for an event post. Pure. */
export function render(msg: OutboundMessage): Record<string, unknown> {
  if (!msg.title) return { content: msg.url ? `${msg.text}\n${msg.url}` : msg.text, allowed_mentions: { parse: [] } };
  return {
    allowed_mentions: { parse: [] }, // a model's text never pings @everyone or a role
    embeds: [{ title: clip(msg.title, 256), ...(msg.url ? { url: msg.url } : {}), description: clip(msg.text, 4096), color: colorFor(msg.topic), timestamp: new Date().toISOString() }],
  };
}

/** A Gateway MESSAGE_CREATE as the core's envelope, or undefined when it is not for Orca (a bot, an
 *  empty message). `parent` is the channel's parent when it is a thread. Pure. */
export type DiscordMessage = {
  id: string; channel_id: string; guild_id?: string; content?: string; timestamp?: string;
  author: { id: string; username?: string; global_name?: string | null; bot?: boolean };
  mentions?: { id: string }[]; attachments?: { url: string; filename?: string }[];
};
export function toEnvelope(m: DiscordMessage, o: { integrationId: string; botId?: string; dmLink?: string; parent?: string }) {
  if (m.author.bot || (o.botId && m.author.id === o.botId)) return undefined;
  const dm = !m.guild_id;
  const mentioned = dm || Boolean(o.botId && (m.mentions?.some((u) => u.id === o.botId) || m.content?.includes(`<@${o.botId}>`)));
  const text = [
    (m.content ?? "").replace(new RegExp(`<@!?${o.botId ?? "-"}>`, "g"), "").trim(),
    ...(m.attachments ?? []).map((a) => `(attachment ${a.filename ?? ""}: ${a.url})`),
  ].filter(Boolean).join("\n");
  if (!text) return undefined;
  // In a thread: the link is the parent's, the thread is this channel. Top level: the thread a reply
  // opens on this message has this message's id.
  const inThread = !dm && Boolean(o.parent && o.parent !== m.channel_id);
  const e = inboundEnvelope({
    adapter: "discord", integrationId: o.integrationId, eventId: m.id,
    // A DM: the link `dmLink` names, else the DM channel itself, which the core matches to the
    // integration's catch-all link ("*") — no such link drops it.
    channel: dm ? (o.dmLink ? undefined : m.channel_id) : inThread ? o.parent : m.channel_id,
    from: { adapter: "discord", id: m.author.id, name: m.author.global_name || m.author.username },
    text, mentioned,
    thread: { adapter: "discord", externalId: dm ? m.channel_id : inThread ? m.channel_id : m.id, messageId: m.id },
    at: m.timestamp ? Date.parse(m.timestamp) : undefined,
    raw: { id: m.id, channel_id: m.channel_id, guild_id: m.guild_id }, // ids only: no content twice, never a token
  });
  return { envelope: dm && o.dmLink ? { ...e, source: { ...e.source, linkId: o.dmLink } } : e, opensThread: !dm && !inThread };
}

/** The wait before reconnect number `attempt`: 1s, 2s, 4s … 60s. */
export const backoffMs = (attempt: number): number => Math.min(60_000, gateway.baseBackoffMs * 2 ** attempt);

export function discordAdapter(connection: Connection): Adapter {
  const token = () => (connection.secretRef ? process.env[connection.secretRef] : undefined) ?? "";
  const dmLink = typeof connection.config.dmLink === "string" && connection.config.dmLink ? connection.config.dmLink : undefined;
  let ctx: AdapterContext | undefined;
  let ws: WebSocketLike | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let acked = true;
  let seq: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let gatewayUrl = "wss://gateway.discord.gg";
  let botId: string | undefined;
  let attempt = 0;
  let stopped = false;
  let state: { ok: boolean; detail?: string; lastEventAt?: number } = { ok: false, detail: "not started" };
  const parents = new Map<string, string>(); // thread id → parent channel id

  const setState = (s: typeof state) => { state = { ...state, ...s }; void ctx?.status(state).catch(() => {}); };
  const sendOp = (op: number, d: unknown) => { try { ws?.send(JSON.stringify({ op, d })); } catch { /* the close handler reconnects */ } };
  const identify = () => sendOp(2, { token: token(), intents: INTENTS, properties: { os: "linux", browser: "orca", device: "orca" } });

  /** A thread's parent channel: from the Gateway's thread events, else one REST read. A channel that
   *  is not a thread is its own parent. */
  async function parentOf(channelId: string): Promise<string> {
    const known = parents.get(channelId);
    if (known) return known;
    const r = await discordApi(token(), "GET", `/channels/${channelId}`);
    const parent = r.ok && [10, 11, 12].includes(Number(r.data.type)) && typeof r.data.parent_id === "string" ? r.data.parent_id : channelId;
    parents.set(channelId, parent);
    return parent;
  }

  async function onMessage(m: DiscordMessage): Promise<void> {
    if (!ctx || m.author.bot) return;
    const parent = m.guild_id ? await parentOf(m.channel_id) : undefined;
    const made = toEnvelope(m, { integrationId: connection.id, botId, dmLink, parent });
    if (!made) return;
    const verdict = await ctx.ingest(made.envelope);
    if (verdict === "new" && made.opensThread) {
      // The request's thread, named after it. Its id is the message id the envelope already carries.
      const name = clip(made.envelope.text.split("\n")[0] || "Orca", 90);
      const r = await discordApi(token(), "POST", `/channels/${m.channel_id}/messages/${m.id}/threads`, { name, auto_archive_duration: 1440 });
      if (r.ok) parents.set(m.id, m.channel_id);
      else ctx.log(`could not open a thread on message ${m.id}: ${r.error}`);
    }
  }

  function connect(): void {
    if (stopped) return;
    const url = `${resumeUrl && sessionId ? resumeUrl : gatewayUrl}/?v=10&encoding=json`;
    const sock = new gateway.WebSocket(url);
    ws = sock;
    sock.onmessage = (ev) => {
      let p: { op: number; d: any; s?: number | null; t?: string | null };
      try { p = JSON.parse(String(ev.data)); } catch { return; }
      if (typeof p.s === "number") seq = p.s;
      if (p.op === 10) { // Hello: beat, then identify or resume
        clearInterval(beat);
        acked = true;
        const every = Number(p.d?.heartbeat_interval) || 41_250;
        beat = setInterval(() => {
          if (!acked) { sock.close(4000); return; } // a zombie connection: drop it and resume
          acked = false;
          sendOp(1, seq);
        }, every);
        if (sessionId) sendOp(6, { token: token(), session_id: sessionId, seq });
        else identify();
      } else if (p.op === 11) acked = true;
      else if (p.op === 1) sendOp(1, seq);
      else if (p.op === 7) sock.close(4000); // Reconnect: resume on a new socket
      else if (p.op === 9) { // Invalid session: resumable (d true) or start a new one
        if (!p.d) { sessionId = undefined; resumeUrl = undefined; seq = null; }
        setTimeout(() => stopped || (p.d ? sendOp(6, { token: token(), session_id: sessionId, seq }) : identify()), 1_000 + Math.random() * 4_000);
      } else if (p.op === 0) {
        const at = Date.now();
        if (p.t === "READY") {
          sessionId = p.d.session_id; resumeUrl = p.d.resume_gateway_url; botId = p.d.user?.id;
          attempt = 0;
          setState({ ok: true, detail: `connected as ${p.d.user?.username ?? "?"}` });
        } else if (p.t === "RESUMED") { attempt = 0; setState({ ok: true }); }
        else if (p.t === "GUILD_CREATE") for (const t of p.d?.threads ?? []) parents.set(t.id, t.parent_id);
        else if (p.t === "THREAD_CREATE" || p.t === "THREAD_UPDATE") { if (p.d?.parent_id) parents.set(p.d.id, p.d.parent_id); }
        else if (p.t === "MESSAGE_CREATE") {
          setState({ ok: true, lastEventAt: at });
          void onMessage(p.d as DiscordMessage).catch((e) => ctx?.log(`inbound message failed: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    };
    sock.onclose = (ev) => {
      clearInterval(beat);
      if (ws !== sock || stopped) return;
      if (FATAL_CLOSE.has(ev.code)) {
        setState({ ok: false, detail: `Discord closed the Gateway (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}); check the token and the Message Content intent` });
        return;
      }
      if (ev.code === 4007 || ev.code === 4009) { sessionId = undefined; resumeUrl = undefined; seq = null; } // the session can't be resumed
      setState({ ok: false, detail: `disconnected (${ev.code}); reconnecting` });
      retry = setTimeout(connect, backoffMs(attempt++));
    };
    sock.onerror = () => {}; // onclose follows
  }

  function close(): void {
    stopped = true;
    clearInterval(beat);
    clearTimeout(retry);
    const s = ws;
    ws = undefined;
    try { s?.close(1000); } catch { /* already closed */ }
    state = { ...state, ok: false, detail: "stopped" };
  }

  return {
    kind: "discord",
    caps: DISCORD_CAPS,
    async start(c) {
      ctx = c;
      stopped = false;
      if (!token()) throw new Error(`${connection.secretRef ?? "the token variable"} is not set`);
      // Checks the token before a socket is opened: a bad one fails the start, as the contract asks.
      const r = await discordApi(token(), "GET", "/gateway/bot");
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error(`Discord refused the bot token (${r.error})`);
        c.log(`could not read the Gateway URL (${r.error}); using the default`);
      } else if (typeof r.data.url === "string") gatewayUrl = r.data.url;
      c.signal.addEventListener("abort", close);
      connect();
    },
    async stop() { close(); },
    async send(target: Target, msg: OutboundMessage): Promise<SendResult> {
      if (!token()) return { ok: false, retryable: false, error: `${connection.secretRef ?? "the token variable"} is not set` };
      const channel = target.threadId ?? target.externalId; // a Discord thread is a channel
      const body = render(msg);
      if (msg.edit && target.messageId) {
        const r = await discordApi(token(), "PATCH", `/channels/${channel}/messages/${target.messageId}`, body);
        return r.ok ? { ok: true, externalMsgId: target.messageId, ...(target.threadId ? { threadId: target.threadId } : {}) } : failure(r);
      }
      let r = await discordApi(token(), "POST", `/channels/${channel}/messages`, body);
      // A thread id that is a message id in the link's channel names a thread nobody opened yet: the
      // core's pairing reply to a new sender, or `orca post --thread` after the open at ingest failed.
      // Open it on that message, then post again. Discord's 160004 = a thread already exists there.
      if (!r.ok && r.status === 404 && target.threadId && target.threadId !== target.externalId) {
        const t = await discordApi(token(), "POST", `/channels/${target.externalId}/messages/${target.threadId}/threads`, { name: clip(msg.title || msg.text.split("\n")[0] || "Orca", 90), auto_archive_duration: 1440 });
        if (t.ok || t.data.code === 160004) {
          parents.set(target.threadId, target.externalId);
          r = await discordApi(token(), "POST", `/channels/${channel}/messages`, body);
        }
      }
      if (!r.ok) return failure(r);
      const id = typeof r.data.id === "string" ? r.data.id : undefined;
      if (target.threadId || !id) return { ok: true, ...(id ? { externalMsgId: id } : {}), ...(target.threadId ? { threadId: target.threadId } : {}) };
      // A first post for this workstream on the link: open its thread on the post, so the next posts
      // and the replies stay together. The post itself stands if Discord refuses the thread.
      const name = clip(msg.title || msg.text.split("\n")[0] || "Orca", 90);
      const t = await discordApi(token(), "POST", `/channels/${target.externalId}/messages/${id}/threads`, { name, auto_archive_duration: 1440 });
      if (t.ok) parents.set(id, target.externalId);
      return { ok: true, externalMsgId: id, ...(t.ok ? { threadId: id } : {}) };
    },
    async health() {
      if (!token()) return { ok: false, detail: `${connection.secretRef ?? "token"} is not set` };
      return state;
    },
    async resolveUser(externalId: string) {
      const r = await discordApi(token(), "GET", `/users/${externalId}`);
      if (!r.ok || typeof r.data.id !== "string") return undefined;
      return { id: r.data.id, name: String(r.data.global_name || r.data.username || r.data.id) };
    },
  };
}
