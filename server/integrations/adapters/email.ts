// The email adapter (docs/research/integrations.md phase 6; setup: docs/integrations/email.md).
// Inbound: IMAP IDLE on one dedicated mailbox (a poll loop when the server has no IDLE, or with
// `idle: false`); the cursor is `<UIDVALIDITY>:<last UID>`, so a restart reads only what is new.
// Every mail passes the gate (mime.ts `gate`) BEFORE `ctx.ingest`: not Orca's own address, not an
// auto-reply, the sender on `allowedSenders`, and an aligned DKIM/SPF/DMARC pass in OUR receiving
// server's Authentication-Results — the From header alone is trivial to forge. Then the core's own
// gate (link + identity) applies as for every adapter. The channel is the SENDER's address, so one
// `channel_link` per correspondent carries both directions: their mail in, Orca's mail out to them.
// Threading: the thread id is the conversation's root Message-ID (References[0], else In-Reply-To,
// else the mail's own); Orca's outbound Message-ID carries the delivery id, so a retried delivery is
// the same message. Outbound goes by SMTP or the Resend API, chosen by `outbound` in the config.
import * as attachments from "../../attachments";
import * as db from "../../db";
import { ORCA_SECRETS } from "../../env";
import { clip, inboundEnvelope, secretRefRefusal, type Capabilities, type OutboundMessage, type SendResult, type Target } from "../../../shared/integrations";
import type { Adapter, AdapterContext, Connection } from "../adapter";
import { ImapClient } from "./email/imap";
import { buildMail, gate, outboundMessageId, parseMail, replyHeaders, stripQuotedReply, threadOf, type ParsedMail } from "./email/mime";
import { sendMail, SmtpError, type SmtpSecurity } from "./email/smtp";

export type EmailConfig = {
  /** Orca's mailbox: the From of every outbound mail, and the IMAP login unless `imap.user` is set. */
  address: string;
  fromName?: string;
  imap?: { host: string; port?: number; tls?: boolean; user?: string; mailbox?: string };
  /** IDLE when the server offers it (default true); otherwise poll every `pollSeconds` (default 60). */
  idle?: boolean;
  pollSeconds?: number;
  outbound?: "smtp" | "resend" | "none";
  /** `secretRef` names the SMTP password variable; unset = the integration's own secret (one mailbox password). */
  smtp?: { host: string; port?: number; security?: SmtpSecurity; user?: string; secretRef?: string };
  resend?: { secretRef: string; apiUrl?: string };
  /** Addresses, or `@domain` for a whole domain. Empty = no mail reaches Orca. */
  allowedSenders?: string[];
  /** The authserv-id your receiving server writes (e.g. `mx.google.com`). Unset = the topmost header. */
  authservId?: string;
  /** Refuse an SPF-only or DMARC-only pass: an aligned DKIM signature is required. */
  requireDkim?: boolean;
  /** Keep the quoted history of a reply in the text (default: cut it). */
  keepQuoted?: boolean;
  /** Outbound pace per recipient (default 20 an hour). */
  perHour?: number;
};

const RESEND_API = "https://api.resend.com/emails";
const IDLE_MS = 25 * 60_000; // RFC 2177: re-issue IDLE inside 29 minutes

export const emailCaps = (c: Partial<EmailConfig>): Capabilities => ({
  inbound: c.imap ? "socket" : "none",
  outbound: (c.outbound ?? "none") !== "none",
  threads: true, edits: false, reactions: false, attachments: true,
  maxTextLength: 100_000,
  rate: { perTarget: c.perHour ?? 20, windowMs: 3_600_000 },
});

