// The email adapter (docs/integrations/email.md): the pure MIME/threading/gate decisions, then the
// real adapter against a fake IMAP server (IDLE and the poll fallback) and a fake SMTP server over
// real TCP, a fake Resend endpoint, and the real core (router, dispatcher, registry) on a fresh
// Postgres schema. No real mail service is ever called.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as net from "net";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as registry from "../server/integrations/registry";
import * as store from "../server/integrations/store";
import type { Connection } from "../server/integrations/adapter";
import { emailAdapter, emailConfig, inboundText, outboundSubject } from "../server/integrations/adapters/email";
import {
  authVerdict, buildMail, dotStuff, gate, htmlToText, isAutomated, outboundMessageId, parseHeaders, parseMail, qpEncode, replyHeaders, senderAllowed, stripQuotedReply, threadOf,
} from "../server/integrations/adapters/email/mime";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 5_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

const PASS = "mx.example.com; dkim=pass header.d=example.com header.s=s1; spf=pass smtp.mailfrom=finn@example.com; dmarc=pass header.from=example.com";

/** One raw mail, CRLF. */
function mail(o: { from?: string; auth?: string[]; subject?: string; text?: string; html?: string; id: string; inReplyTo?: string; references?: string; attach?: { name: string; bytes: Buffer }; extra?: string[] }): string {
  const head = [
    ...(o.auth ?? [PASS]).map((a) => `Authentication-Results: ${a}`),
    `From: ${o.from ?? "Finn <finn@example.com>"}`,
    "To: orca@example.com",
    `Subject: ${o.subject ?? "Hello"}`,
    "Date: Sat, 17 Oct 2026 10:00:00 +0000",
    `Message-ID: ${o.id}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    ...(o.extra ?? []),
    "MIME-Version: 1.0",
  ];
  const body = o.html
    ? ["Content-Type: text/html; charset=utf-8", "", o.html]
    : ["Content-Type: text/plain; charset=utf-8", "", o.text ?? "Hi Orca"];
  if (!o.attach) return [...head, ...body].join("\r\n");
  return [
    ...head, 'Content-Type: multipart/mixed; boundary="b1"', "", "preamble", "--b1", ...body,
    "--b1", `Content-Type: application/octet-stream; name="${o.attach.name}"`, `Content-Disposition: attachment; filename="${o.attach.name}"`,
    "Content-Transfer-Encoding: base64", "", o.attach.bytes.toString("base64"), "--b1--", "",
  ].join("\r\n");
}

// ── A fake IMAP server: just the commands the client sends ─────────────────────────────────────────

function fakeImap(opts: { password: string; idle?: boolean }) {
  const box: { uid: number; raw: Buffer }[] = [];
  let nextUid = 1;
  const idlers = new Set<net.Socket>(), all = new Set<net.Socket>();
  const log: string[] = [];
  const server = net.createServer((s) => {
    all.add(s);
    s.on("error", () => {});
    s.write("* OK fake IMAP ready\r\n");
    let buf = "", idleTag: string | undefined, told = 0; // the EXISTS count this client last heard
    const ok = (tag: string, text = "done") => s.write(`${tag} OK ${text}\r\n`);
    s.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (idleTag) { if (line === "DONE") { idlers.delete(s); ok(idleTag); idleTag = undefined; } continue; }
        const [tag = "", cmd0 = "", ...rest] = line.split(" ");
        const cmd = cmd0.toUpperCase();
        log.push(cmd === "LOGIN" ? "LOGIN" : `${cmd} ${rest.join(" ")}`.trim());
        if (cmd === "CAPABILITY") { s.write(`* CAPABILITY IMAP4rev1${opts.idle === false ? "" : " IDLE"}\r\n`); ok(tag); }
        else if (cmd === "LOGIN") {
          const args = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
          if (args[1] === opts.password) ok(tag); else s.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (cmd === "SELECT") { told = box.length; s.write(`* ${box.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${nextUid}] ok\r\n`); ok(tag, "[READ-WRITE] selected"); }
        else if (cmd === "NOOP") ok(tag);
        else if (cmd === "UID" && rest[0]?.toUpperCase() === "SEARCH") {
          let uids = box.map((m) => m.uid);
          if (rest[1]?.toUpperCase() === "UID") {
            const from = Number(rest[2]!.split(":")[0]);
            const hit = uids.filter((u) => u >= from);
            uids = hit.length ? hit : uids.slice(-1); // RFC 3501: n:* always includes the last message
          }
          s.write(`* SEARCH${uids.map((u) => ` ${u}`).join("")}\r\n`); ok(tag);
        } else if (cmd === "UID" && rest[0]?.toUpperCase() === "FETCH") {
          const uid = Number(rest[1]);
          const i = box.findIndex((m) => m.uid === uid);
          if (i >= 0) s.write(Buffer.concat([Buffer.from(`* ${i + 1} FETCH (UID ${uid} BODY[] {${box[i]!.raw.length}}\r\n`, "latin1"), box[i]!.raw, Buffer.from(")\r\n")]));
          ok(tag);
        } else if (cmd === "UID") ok(tag);
        else if (cmd === "IDLE") {
          idleTag = tag; idlers.add(s); s.write("+ idling\r\n");
          if (box.length > told) { told = box.length; s.write(`* ${box.length} EXISTS\r\n`); } // mail that came before IDLE
        }
        else if (cmd === "LOGOUT") { s.write("* BYE\r\n"); ok(tag); s.end(); }
        else s.write(`${tag} BAD unknown\r\n`);
      }
    });
    s.on("close", () => { idlers.delete(s); all.delete(s); });
  });
  return {
    log, box,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port))),
    deliver(raw: string) {
      box.push({ uid: nextUid++, raw: Buffer.from(raw, "utf8") });
      for (const s of idlers) s.write(`* ${box.length} EXISTS\r\n`);
      return nextUid - 1;
    },
    close: () => new Promise<void>((r) => { for (const s of all) s.destroy(); server.close(() => r()); }),
  };
}

// ── A fake SMTP server ────────────────────────────────────────────────────────────────────────────

function fakeSmtp(opts: { user?: string; password?: string; rcptReply?: string } = {}) {
  const got: { from: string; to: string[]; data: string; auth?: string }[] = [];
  const server = net.createServer((s) => {
    s.on("error", () => {});
    s.write("220 fake ESMTP\r\n");
    let buf = "", inData = false, cur: { from: string; to: string[]; auth?: string } = { from: "", to: [] }, auth: string | undefined;
    s.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          got.push({ ...cur, data: buf.slice(0, end).replace(/^\.\./gm, "."), ...(auth ? { auth } : {}) });
          buf = buf.slice(end + 5); inData = false; cur = { from: "", to: [] };
          s.write("250 2.0.0 queued\r\n");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const verb = line.split(/[ :]/)[0]!.toUpperCase();
        if (verb === "EHLO") s.write("250-fake.example\r\n250-SIZE 1000000\r\n250 AUTH PLAIN\r\n");
        else if (verb === "AUTH") {
          const [, user, pw] = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8").split("\0");
          auth = `${user}:${pw}`;
          s.write(opts.password === undefined || pw === opts.password ? "235 2.7.0 ok\r\n" : "535 5.7.8 bad credentials\r\n");
        } else if (verb === "MAIL") { cur.from = line.match(/<([^>]*)>/)?.[1] ?? ""; s.write("250 ok\r\n"); }
        else if (verb === "RCPT") { cur.to.push(line.match(/<([^>]*)>/)?.[1] ?? ""); s.write(`${opts.rcptReply ?? "250 ok"}\r\n`); }
        else if (verb === "DATA") { inData = true; s.write("354 go\r\n"); }
        else if (verb === "QUIT") { s.write("221 bye\r\n"); s.end(); }
        else s.write("502 no\r\n");
      }
    });
  });
  return {
    got,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ── Pure ──────────────────────────────────────────────────────────────────────────────────────────

describe("mime (pure)", () => {
  test("parse: encoded subject, From name, threading ids, quoted-printable text and a base64 attachment", () => {
    const raw = [
      "From: =?UTF-8?B?RmlubiDinIU=?= <Finn@Example.com>",
      "Subject: =?utf-8?q?Caf=C3=A9_plan?=",
      "Message-ID: <m2@example.com>", "In-Reply-To: <m1@example.com>",
      "References: <root@orca.test>\r\n <m1@example.com>",
      'Content-Type: multipart/mixed; boundary="xx"', "",
      "--xx", 'Content-Type: multipart/alternative; boundary="yy"', "",
      "--yy", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
      "Ship it =E2=80=94 soon.=", "", "--yy", "Content-Type: text/html", "", "<p>Ship it</p>", "--yy--",
      "--xx", "Content-Type: text/plain; name=\"log.txt\"", "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.txt", "Content-Transfer-Encoding: base64", "",
      Buffer.from("log line").toString("base64"), "--xx--", "",
    ].join("\r\n");
    const m = parseMail(Buffer.from(raw));
    expect(m.from).toEqual({ address: "finn@example.com", name: "Finn ✅" });
    expect(m.subject).toBe("Café plan");
    expect(m.messageId).toBe("<m2@example.com>");
    expect(m.references).toEqual(["<root@orca.test>", "<m1@example.com>"]);
    expect(m.text).toBe("Ship it — soon.");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.filename).toBe("résumé.txt");
    expect(Buffer.from(m.attachments[0]!.bytes).toString()).toBe("log line");
    expect(threadOf(m)).toEqual({ root: "<root@orca.test>", messageId: "<m2@example.com>" });
  });

  test("parse: a multipart with no closing boundary keeps its last part", () => {
    const raw = 'Content-Type: multipart/mixed; boundary="q"\r\n\r\n--q\r\nContent-Type: text/plain\r\n\r\nonly part\r\n';
    expect(parseMail(Buffer.from(raw)).text).toBe("only part");
  });

  test("HTML mail becomes plain text: no style/script, blocks as lines, lists, links, entities", () => {
    const html = `<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;Orca,</p><div>Please fix <a href="https://x.test/pr/7">PR 7</a> &amp; ship.</div><ul><li>one</li><li>two</li></ul><script>alert(1)</script>Thanks<br>Finn &#8212; &#x1F600;</body></html>`;
    expect(htmlToText(html)).toBe("Hi Orca,\n\nPlease fix PR 7 (https://x.test/pr/7) & ship.\n\n- one\n- two\nThanks\nFinn — 😀");
    const m = parseMail(Buffer.from(mail({ id: "<h@x>", html })));
    expect(m.text).toContain("Please fix PR 7 (https://x.test/pr/7) & ship.");
  });

  test("a reply keeps only its new part", () => {
    expect(stripQuotedReply("Yes, merge it.\n\nOn Sat, 17 Oct 2026 at 10:00, Orca <orca@example.com> wrote:\n> CI is green.")).toBe("Yes, merge it.");
    expect(stripQuotedReply("Go.\n\nOn Sat, 17 Oct 2026 at 10:00, Orca\n<orca@example.com> wrote:\n> x")).toBe("Go.");
    expect(stripQuotedReply("Ok\n-----Original Message-----\nFrom: x")).toBe("Ok");
    expect(stripQuotedReply("> only a quote")).toBe("> only a quote");
  });

  test("the auth gate trusts only OUR server's Authentication-Results, and needs alignment with From", () => {
    const h = (...ar: string[]) => parseHeaders(ar.map((a) => `Authentication-Results: ${a}`).join("\r\n"));
    expect(authVerdict(h(PASS), "finn@example.com", { authservId: "mx.example.com" })).toMatchObject({ ok: true, reason: "dkim=pass (example.com)" });
    expect(authVerdict(h("mx.example.com; dmarc=pass header.from=example.com"), "finn@example.com")).toMatchObject({ ok: true, reason: "dmarc=pass" });
    // A sender wrote a passing header of its own BELOW the real one: ignored.
    const forged = h("mx.example.com; dkim=fail header.d=example.com; spf=softfail smtp.mailfrom=evil.test", "mx.example.com.evil; dkim=pass header.d=example.com");
    expect(authVerdict(forged, "finn@example.com", { authservId: "mx.example.com" }).ok).toBe(false);
    expect(authVerdict(forged, "finn@example.com").ok).toBe(false); // unset: only the topmost header counts
    // A valid DKIM pass for ANOTHER domain proves nothing about From.
    expect(authVerdict(h("mx.example.com; dkim=pass header.d=evil.test"), "finn@example.com").ok).toBe(false);
    // Relaxed alignment: a subdomain signature counts.
    expect(authVerdict(h("mx.example.com; dkim=pass (good) header.i=@mail.example.com"), "finn@example.com").ok).toBe(true);
    // SPF alone passes, unless DKIM is required.
    const spf = h("mx.example.com; spf=pass smtp.mailfrom=bounce@example.com");
    expect(authVerdict(spf, "finn@example.com").ok).toBe(true);
    expect(authVerdict(spf, "finn@example.com", { requireDkim: true }).ok).toBe(false);
    expect(authVerdict(parseHeaders("From: a@b"), "a@b")).toMatchObject({ ok: false, reason: "no Authentication-Results header" });
  });

  test("the full gate: own address, automated mail, the allow list, then auth", () => {
    const opts = { self: "orca@example.com", allowedSenders: ["finn@example.com", "@team.test"], authservId: "mx.example.com" };
    const g = (raw: string) => gate(parseMail(Buffer.from(raw)), opts);
    expect(g(mail({ id: "<1@x>" }))).toEqual({ ok: true });
    expect(g(mail({ id: "<2@x>", from: "orca@example.com" }))).toMatchObject({ ok: false, reason: "from Orca's own address" });
    expect(g(mail({ id: "<3@x>", extra: ["Auto-Submitted: auto-replied"] }))).toMatchObject({ ok: false });
    expect(g(mail({ id: "<4@x>", from: "eve@evil.test" }))).toMatchObject({ ok: false, reason: "eve@evil.test is not in allowedSenders" });
    expect(g(mail({ id: "<5@x>", auth: ["mx.example.com; dkim=none; spf=fail smtp.mailfrom=example.com"] })).ok).toBe(false);
    expect(senderAllowed("Ann@Team.test", opts.allowedSenders)).toBe(true);
    expect(senderAllowed("ann@notteam.test", opts.allowedSenders)).toBe(false);
    expect(senderAllowed("x@y", [])).toBe(false);
    expect(isAutomated(parseHeaders("From: MAILER-DAEMON@mx.test"))).toBe(true);
    expect(isAutomated(parseHeaders("Auto-Submitted: no"))).toBe(false);
  });

  test("build: threading headers, a UTF-8 subject, quoted-printable lines ≤ 76, an attachment; it parses back", () => {
    const h = replyHeaders("<root@example.com>", "<m3@example.com>");
    expect(h).toEqual({ inReplyTo: "<m3@example.com>", references: ["<root@example.com>", "<m3@example.com>"] });
    expect(replyHeaders(undefined, undefined)).toEqual({ references: [] });
    const long = `${"é".repeat(60)} ${"x".repeat(100)}`;
    const raw = buildMail({ from: { address: "orca@example.com", name: "Orca" }, to: "finn@example.com", subject: "CI ✗ on #7", text: `${long}\n.dot line`, messageId: outboundMessageId("42", "orca@example.com"), ...h, attachments: [{ filename: "a.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello") }] });
    expect(raw.split("\r\n").every((l) => l.length <= 998)).toBe(true);
    expect(qpEncode(long).split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(raw).toContain("Auto-Submitted: auto-generated");
    const back = parseMail(Buffer.from(raw));
    expect(back).toMatchObject({ subject: "CI ✗ on #7", messageId: "<orca.42@example.com>", inReplyTo: "<m3@example.com>", references: ["<root@example.com>", "<m3@example.com>"], from: { address: "orca@example.com", name: "Orca" } });
    expect(back.text).toBe(`${long}\n.dot line`);
    expect(Buffer.from(back.attachments[0]!.bytes).toString()).toBe("hello");
    expect(dotStuff(".a\n.b")).toBe("..a\r\n..b");
  });

  test("config, subject and inbound text", () => {
    expect(emailConfig({})).toMatchObject({ error: expect.stringContaining("address") });
    expect(emailConfig({ address: "o@x", outbound: "resend", resend: { secretRef: "RESEND_KEY" } })).toMatchObject({ error: expect.stringContaining("ORCA_SECRET_") });
    expect(emailConfig({ address: "O@X", outbound: "smtp" })).toMatchObject({ error: expect.stringContaining("smtp.host") });
    expect(emailConfig({ address: "O@X" })).toMatchObject({ config: { address: "o@x", outbound: "none", allowedSenders: [] } });
    expect(outboundSubject({ title: "CI failed", text: "x" }, true)).toBe("Re: CI failed");
    expect(outboundSubject({ text: "\nfirst line\nsecond" }, false)).toBe("first line");
    const m = parseMail(Buffer.from(mail({ id: "<i@x>", subject: "Plan", text: "Do it.\n\nOn Fri, Orca wrote:\n> old" })));
    expect(inboundText(m, { skipped: ["big.zip is over 20 MB"] })).toBe("Subject: Plan\n\nDo it.\n\n[attachment not kept: big.zip is over 20 MB]");
  });
});

