// The Discord adapter against a fake Gateway socket and a stubbed REST API — never a real Discord.
// It covers what the adapter owns: the Gateway handshake (identify, heartbeat, resume), turning a
// MESSAGE_CREATE into the core's envelope (mention, thread, DM link), the thread a request opens,
// and outbound posts, threads, edits and the retry split. The gate itself is the core's (tests/integrations.test.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { discordAdapter, gateway, INTENTS, render, toEnvelope, type WebSocketLike } from "../server/integrations/adapters/discord";
import type { AdapterContext, Connection, InboundEnvelope } from "../server/integrations/adapter";

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  sent: { op: number; d: any }[] = [];
  closed?: number;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.closed = code; }
  /** The server side: push a payload, or drop the connection. */
  push(p: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(p) }); }
  drop(code: number) { this.onclose?.({ code }); }
}

type Call = { method: string; path: string; body?: any };
let calls: Call[] = [];
let answer: (c: Call) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: {} });
const realFetch = globalThis.fetch;
const realWs = gateway.WebSocket;
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  calls = [];
  FakeSocket.all = [];
  process.env.ORCA_SECRET_DISCORD_TEST = "tok";
  gateway.WebSocket = FakeSocket as never;
  gateway.baseBackoffMs = 5;
  globalThis.fetch = (async (url: any, init: any) => {
    const c: Call = { method: init?.method ?? "GET", path: String(url).replace("https://discord.com/api/v10", ""), body: init?.body ? JSON.parse(init.body) : undefined };
    expect(init?.headers?.authorization).toBe("Bot tok");
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: a.headers });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  gateway.WebSocket = realWs;
  gateway.baseBackoffMs = 1_000;
  delete process.env.ORCA_SECRET_DISCORD_TEST;
});

const conn = (config: Record<string, unknown> = {}): Connection =>
  ({ id: "dc", kind: "discord", name: "Personal Discord", instance: "orca-personal-box", config, secretRef: "ORCA_SECRET_DISCORD_TEST", enabled: true });

function fakeCtx(verdict: "new" | "duplicate" | "rejected" = "new") {
  const ingested: InboundEnvelope[] = [];
  const statuses: { ok: boolean; detail?: string }[] = [];
  const abort = new AbortController();
  const ctx: AdapterContext = {
    connection: conn(), secret: () => "tok", signal: abort.signal, log: () => {},
    ingest: async (e) => { ingested.push(e); return verdict; },
    cursor: { get: async () => undefined, set: async () => {} },
    status: async (s) => { statuses.push(s); },
  };
  return { ctx, ingested, statuses, abort };
}

/** Start an adapter and walk the socket through Hello and READY. */
async function connected(config: Record<string, unknown> = {}, verdict: "new" | "duplicate" | "rejected" = "new") {
  answer = (c) => c.path === "/gateway/bot" ? { status: 200, body: { url: "wss://gw.test" } }
    : c.path.startsWith("/channels/C1") && c.method === "GET" ? { status: 200, body: { id: "C1", type: 0 } }
    : c.path === "/channels/T9" ? { status: 200, body: { id: "T9", type: 11, parent_id: "C1" } }
    : { status: 200, body: { id: "M-new" } };
  const a = discordAdapter(conn(config));
  const f = fakeCtx(verdict);
  await a.start(f.ctx);
  const ws = FakeSocket.all[0]!;
  ws.push({ op: 10, d: { heartbeat_interval: 60_000 } });
  ws.push({ op: 0, s: 1, t: "READY", d: { session_id: "S1", resume_gateway_url: "wss://resume.test", user: { id: "BOT", username: "orca" } } });
  return { a, ws, ...f };
}

const msg = (over: Record<string, unknown> = {}) => ({
  id: "M1", channel_id: "C1", guild_id: "G1", content: "<@BOT> what is on the board?", timestamp: "2026-10-17T10:00:00Z",
  author: { id: "U-saajan", username: "saajan", global_name: "Saajan" }, mentions: [{ id: "BOT" }], ...over,
});