/** The config with defaults, or why it is unusable. */
export function emailConfig(raw: Record<string, unknown>): { config: EmailConfig } | { error: string } {
  const c = raw as Partial<EmailConfig>;
  if (typeof c.address !== "string" || !/^[^@\s]+@[^@\s]+$/.test(c.address)) return { error: "config.address must be Orca's email address" };
  if (c.imap && typeof c.imap.host !== "string") return { error: "config.imap.host is required for inbound mail" };
  const outbound = c.outbound ?? "none";
  if (!["smtp", "resend", "none"].includes(outbound)) return { error: `config.outbound must be "smtp", "resend" or "none"` };
  if (outbound === "smtp" && typeof c.smtp?.host !== "string") return { error: "config.smtp.host is required for outbound: smtp" };
  if (outbound === "resend" && typeof c.resend?.secretRef !== "string") return { error: "config.resend.secretRef is required for outbound: resend" };
  for (const ref of [c.smtp?.secretRef, c.resend?.secretRef]) {
    const why = secretRefRefusal(ref, ORCA_SECRETS);
    if (why) return { error: why };
  }
  if (c.allowedSenders !== undefined && (!Array.isArray(c.allowedSenders) || c.allowedSenders.some((s) => typeof s !== "string"))) return { error: "config.allowedSenders must be a list of addresses or @domains" };
  return { config: { ...c, address: c.address.toLowerCase(), outbound, allowedSenders: c.allowedSenders ?? [] } as EmailConfig };
}

/** The text an agent reads for one mail: the subject, the new part of the body, and a note per
 *  attachment that could not be kept. */
export function inboundText(m: ParsedMail, opts: { keepQuoted?: boolean; skipped?: string[] } = {}): string {
  const body = opts.keepQuoted ? m.text : stripQuotedReply(m.text);
  return [
    m.subject ? `Subject: ${m.subject}` : "",
    body,
    ...(opts.skipped ?? []).map((s) => `[attachment not kept: ${s}]`),
  ].filter(Boolean).join("\n\n");
}