// ── Outbound without the database ───────────────────────────────────────────────────────────────

const conn = (config: Record<string, unknown>, secretRef = "ORCA_SECRET_TEST_IMAP"): Connection => ({ id: "mail", kind: "email", name: "Orca mail", instance: "local", config, secretRef, enabled: true });

describe("outbound", () => {
  afterEach(() => { delete process.env.ORCA_SECRET_TEST_IMAP; delete process.env.ORCA_SECRET_TEST_SMTP; delete process.env.ORCA_SECRET_TEST_RESEND; });

  test("SMTP: AUTH PLAIN with the named secret, the delivery id in the Message-ID, threading headers; 4xx retries, 5xx and bad auth do not", async () => {
    process.env.ORCA_SECRET_TEST_SMTP = "smtp-pw";
    const smtp = fakeSmtp({ password: "smtp-pw" });
    const port = await smtp.listen();
    try {
      const a = emailAdapter(conn({ address: "orca@example.com", fromName: "Orca", outbound: "smtp", smtp: { host: "127.0.0.1", port, security: "none", secretRef: "ORCA_SECRET_TEST_SMTP" } }));
      expect(a.caps).toMatchObject({ inbound: "none", outbound: true, threads: true, attachments: true });
      const r = await a.send({ externalId: "Finn@Example.com", threadId: "<root@example.com>" }, { text: "CI is red.", title: "CI failed on #7", url: "https://x.test/7", replyToExternalMsgId: "<m9@example.com>" }, "17");
      expect(r).toEqual({ ok: true, externalMsgId: "<orca.17@example.com>", threadId: "<root@example.com>" });
      expect(smtp.got).toHaveLength(1);
      expect(smtp.got[0]).toMatchObject({ from: "orca@example.com", to: ["finn@example.com"], auth: "orca@example.com:smtp-pw" });
      const sent = parseMail(Buffer.from(smtp.got[0]!.data));
      expect(sent).toMatchObject({ subject: "Re: CI failed on #7", messageId: "<orca.17@example.com>", inReplyTo: "<m9@example.com>", references: ["<root@example.com>", "<m9@example.com>"] });
      expect(sent.text).toBe("CI is red.\n\nhttps://x.test/7");
      // A first post starts the thread: its own Message-ID is the thread id.
      expect(await a.send({ externalId: "finn@example.com" }, { text: "new" }, "18")).toMatchObject({ ok: true, threadId: "<orca.18@example.com>" });
      expect(await a.send({ externalId: "not-an-address" }, { text: "x" }, "19")).toMatchObject({ ok: false, retryable: false });
    } finally { await smtp.close(); }

    for (const [reply, password, retryable] of [["451 4.3.0 try later", "smtp-pw", true], ["550 5.1.1 no such user", "smtp-pw", false], ["250 ok", "other", false]] as const) {
      const s = fakeSmtp({ password, rcptReply: reply });
      const p = await s.listen();
      try {
        const a = emailAdapter(conn({ address: "orca@example.com", outbound: "smtp", smtp: { host: "127.0.0.1", port: p, security: "none", secretRef: "ORCA_SECRET_TEST_SMTP" } }));
        expect(await a.send({ externalId: "finn@example.com" }, { text: "x" }, "1")).toMatchObject({ ok: false, retryable });
      } finally { await s.close(); }
    }
    // Nobody listening: a network error, retryable.
    const a = emailAdapter(conn({ address: "orca@example.com", outbound: "smtp", smtp: { host: "127.0.0.1", port: 1, security: "none" } }));
    expect(await a.send({ externalId: "finn@example.com" }, { text: "x" }, "1")).toMatchObject({ ok: false, retryable: true });
  });

  test("Resend: the key as Idempotency-Key, threading in headers; 429 retries after Retry-After, 422 is final", async () => {
    process.env.ORCA_SECRET_TEST_RESEND = "re_test";
    const seen: { auth: string | null; idem: string | null; body: any }[] = [];
    let status = 200;
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({ auth: req.headers.get("authorization"), idem: req.headers.get("idempotency-key"), body: await req.json() });
        return status === 200 ? Response.json({ id: "re_1" }) : new Response("{}", { status, headers: status === 429 ? { "retry-after": "7" } : {} });
      },
    });
    try {
      const a = emailAdapter(conn({ address: "orca@example.com", fromName: "Orca", outbound: "resend", resend: { secretRef: "ORCA_SECRET_TEST_RESEND", apiUrl: `http://127.0.0.1:${server.port}/emails` } }));
      expect(await a.send({ externalId: "finn@example.com", threadId: "<root@example.com>" }, { text: "Done.", title: "Merged" }, "5")).toEqual({ ok: true, externalMsgId: "<orca.5@example.com>", threadId: "<root@example.com>" });
      expect(seen[0]).toMatchObject({ auth: "Bearer re_test", idem: "5", body: { from: "Orca <orca@example.com>", to: ["finn@example.com"], subject: "Re: Merged", text: "Done.", headers: { "Message-ID": "<orca.5@example.com>", "In-Reply-To": "<root@example.com>", References: "<root@example.com>" } } });
      status = 429;
      expect(await a.send({ externalId: "finn@example.com" }, { text: "x" }, "6")).toMatchObject({ ok: false, retryable: true, retryAfterMs: 7_000 });
      status = 422;
      expect(await a.send({ externalId: "finn@example.com" }, { text: "x" }, "7")).toMatchObject({ ok: false, retryable: false });
      delete process.env.ORCA_SECRET_TEST_RESEND;
      expect(await a.send({ externalId: "finn@example.com" }, { text: "x" }, "8")).toMatchObject({ ok: false, retryable: false, error: "ORCA_SECRET_TEST_RESEND is not set" });
    } finally { server.stop(true); }
  });
});

