// A minimal SMTP submission client (RFC 5321, AUTH PLAIN RFC 4616, STARTTLS RFC 3207): connect, EHLO,
// optional STARTTLS, AUTH, MAIL/RCPT/DATA, QUIT. One message per connection — Orca sends a few mails
// an hour, so a pool buys nothing. No library, like the IMAP client.
import * as net from "net";
import * as tls from "tls";
import { dotStuff } from "./mime";

/** `implicit` = TLS from the first byte (port 465); `starttls` = upgrade on 587; `none` = plain (tests, a local relay). */
export type SmtpSecurity = "implicit" | "starttls" | "none";
export type SmtpOptions = { host: string; port: number; security: SmtpSecurity; user?: string; password?: string; heloName?: string; timeoutMs?: number };

/** A reply the server refused, with its code: 4xx is temporary, 5xx is permanent. */
export class SmtpError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
  get retryable(): boolean { return this.code === undefined || (this.code >= 400 && this.code < 500); }
}

class Conn {
  private buf = "";
  private waiter?: () => void;
  private closed?: Error;
  constructor(public sock: net.Socket, private timeoutMs: number) { this.attach(); }

  attach() {
    this.sock.on("data", (d: Buffer) => { this.buf += d.toString("latin1"); this.waiter?.(); });
    const end = (e?: Error) => { this.closed ??= e ?? new Error("SMTP connection closed"); this.waiter?.(); };
    this.sock.on("error", end);
    this.sock.on("close", () => end());
  }

  /** One whole reply (`250-…` lines up to `250 …`). */
  async reply(): Promise<{ code: number; text: string }> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const m = this.buf.match(/^((?:\d{3}-[^\r\n]*\r?\n)*)(\d{3})(?: [^\r\n]*)?\r?\n/);
      if (m) {
        const text = m[0].trim();
        this.buf = this.buf.slice(m[0].length);
        return { code: Number(m[2]), text };
      }
      if (this.closed) throw new SmtpError(this.closed.message);
      const left = deadline - Date.now();
      if (left <= 0) throw new SmtpError("SMTP timeout");
      await new Promise<void>((r) => { const t = setTimeout(r, left); this.waiter = () => { clearTimeout(t); r(); }; });
      this.waiter = undefined;
    }
  }

  async cmd(line: string, ok: number[], what = line.split(" ")[0]): Promise<{ code: number; text: string }> {
    if (line) this.sock.write(`${line}\r\n`);
    const r = await this.reply();
    if (!ok.includes(r.code)) throw new SmtpError(`SMTP ${what}: ${r.text.replace(/\s+/g, " ")}`, r.code);
    return r;
  }
}

function open(o: SmtpOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s: net.Socket = o.security === "implicit"
      ? tls.connect({ host: o.host, port: o.port, servername: o.host }, () => resolve(s))
      : net.connect({ host: o.host, port: o.port }, () => resolve(s));
    s.once("error", reject);
    s.setTimeout(o.timeoutMs ?? 30_000, () => s.destroy(new Error(`SMTP connect to ${o.host}:${o.port} timed out`)));
  });
}

/** Send one message. Throws SmtpError (with `.retryable`) on any failure. */
export async function sendMail(o: SmtpOptions, env: { from: string; to: string[] }, message: string): Promise<{ response: string }> {
  const timeout = o.timeoutMs ?? 30_000;
  let sock: net.Socket;
  try { sock = await open(o); } catch (e) { throw new SmtpError(e instanceof Error ? e.message : String(e)); }
  sock.setTimeout(0);
  let c = new Conn(sock, timeout);
  const helo = o.heloName ?? "orca.local";
  try {
    await c.cmd("", [220], "greeting");
    let ehlo = await c.cmd(`EHLO ${helo}`, [250]);
    if (o.security === "starttls") {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError("SMTP server does not offer STARTTLS", 554);
      await c.cmd("STARTTLS", [220]);
      sock.removeAllListeners("data");
      const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({ socket: sock, servername: o.host }, () => resolve(t));
        t.once("error", reject);
      });
      sock = secure;
      c = new Conn(secure, timeout);
      ehlo = await c.cmd(`EHLO ${helo}`, [250]);
    }
    if (o.user) {
      const plain = Buffer.from(`\0${o.user}\0${o.password ?? ""}`, "utf8").toString("base64");
      await c.cmd(`AUTH PLAIN ${plain}`, [235], "AUTH");
    }
    await c.cmd(`MAIL FROM:<${env.from}>`, [250], "MAIL FROM");
    for (const to of env.to) await c.cmd(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await c.cmd("DATA", [354]);
    const body = dotStuff(message);
    sock.write(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
    const done = await c.cmd("", [250], "DATA");
    c.sock.write("QUIT\r\n");
    return { response: done.text };
  } finally {
    setTimeout(() => sock.destroy(), 100).unref?.();
  }
}
