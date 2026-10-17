// A minimal IMAP4rev1 client (RFC 3501) with IDLE (RFC 2177): only what the email adapter needs —
// LOGIN, SELECT, UID SEARCH, UID FETCH BODY.PEEK[], UID STORE \Seen, IDLE/DONE, LOGOUT. No library:
// Orca's server has no npm dependencies, and these commands fit in one small file. The framing reads
// literals (`{n}\r\n` + n bytes) as bytes, so 8-bit mail survives.
import * as net from "net";
import * as tls from "tls";

export type ImapOptions = { host: string; port: number; tls: boolean; user: string; password: string; timeoutMs?: number };

/** One server response: the text with each literal replaced by `{n}`, plus the literals in order. */
export type ImapLine = { text: string; literals: Buffer[] };

export class ImapError extends Error {
  constructor(message: string, readonly status?: "NO" | "BAD") { super(message); }
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export class ImapClient {
  private buf = Buffer.alloc(0);
  private lines: ImapLine[] = [];
  private waiters: (() => void)[] = [];
  private closed?: Error;
  private tag = 0;
  capabilities = new Set<string>();

  private constructor(private sock: net.Socket) {
    sock.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.frame(); });
    const end = (e?: Error) => { this.closed ??= e ?? new Error("IMAP connection closed"); this.wake(); };
    sock.on("error", end);
    sock.on("close", () => end());
  }

  static async connect(o: ImapOptions): Promise<ImapClient> {
    const timeout = o.timeoutMs ?? 15_000;
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s: net.Socket = o.tls
        ? tls.connect({ host: o.host, port: o.port, servername: o.host }, () => resolve(s))
        : net.connect({ host: o.host, port: o.port }, () => resolve(s));
      s.once("error", reject);
      s.setTimeout(timeout, () => s.destroy(new Error(`IMAP connect to ${o.host}:${o.port} timed out`)));
    });
    sock.setTimeout(0);
    const c = new ImapClient(sock);
    try {
      const greet = await c.next(timeout);
      if (!/^\* (OK|PREAUTH)/i.test(greet.text)) throw new ImapError(`IMAP greeting: ${greet.text}`);
      await c.command(`LOGIN ${quote(o.user)} ${quote(o.password)}`, timeout);
      const caps = await c.command("CAPABILITY", timeout);
      for (const l of caps.untagged) if (/^\* CAPABILITY /i.test(l.text)) for (const t of l.text.split(" ").slice(2)) c.capabilities.add(t.toUpperCase());
      return c;
    } catch (e) { sock.destroy(); throw e; }
  }

  private wake() { for (const w of this.waiters.splice(0)) w(); }

  /** Cut the byte buffer into response lines, keeping literals whole. */
  private frame() {
    for (;;) {
      let pos = 0, text = "";
      const literals: Buffer[] = [];
      for (;;) {
        const nl = this.buf.indexOf("\r\n", pos);
        if (nl < 0) return; // wait for more bytes
        const part = this.buf.subarray(pos, nl).toString("latin1");
        const lit = part.match(/\{(\d+)\+?\}$/);
        if (!lit) { text += part; pos = nl + 2; break; }
        const n = Number(lit[1]);
        if (this.buf.length < nl + 2 + n) return;
        text += part;
        literals.push(Buffer.from(this.buf.subarray(nl + 2, nl + 2 + n)));
        pos = nl + 2 + n;
      }
      this.buf = this.buf.subarray(pos);
      this.lines.push({ text, literals });
      this.wake();
    }
  }

  /** The next response line, or throw on close / timeout / abort. */
  async next(timeoutMs = 60_000, signal?: AbortSignal): Promise<ImapLine> {
    for (;;) {
      const l = this.lines.shift();
      if (l) return l;
      if (this.closed) throw this.closed;
      if (signal?.aborted) throw new Error("aborted");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => this.wake();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timedOut = await new Promise<boolean>((resolve) => {
        this.waiters.push(() => resolve(false));
        timer = setTimeout(() => resolve(true), timeoutMs);
      });
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) throw new Error("IMAP timeout");
    }
  }

  private send(line: string) { this.sock.write(`${line}\r\n`); }

  /** Run one tagged command; the untagged lines before its OK. NO / BAD throw. */
  async command(cmd: string, timeoutMs = 60_000): Promise<{ untagged: ImapLine[]; text: string }> {
    const tag = `A${++this.tag}`;
    this.send(`${tag} ${cmd}`);
    const untagged: ImapLine[] = [];
    for (;;) {
      const l = await this.next(timeoutMs);
      if (l.text.startsWith(`${tag} `)) {
        const [, status, rest] = l.text.match(/^\S+ (\w+) ?(.*)$/) ?? [];
        if (status?.toUpperCase() === "OK") return { untagged, text: rest ?? "" };
        const what = cmd.startsWith("LOGIN") ? "LOGIN" : cmd.split(" ")[0];
        throw new ImapError(`IMAP ${what}: ${status} ${rest ?? ""}`.trim(), status?.toUpperCase() === "NO" ? "NO" : "BAD");
      }
      untagged.push(l);
    }
  }

  /** SELECT a mailbox; its UIDVALIDITY and UIDNEXT. */
  async select(mailbox: string): Promise<{ uidValidity: number; uidNext?: number; exists: number }> {
    const r = await this.command(`SELECT ${quote(mailbox)}`);
    let uidValidity = 0, uidNext: number | undefined, exists = 0;
    for (const l of r.untagged) {
      const v = l.text.match(/\[UIDVALIDITY (\d+)\]/i); if (v) uidValidity = Number(v[1]);
      const n = l.text.match(/\[UIDNEXT (\d+)\]/i); if (n) uidNext = Number(n[1]);
      const e = l.text.match(/^\* (\d+) EXISTS/i); if (e) exists = Number(e[1]);
    }
    return { uidValidity, uidNext, exists };
  }

  /** UIDs above `after`, ascending. (`n:*` also answers the last message when it is below n.) */
  async uidsAfter(after: number): Promise<number[]> {
    const r = await this.command(`UID SEARCH UID ${after + 1}:*`);
    const uids = r.untagged.filter((l) => /^\* SEARCH/i.test(l.text)).flatMap((l) => l.text.split(" ").slice(2).map(Number));
    return uids.filter((u) => Number.isFinite(u) && u > after).sort((a, b) => a - b);
  }

  /** The highest UID in the mailbox, or 0. */
  async maxUid(): Promise<number> {
    const r = await this.command("UID SEARCH ALL");
    const uids = r.untagged.filter((l) => /^\* SEARCH/i.test(l.text)).flatMap((l) => l.text.split(" ").slice(2).map(Number)).filter(Number.isFinite);
    return uids.length ? Math.max(...uids) : 0;
  }

  /** One message's raw bytes, without setting \Seen; undefined when the server has no such UID. */
  async fetch(uid: number): Promise<Uint8Array | undefined> {
    const r = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    for (const l of r.untagged) {
      if (!/FETCH/i.test(l.text) || !l.literals.length) continue;
      const u = l.text.match(/UID (\d+)/i);
      if (u && Number(u[1]) !== uid) continue;
      return l.literals[0];
    }
    return undefined;
  }

  async markSeen(uid: number): Promise<void> { await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`); }

  /** IDLE until the server reports new mail (`EXISTS`), `maxMs` passes (RFC 2177: re-issue within
   *  29 minutes) or `signal` aborts. True = something arrived. */
  async idle(maxMs: number, signal?: AbortSignal): Promise<boolean> {
    const tag = `A${++this.tag}`;
    this.send(`${tag} IDLE`);
    const cont = await this.next(30_000);
    if (!cont.text.startsWith("+")) throw new ImapError(`IMAP IDLE: ${cont.text}`);
    let arrived = false;
    const until = Date.now() + maxMs;
    while (!arrived && !signal?.aborted && Date.now() < until) {
      try {
        const l = await this.next(Math.max(1, until - Date.now()), signal);
        if (/^\* \d+ (EXISTS|RECENT)/i.test(l.text)) arrived = true;
      } catch (e) {
        if (this.closed) throw this.closed;
        if (!(e instanceof Error) || !/timeout|aborted/.test(e.message)) throw e;
      }
    }
    if (this.closed) throw this.closed;
    this.send("DONE");
    for (;;) {
      const l = await this.next(30_000);
      if (l.text.startsWith(`${tag} `)) break;
      if (/^\* \d+ EXISTS/i.test(l.text)) arrived = true;
    }
    return arrived;
  }

  async logout(): Promise<void> {
    try { if (!this.closed) await this.command("LOGOUT", 2_000); } catch { /* closing anyway */ }
    this.sock.destroy();
  }
}