// ── Inbound and the round trip, with the real core ──────────────────────────────────────────────

describe("with Postgres", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  let imap: ReturnType<typeof fakeImap>;
  let smtp: ReturnType<typeof fakeSmtp>;
  let ports: { imap: number; smtp: number };
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    process.env.ORCA_SECRET_TEST_IMAP = "imap-pw";
    pg = await freshSchema("email");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    imap = fakeImap({ password: "imap-pw" });
    smtp = fakeSmtp();
    ports = { imap: await imap.listen(), smtp: await smtp.listen() };
  });
  afterEach(async () => {
    await registry.stopAll();
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    await imap.close();
    await smtp.close();
    await db.close();
    await pg.drop();
    delete process.env.ORCA_SECRET_TEST_IMAP;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const config = (extra: Record<string, unknown> = {}) => ({
    address: "orca@example.com", imap: { host: "127.0.0.1", port: ports.imap, tls: false }, outbound: "smtp",
    smtp: { host: "127.0.0.1", port: ports.smtp, security: "none" }, allowedSenders: ["finn@example.com", "eve@evil.test"], authservId: "mx.example.com", ...extra,
  });
  const setup = async (extra: Record<string, unknown> = {}) => {
    const c = conn(config(extra));
    await store.addIntegration(c);
    await store.addLink({ id: "E1", integrationId: "mail", externalId: "finn@example.com", level: "work", repos: ["r"], requireMention: false });
    await store.addLink({ id: "E2", integrationId: "mail", externalId: "eve@evil.test", level: "work", repos: ["r"], requireMention: false });
    await store.addPrincipal({ id: "finn", name: "Finn", maxLevel: "work" }, [{ adapter: "email", externalId: "finn@example.com" }]);
    return c;
  };
  const cursorAt = (uid: number) => until(async () => (await store.cursor("mail")) === `7:${uid}`);

  test("IDLE: old mail is not replayed; a passing mail from a paired sender reaches the orchestrator with its text, thread and attachments; forged, unlisted and oversized parts do not", async () => {
    imap.deliver(mail({ id: "<old@example.com>", text: "from before Orca listened" }));
    const c = await setup();
    expect(await registry.startOne(c)).toBe(true);
    expect(await store.cursor("mail")).toBe("7:1");
    await until(() => imap.log.includes("IDLE"));

    imap.deliver(mail({ id: "<new@example.com>", subject: "Status?", html: "<p>What is <b>running</b>?</p>", attach: { name: "notes.txt", bytes: Buffer.from("n1") } }));
    const ev = await until(() => store.event("email:mail:<new@example.com>"));
    expect(ev).toMatchObject({
      topic: "ext.email.message", title: "Status?", text: "Subject: Status?\n\nWhat is running?",
      source: { adapter: "email", integrationId: "mail", channel: "finn@example.com", linkId: "E1" },
      actor: { principalId: "finn", external: { adapter: "email", id: "finn@example.com", name: "Finn" } },
      thread: { adapter: "email", externalId: "<new@example.com>", messageId: "<new@example.com>" },
      grant: { level: "work", repos: ["r"] },
    });
    expect(ev.attachments).toHaveLength(1);
    const id = ev.attachments![0]!.match(/([0-9a-f-]{36})/)![1]!;
    expect(Buffer.from((await db.attachment(id))!.bytes).toString()).toBe("n1");
    expect((await store.deliveries()).map((d) => d.target.kind)).toEqual(["orchestrator"]);
    expect(await store.event("email:mail:<old@example.com>")).toBeUndefined();

    // Forged: a passing header from someone else's server, ours says fail. Allowed + linked, still dropped.
    imap.deliver(mail({ id: "<forged@example.com>", auth: ["mx.example.com; dkim=fail; spf=fail smtp.mailfrom=evil.test", "attacker.test; dkim=pass header.d=example.com"] }));
    imap.deliver(mail({ id: "<stranger@evil.test>", from: "mallory@evil.test", auth: ["mx.example.com; dkim=pass header.d=evil.test"] }));
    // Allowed and authenticated, but not a paired person: the core's gate rejects it.
    imap.deliver(mail({ id: "<eve@evil.test>", from: "eve@evil.test", auth: ["mx.example.com; dkim=pass header.d=evil.test"] }));
    await cursorAt(5);
    for (const k of ["forged@example.com", "stranger@evil.test", "eve@evil.test"]) expect(await store.event(`email:mail:<${k}>`)).toBeUndefined();
    expect(imap.log.filter((l) => l.startsWith("UID STORE")).length).toBe(4); // every read mail is marked \Seen

    // The cursor survives a restart: nothing is read twice.
    await registry.stopAll();
    imap.deliver(mail({ id: "<after@example.com>", text: "after restart" }));
    expect(await registry.startOne(c)).toBe(true);
    await until(() => store.event("email:mail:<after@example.com>"));
    expect(imap.log.filter((l) => l.startsWith("UID FETCH")).map((l) => l.split(" ")[2])).toEqual(["2", "3", "4", "5", "6"]);
  });

  test("round trip: an Orca event mails the sender and starts the workstream's thread; the reply finds that workstream", async () => {
    const c = await setup();
    expect(await registry.startOne(c)).toBe(true);
    dispatcher.configure({ adapter: (i) => registry.adapterFor(i) });
    dispatcher.setRunning(registry.runningIds);
    await store.addSubscription({ topicPattern: "orca.run.*", filter: { repo: "r" }, targetKind: "link", targetId: "E1" });

    await router.publish({ key: "run:1:finished", topic: "orca.run.finished", at: 1, source: { adapter: "orca" }, scope: { repo: "r", branch: "b" }, title: "Fix login", text: "Done: the login form works." });
    expect(await dispatcher.dispatchOnce()).toBe(1);
    expect(smtp.got).toHaveLength(1);
    const first = parseMail(Buffer.from(smtp.got[0]!.data));
    const [d] = await store.deliveries();
    expect(first).toMatchObject({ subject: "Fix login", messageId: `<orca.${d!.id}@example.com>`, text: "Done: the login form works." });
    expect(d).toMatchObject({ state: "sent", externalMsgId: first.messageId });
    expect(await store.threadLink("email", first.messageId!)).toMatchObject({ repo: "r", branch: "b", linkId: "E1" });

    // The second post about the workstream continues the thread.
    await router.publish({ key: "run:2:failed", topic: "orca.run.failed", at: 2, source: { adapter: "orca" }, scope: { repo: "r", branch: "b" }, title: "Fix login", text: "Tests failed." });
    expect(await dispatcher.dispatchOnce()).toBe(1);
    const second = parseMail(Buffer.from(smtp.got[1]!.data));
    expect(second).toMatchObject({ subject: "Re: Fix login", inReplyTo: first.messageId, references: [first.messageId] });

    // Finn answers the second mail: the root of References is Orca's first Message-ID → the workstream.
    imap.deliver(mail({ id: "<reply@example.com>", subject: "Re: Fix login", inReplyTo: second.messageId, references: `${first.messageId} ${second.messageId}`, text: "Retry with the new fixture.\n\nOn Sat, Orca wrote:\n> Tests failed." }));
    const ev = await until(() => store.event("email:mail:<reply@example.com>"));
    expect(ev).toMatchObject({ text: "Subject: Re: Fix login\n\nRetry with the new fixture.", thread: { externalId: first.messageId, messageId: "<reply@example.com>" } });
    const targets = (await store.deliveries()).filter((x) => x.envelope.key === ev.key).map((x) => x.target);
    expect(targets).toEqual([{ kind: "workstream", repo: "r", branch: "b" }]);
  });

  test("pairing: an allowed, authenticated stranger on the catch-all link gets a code by mail, in reply to their mail", async () => {
    const c = await setup({ allowedSenders: ["@example.com"] });
    await store.addLink({ id: "EALL", integrationId: "mail", externalId: "*", level: "ask", repos: [], requireMention: false });
    expect(await registry.startOne(c)).toBe(true);
    dispatcher.configure({ adapter: (i) => registry.adapterFor(i) });
    dispatcher.setRunning(registry.runningIds);
    imap.deliver(mail({ id: "<ann1@example.com>", from: "Ann <ann@example.com>", text: "Hi, can I use Orca?" }));
    await cursorAt(1);
    expect(await store.event("email:mail:<ann1@example.com>")).toBeUndefined(); // dropped until approved
    await until(async () => (await dispatcher.dispatchOnce()) > 0 && smtp.got.length > 0);
    expect(smtp.got[0]!.to).toEqual(["ann@example.com"]);
    const reply = parseMail(Buffer.from(smtp.got[0]!.data));
    expect(reply).toMatchObject({ inReplyTo: "<ann1@example.com>", references: ["<ann1@example.com>"] });
    expect(reply.text).toMatch(/[A-Z0-9]{4,}/);
  });

  test("poll fallback: a server without IDLE is polled; a wrong password fails the start", async () => {
    await imap.close();
    imap = fakeImap({ password: "imap-pw", idle: false });
    ports.imap = await imap.listen();
    const c = await setup({ pollSeconds: 0.05 });
    expect(await registry.startOne(c)).toBe(true);
    imap.deliver(mail({ id: "<p1@example.com>", text: "polled" }));
    await until(() => store.event("email:mail:<p1@example.com>"));
    expect(imap.log).not.toContain("IDLE");
    expect(imap.log).toContain("NOOP");
    expect((await registry.health()).mail).toMatchObject({ kind: "email", ok: true, detail: "polling every 0.05s" });
    await registry.stopAll();

    process.env.ORCA_SECRET_TEST_IMAP = "wrong";
    expect(await registry.startOne(c)).toBe(false);
    expect((await store.integration("mail")) as unknown).toBeDefined();
    expect(registry.runningIds()).toEqual([]);
  });
});
