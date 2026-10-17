// The Slack adapter, OUTBOUND half (docs/research/integrations.md §5). Today's one Slack path moved
// here unchanged: `chat.postMessage` from YOUR identity with a user token (`xoxp`, SLACK_TOKEN) —
// dependency-free, no model, so a post is deterministic and verbatim. `postMessage` keeps the exact
// old signature (server/slack-api.ts re-exports it; /api/slack calls `postAsUser`). The adapter adds
// what the delivery path needs: threads (`thread_ts`, thread id `channel:thread_ts`), edits
// (`chat.update`), the retryable/fatal split and a 1-per-second pace per channel. Inbound (Socket
// Mode, a bot token) is a later branch: it adds `start` and `inbound: "socket"` here, nothing in the core.
import type { Adapter, Connection } from "../adapter";
import type { Capabilities, OutboundMessage, SendResult, Target } from "../../../shared/integrations";

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

export const SLACK_CAPS: Capabilities = {
  inbound: "none", outbound: true, threads: true, edits: true, reactions: false, attachments: false,
  maxTextLength: 39_000, rate: { perTarget: 1, windowMs: 1_000 },
};

/** The text a delivery posts: the title linked to its URL (Slack mrkdwn), then the text. */
export function render(msg: OutboundMessage): string {
  const head = msg.title ? (msg.url ? `<${msg.url}|${msg.title}>` : `*${msg.title}*`) : msg.url ? `<${msg.url}>` : "";
  return head ? `${head}\n${msg.text}` : msg.text;
}

export function slackAdapter(connection: Connection): Adapter {
  const token = () => (connection.secretRef ? process.env[connection.secretRef] : undefined) ?? "";
  return {
    kind: "slack",
    caps: SLACK_CAPS,
    async start() {},
    async stop() {},
    async send(target: Target, msg: OutboundMessage): Promise<SendResult> {
      if (!token()) return { ok: false, retryable: false, error: `${connection.secretRef ?? "the token variable"} is not set` };
      const text = msg.title || msg.url ? render(msg) : msg.text;
      const r = msg.edit && target.messageId
        ? await slackApi(token(), "chat.update", { channel: target.externalId, ts: target.messageId, text })
        : await slackApi(token(), "chat.postMessage", { channel: target.externalId, text, ...(threadTs(target.threadId) ? { thread_ts: threadTs(target.threadId) } : {}) });
      if (!r.ok) return { ok: false, retryable: !FATAL.has(r.error ?? ""), ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}), error: r.error ?? "unknown error" };
      const ts = typeof r.ts === "string" ? r.ts : undefined;
      const channel = typeof r.channel === "string" ? r.channel : target.externalId;
      return { ok: true, ...(ts ? { externalMsgId: ts } : {}), ...(ts || target.threadId ? { threadId: target.threadId ?? `${channel}:${ts}` } : {}) };
    },
    async health() {
      if (!token()) return { ok: false, detail: `${connection.secretRef ?? "token"} is not set` };
      const r = await slackApi(token(), "auth.test", {});
      return r.ok ? { ok: true, detail: `signed in as ${String(r.user ?? "?")}` } : { ok: false, detail: r.error };
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