describe("Discord Gateway", () => {
  test("identifies with the four intents and the token, on the URL /gateway/bot gives", async () => {
    const { a, ws, statuses } = await connected();
    expect(ws.url).toBe("wss://gw.test/?v=10&encoding=json");
    const id = ws.sent.find((p) => p.op === 2)!;
    expect(id.d.token).toBe("tok");
    expect(id.d.intents).toBe(INTENTS);
    expect(INTENTS & (1 << 15)).toBeTruthy(); // MESSAGE_CONTENT
    expect(statuses.at(-1)).toMatchObject({ ok: true, detail: "connected as orca" });
    await a.stop();
  });

  test("a bad token fails the start; a missing one too", async () => {
    answer = () => ({ status: 401, body: { message: "401: Unauthorized" } });
    await expect(discordAdapter(conn()).start(fakeCtx().ctx)).rejects.toThrow(/refused the bot token/);
    delete process.env.ORCA_SECRET_DISCORD_TEST;
    await expect(discordAdapter(conn()).start(fakeCtx().ctx)).rejects.toThrow(/ORCA_SECRET_DISCORD_TEST is not set/);
  });

  test("a dropped socket reconnects and resumes the session; a fatal close does not reconnect", async () => {
    const { a, ws, statuses } = await connected();
    ws.drop(1006);
    expect(statuses.at(-1)).toMatchObject({ ok: false });
    await new Promise((r) => setTimeout(r, 30));
    const next = FakeSocket.all[1]!;
    expect(next.url).toBe("wss://resume.test/?v=10&encoding=json");
    next.push({ op: 10, d: { heartbeat_interval: 60_000 } });
    expect(next.sent[0]).toEqual({ op: 6, d: { token: "tok", session_id: "S1", seq: 1 } });
    next.drop(4014); // disallowed intent: Message Content is off in the portal
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeSocket.all.length).toBe(2);
    expect(statuses.at(-1)?.detail).toMatch(/4014.*Message Content/);
    await a.stop();
  });
});

describe("Discord inbound", () => {
  test("a mention in a linked channel becomes an envelope, and its thread opens on the message", async () => {
    const { a, ws, ingested } = await connected();
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg() });
    await tick();
    expect(ingested).toHaveLength(1);
    const e = ingested[0]!;
    expect(e).toMatchObject({
      key: "discord:M1", topic: "ext.discord.message", text: "what is on the board?", mentioned: true,
      source: { adapter: "discord", integrationId: "dc", channel: "C1" },
      actor: { external: { adapter: "discord", id: "U-saajan", name: "Saajan" } },
      thread: { adapter: "discord", externalId: "M1" },
    });
    expect(JSON.stringify(e.raw)).not.toContain("tok");
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/channels/C1/messages/M1/threads", body: { name: "what is on the board?" } });
    await a.stop();
  });

  test("a rejected or duplicate event opens no thread", async () => {
    for (const verdict of ["rejected", "duplicate"] as const) {
      calls = [];
      const { a, ws } = await connected({}, verdict);
      ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg() });
      await tick();
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      await a.stop();
      FakeSocket.all = [];
    }
  });

  test("a message in a thread is linked by its parent channel and carries the thread", async () => {
    const { a, ws, ingested } = await connected();
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg({ id: "M2", channel_id: "T9", content: "<@BOT> also fix the footer" }) });
    await tick();
    expect(ingested[0]).toMatchObject({ source: { channel: "C1" }, thread: { externalId: "T9" }, text: "also fix the footer" });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]); // already in a thread
    await a.stop();
  });

  test("no mention is passed on as mentioned: false; a bot's message is ignored", async () => {
    const { a, ws, ingested } = await connected();
    ws.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg({ id: "M3", content: "lunch?", mentions: [] }) });
    ws.push({ op: 0, s: 3, t: "MESSAGE_CREATE", d: msg({ id: "M4", author: { id: "OTHER", bot: true } }) });
    await tick();
    expect(ingested.map((e) => [e.key, e.mentioned])).toEqual([["discord:M3", false]]);
    await a.stop();
  });

  test("a DM goes to the configured DM link, else to the core's catch-all link by its channel", () => {
    const dm = msg({ guild_id: undefined, channel_id: "D1", content: "hi", mentions: [] }) as never;
    expect(toEnvelope(dm, { integrationId: "dc", botId: "BOT" })!.envelope).toMatchObject({ source: { channel: "D1" }, mentioned: true, thread: { externalId: "D1" } });
    const made = toEnvelope(dm, { integrationId: "dc", botId: "BOT", dmLink: "dm-finn" })!;
    expect(made.envelope).toMatchObject({ source: { linkId: "dm-finn" }, mentioned: true, thread: { externalId: "D1" } });
    expect(made.opensThread).toBe(false);
  });
});