/** The subject of an outbound mail: the title, else the first line of the text; `Re:` in a thread. */
export function outboundSubject(msg: Pick<OutboundMessage, "title" | "text">, reply: boolean): string {
  const base = clip((msg.title || msg.text.split("\n").find((l) => l.trim()) || "Orca").trim(), 150);
  return reply && !/^re:/i.test(base) ? `Re: ${base}` : base;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  if (signal.aborted) return r();
  const t = setTimeout(r, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function emailAdapter(connection: Connection): Adapter {
  const parsed = emailConfig(connection.config);
  const cfg = "config" in parsed ? parsed.config : undefined;
  const local = new AbortController();
  let ctx: AdapterContext | undefined;
  let client: ImapClient | undefined;
  let lastEventAt: number | undefined;
  let state: { ok: boolean; detail: string } = { ok: false, detail: "not started" };
  let pos = { uidValidity: 0, uid: 0 };

  const env = (ref?: string) => (ref ? process.env[ref] : undefined) || undefined;
  const imapPassword = () => ctx?.secret() ?? env(connection.secretRef);
  const report = async (ok: boolean, detail: string) => {
    state = { ok, detail };
    await ctx?.status({ ok, detail, ...(lastEventAt ? { lastEventAt } : {}) }).catch(() => {});
  };

  async function connect(): Promise<ImapClient> {
    const i = cfg!.imap!;
    const password = imapPassword();
    if (!password) throw new Error(`${connection.secretRef ?? "the IMAP password variable"} is not set`);
    const c = await ImapClient.connect({ host: i.host, port: i.port ?? (i.tls === false ? 143 : 993), tls: i.tls !== false, user: i.user ?? cfg!.address, password });
    try {
      const sel = await c.select(i.mailbox ?? "INBOX");
      const [v, u] = ((await ctx!.cursor.get()) ?? "").split(":").map(Number);
      // A first start, or a mailbox whose UIDs were reset: begin at the newest mail, never replay history.
      pos = v === sel.uidValidity && Number.isFinite(u) ? { uidValidity: v!, uid: u! } : { uidValidity: sel.uidValidity, uid: sel.uidNext ? sel.uidNext - 1 : await c.maxUid() };
      await ctx!.cursor.set(`${pos.uidValidity}:${pos.uid}`);
      return c;
    } catch (e) { await c.logout(); throw e; }
  }

  /** Keep each attachment under the cap as an Orca attachment; name the rest. */
  async function keep(m: ParsedMail): Promise<{ refs: string[]; skipped: string[] }> {
    const refs: string[] = [], skipped: string[] = [];
    for (const a of m.attachments) {
      if (a.bytes.byteLength > attachments.MAX_ATTACHMENT_BYTES) { skipped.push(`${a.filename} is over ${attachments.MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`); continue; }
      try { refs.push(...(await attachments.store([new File([new Uint8Array(a.bytes)], a.filename, { type: a.mimeType })]))); }
      catch (e) { skipped.push(`${a.filename} (${errText(e)})`); }
    }
    return { refs, skipped };
  }

  /** One mail through the gate into the core. */
  async function take(raw: Uint8Array, uid: number): Promise<string> {
    const m = parseMail(raw);
    const g = gate(m, { self: cfg!.address, allowedSenders: cfg!.allowedSenders ?? [], authservId: cfg!.authservId, requireDkim: cfg!.requireDkim });
    if (!g.ok) return `skipped: ${g.reason}`;
    const { refs, skipped } = await keep(m);
    const t = threadOf(m);
    const env = inboundEnvelope({
      adapter: "email", integrationId: connection.id, channel: m.from!.address,
      eventId: `${connection.id}:${m.messageId ?? `${pos.uidValidity}-${uid}`}`,
      from: { adapter: "email", id: m.from!.address, ...(m.from!.name ? { name: m.from!.name } : {}) },
      text: inboundText(m, { keepQuoted: cfg!.keepQuoted, skipped }),
      ...(t.root ? { thread: { adapter: "email", externalId: t.root, ...(t.messageId ? { messageId: t.messageId } : {}) } } : {}),
      attachments: refs,
      at: m.date ?? Date.now(),
    });
    lastEventAt = Date.now();
    return ctx!.ingest({ ...env, ...(m.subject ? { title: m.subject } : {}) });
  }

  /** Read every mail above the cursor, in UID order; the cursor moves after each one. */
  async function catchUp(c: ImapClient): Promise<void> {
    for (const uid of await c.uidsAfter(pos.uid)) {
      if (local.signal.aborted) return;
      const raw = await c.fetch(uid);
      const outcome = raw ? await take(raw, uid).catch((e) => `failed: ${errText(e)}`) : "gone";
      ctx!.log(`uid ${uid}: ${outcome}`);
      await c.markSeen(uid).catch(() => {});
      pos.uid = uid;
      await ctx!.cursor.set(`${pos.uidValidity}:${pos.uid}`);
    }
  }

  async function loop(): Promise<void> {
    let backoff = 1_000;
    while (!local.signal.aborted) {
      try {
        client ??= await connect();
        await catchUp(client);
        const idle = cfg!.idle !== false && client.capabilities.has("IDLE");
        await report(true, idle ? `idle on ${cfg!.imap!.mailbox ?? "INBOX"}` : `polling every ${cfg!.pollSeconds ?? 60}s`);
        backoff = 1_000;
        if (idle) await client.idle(IDLE_MS, local.signal);
        else { await sleep((cfg!.pollSeconds ?? 60) * 1000, local.signal); if (!local.signal.aborted) await client.command("NOOP"); }
      } catch (e) {
        if (local.signal.aborted) break;
        await report(false, `IMAP: ${errText(e)}; retry in ${Math.round(backoff / 1000)}s`);
        await client?.logout().catch(() => {});
        client = undefined;
        await sleep(backoff, local.signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  async function sendResend(to: string, subject: string, text: string, messageId: string, h: { inReplyTo?: string; references: string[] }, files: { filename: string; bytes: Uint8Array }[], key: string): Promise<SendResult> {
    const token = env(cfg!.resend!.secretRef);
    if (!token) return { ok: false, retryable: false, error: `${cfg!.resend!.secretRef} is not set` };
    try {
      const res = await fetch(cfg!.resend!.apiUrl ?? RESEND_API, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          from: cfg!.fromName ? `${cfg!.fromName} <${cfg!.address}>` : cfg!.address,
          to: [to], subject, text,
          headers: { "Message-ID": messageId, "Auto-Submitted": "auto-generated", ...(h.inReplyTo ? { "In-Reply-To": h.inReplyTo, References: h.references.join(" ") } : {}) },
          ...(files.length ? { attachments: files.map((f) => ({ filename: f.filename, content: Buffer.from(f.bytes).toString("base64") })) } : {}),
        }),
      });
      if (res.ok) return { ok: true };
      const retry = Number(res.headers.get("retry-after"));
      const detail = await res.text().catch(() => "");
      return { ok: false, retryable: res.status === 429 || res.status >= 500, ...(retry > 0 ? { retryAfterMs: retry * 1000 } : {}), error: `resend http ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
    } catch (e) {
      return { ok: false, retryable: true, error: `resend: ${errText(e)}` };
    }
  }

  return {
    kind: "email",
    caps: emailCaps(cfg ?? {}),
    async start(c) {
      if (!cfg) throw new Error((parsed as { error: string }).error);
      ctx = c;
      c.signal.addEventListener("abort", () => local.abort(), { once: true });
      if (!cfg.imap) { await report(true, "outbound only"); return; }
      client = await connect(); // a bad password or host fails the start; the registry records it
      void loop();
    },
    async stop() {
      local.abort();
      await client?.logout().catch(() => {});
      client = undefined;
    },
    async send(target: Target, msg: OutboundMessage, key: string): Promise<SendResult> {
      if (!cfg) return { ok: false, retryable: false, error: (parsed as { error: string }).error };
      const to = target.externalId.trim().toLowerCase();
      if (!/^[^@\s<>]+@[^@\s<>]+$/.test(to)) return { ok: false, retryable: false, error: `${target.externalId} is not an email address` };
      const h = replyHeaders(target.threadId, msg.replyToExternalMsgId, msg.references);
      const subject = outboundSubject(msg, !!h.inReplyTo);
      const notes: string[] = [];
      const files: { filename: string; mimeType: string; bytes: Uint8Array }[] = [];
      for (const ref of msg.attachments ?? []) {
        const id = ref.match(/([0-9a-f-]{36})/)?.[1];
        const row = id ? await db.attachment(id).catch(() => undefined) : undefined;
        if (row) files.push({ filename: row.filename, mimeType: row.mimeType || "application/octet-stream", bytes: row.bytes });
        else notes.push(`[attachment unavailable: ${ref}]`);
      }
      const text = [msg.text, msg.url ?? "", ...notes].filter(Boolean).join("\n\n");
      const messageId = outboundMessageId(key, cfg.address);
      const done: SendResult = { ok: true, externalMsgId: messageId, threadId: target.threadId ?? messageId };
      if (cfg.outbound === "resend") {
        const r = await sendResend(to, subject, text, messageId, h, files, key);
        return r.ok ? done : r;
      }
      if (cfg.outbound !== "smtp") return { ok: false, retryable: false, error: "outbound mail is off (config.outbound)" };
      const s = cfg.smtp!;
      const password = s.secretRef ? env(s.secretRef) : imapPassword();
      const mail = buildMail({ from: { address: cfg.address, ...(cfg.fromName ? { name: cfg.fromName } : {}) }, to, subject, text, messageId, ...h, attachments: files });
      const security = s.security ?? (s.port === 587 ? "starttls" : "implicit");
      try {
        await sendMail({ host: s.host, port: s.port ?? (security === "implicit" ? 465 : 587), security, user: s.user ?? cfg.address, password, heloName: cfg.address.split("@")[1] }, { from: cfg.address, to: [to] }, mail);
        return done;
      } catch (e) {
        return { ok: false, retryable: e instanceof SmtpError ? e.retryable : true, error: errText(e) };
      }
    },
    async health() {
      if (!cfg) return { ok: false, detail: (parsed as { error: string }).error };
      return { ...state, ...(lastEventAt ? { lastEventAt } : {}) };
    },
  };
}