describe("Discord outbound", () => {
  test("a first post for a workstream opens its thread and returns the thread id", async () => {
    answer = (c) => ({ status: 200, body: { id: c.path.endsWith("/threads") ? "M-new" : "M-new" } });
    const r = await discordAdapter(conn()).send({ externalId: "C1" }, { text: "Opened PR #12", title: "Fix footer", url: "https://github.com/o/r/pull/12", topic: "orca.pr.opened" as never }, "d1");
    expect(r).toEqual({ ok: true, externalMsgId: "M-new", threadId: "M-new" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/channels/C1/messages" });
    expect(calls[0]!.body.embeds[0]).toMatchObject({ title: "Fix footer", url: "https://github.com/o/r/pull/12", description: "Opened PR #12" });
    expect(calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/channels/C1/messages/M-new/threads", body: { name: "Fix footer" } });
  });

  test("a reply posts into the thread; an edit patches the message", async () => {
    answer = () => ({ status: 200, body: { id: "M7" } });
    const a = discordAdapter(conn());
    expect(await a.send({ externalId: "C1", threadId: "T9" }, { text: "Done." }, "d2")).toEqual({ ok: true, externalMsgId: "M7", threadId: "T9" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/channels/T9/messages", body: { content: "Done." } });
    await a.send({ externalId: "C1", threadId: "T9", messageId: "M7" }, { text: "Done, merged.", edit: true }, "d3");
    expect(calls[1]).toMatchObject({ method: "PATCH", path: "/channels/T9/messages/M7", body: { content: "Done, merged." } });
  });

  test("a 429 retries after Discord's retry_after; a missing channel or bad auth does not retry", async () => {
    answer = () => ({ status: 429, body: { message: "You are being rate limited.", retry_after: 1.5 } });
    expect(await discordAdapter(conn()).send({ externalId: "C1", threadId: "T9" }, { text: "x" }, "d")).toMatchObject({ ok: false, retryable: true, retryAfterMs: 1500 });
    answer = () => ({ status: 404, body: { message: "Unknown Channel" } });
    expect(await discordAdapter(conn()).send({ externalId: "C1" }, { text: "x" }, "d")).toMatchObject({ ok: false, retryable: false, error: "404 Unknown Channel" });
    answer = () => ({ status: 503, body: {} });
    expect(await discordAdapter(conn()).send({ externalId: "C1" }, { text: "x" }, "d")).toMatchObject({ ok: false, retryable: true });
    delete process.env.ORCA_SECRET_DISCORD_TEST;
    expect(await discordAdapter(conn()).send({ externalId: "C1" }, { text: "x" }, "d")).toMatchObject({ ok: false, retryable: false });
  });

  test("render: plain content for a reply, never pinging anyone", () => {
    expect(render({ text: "hi @everyone" })).toEqual({ content: "hi @everyone", allowed_mentions: { parse: [] } });
  });
});
