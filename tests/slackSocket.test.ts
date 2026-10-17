// The Slack adapter's two-way half (docs/integrations/slack.md): Socket Mode inbound with a bot
// token and an app-level token. A fake Socket Mode server (a local Bun.serve WebSocket) stands in for
// Slack's socket, and a stubbed fetch for its Web API (auth.test, apps.connections.open,
// chat.postMessage) — nothing here talks to a real Slack. The last case runs the real router on a
// fresh schema: a mention in a linked channel is one event with its thread, and the reply goes back
// into that thread — a pairing code for an unknown sender, and `orca post --thread` for an answer.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as orchestrator from "../server/orchestrator";
import * as store from "../server/integrations/store";
import { DM_LINK, reconnectDelay, slackAdapter, slackInbound, threadChannel, USER_CONNECTION, type SlackEvent } from "../server/integrations/adapters/slack";
import type { AdapterContext, Connection } from "../server/integrations/adapter";
import { pairingReply, type InboundEnvelope } from "../shared/integrations";
import type { OrcaConfig } from "../server/config";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response, WebSocket: globalThis.WebSocket };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

const me = { team: "T1", botUserId: "UBOT" };
const BOT: Connection = { id: "slack-work", kind: "slack", name: "Work Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_BOT", enabled: true };

const waitFor = async (ok: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(10); }
};

/** A fake Socket Mode server: says hello on each connection, records acks, pushes envelopes. */
function fakeSocketMode() {
  const socks: ServerWebSocket<undefined>[] = [];
  const acks: string[] = [];
  let hello = true;
  const server: Server<undefined> = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { socks.push(ws); if (hello) ws.send(JSON.stringify({ type: "hello", num_connections: 1 })); },
      message(_ws, m) { const id = JSON.parse(String(m)).envelope_id; if (id) acks.push(id); },
    },
  });
  let n = 0;
  return {
    url: `ws://127.0.0.1:${server.port}/link`, socks, acks,
    set hello(v: boolean) { hello = v; },
    live: () => socks.filter((s) => s.readyState === 1),
    event(event: SlackEvent, team = "T1") {
      const id = `env${++n}`;
      this.live().at(-1)!.send(JSON.stringify({ envelope_id: id, type: "events_api", payload: { team_id: team, event } }));
      return id;
    },
    stop: () => server.stop(true),
  };
}

/** The Web API: auth.test, apps.connections.open (to the fake socket) and chat.postMessage. */
function fakeWebApi(socketUrl: () => string, over: Record<string, () => Response> = {}) {
  const calls: { method: string; body: any; auth: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const method = String(url).replace("https://slack.com/api/", "");
    calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.authorization });
    const name = method.split("?")[0]!;
    if (over[name]) return over[name]!();
    if (name === "auth.test") return Response.json({ ok: true, user_id: "UBOT", team_id: "T1", user: "orca" });
    if (name === "apps.connections.open") return Response.json({ ok: true, url: socketUrl() });
    if (name === "chat.postMessage") return Response.json({ ok: true, channel: init && JSON.parse(init.body).channel, ts: "77.7" });
    if (name === "users.info") return Response.json({ ok: true, user: { id: "U1", name: "saajan", real_name: "Saajan P", profile: { display_name: "Saajan" } } });
    return Response.json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

function fakeCtx(ingest: (e: InboundEnvelope) => Promise<"new" | "duplicate" | "rejected"> = async () => "new") {
  const abort = new AbortController();
  const statuses: { ok: boolean; detail?: string }[] = [];
  const ctx: AdapterContext = {
    connection: BOT, secret: () => process.env.ORCA_SECRET_SLACK_BOT, ingest,
    cursor: { get: async () => undefined, set: async () => {} },
    status: async (s) => { statuses.push(s); }, log: () => {}, signal: abort.signal,
  };
  return { ctx, abort, statuses };
}

describe("slackInbound (pure)", () => {
  test("a mention: the bot's tag removed, one event id for app_mention and message, a thread under it", () => {
    const ev: SlackEvent = { type: "app_mention", user: "U1", text: "<@UBOT> is #12 merged? &lt;soon&gt;", ts: "1.2", channel: "C1", channel_type: "channel" };
    const m = slackInbound(ev, { ...me, integrationId: "slack-work" })!;
    expect(m).toEqual({
      adapter: "slack", integrationId: "slack-work", channel: "C1", eventId: "T1:C1:1.2", from: { adapter: "slack", id: "U1" },
      text: "is #12 merged? <soon>", thread: { adapter: "slack", externalId: "C1:1.2", messageId: "1.2" }, mentioned: true, at: 1200,
    });
    expect(slackInbound({ ...ev, type: "message" }, me)!.eventId).toBe(m.eventId); // the same message twice is one key
    expect(slackInbound({ ...ev, type: "message" }, me)!.mentioned).toBe(true);
  });

  test("a thread reply keeps its thread; a reply to the bot's own thread counts as a mention", () => {
    const reply = slackInbound({ type: "message", user: "U1", text: "yes, ship it\nthanks", ts: "3.3", thread_ts: "2.2", parent_user_id: "UBOT", channel: "C1", channel_type: "channel" }, me)!;
    expect(reply.thread).toEqual({ adapter: "slack", externalId: "C1:2.2", messageId: "3.3" });
    expect(reply.mentioned).toBe(true);
    expect(reply.text).toBe("yes, ship it\nthanks"); // newlines stay
    expect(slackInbound({ type: "message", user: "U1", text: "lunch?", ts: "4.4", thread_ts: "2.2", parent_user_id: "U9", channel: "C1", channel_type: "channel" }, me)!.mentioned).toBe(false);
    expect(slackInbound({ type: "message", user: "U1", text: "lunch?", ts: "4.4", channel: "C1", channel_type: "channel" }, me)!.mentioned).toBe(false);
  });

  test("a DM goes to the im link; its real channel rides in the thread id", () => {
    const dm = slackInbound({ type: "message", user: "U1", text: "status?", ts: "5.5", channel: "D7", channel_type: "im" }, me)!;
    expect(dm).toMatchObject({ channel: DM_LINK, mentioned: true, thread: { externalId: "D7:5.5" } });
    expect(threadChannel(dm.thread!.externalId)).toBe("D7");
  });

  test("not for Orca: bots, itself, edits and joins, other event types, an empty mention", () => {
    const base: SlackEvent = { type: "message", user: "U1", text: "hi", ts: "1.1", channel: "C1" };
    expect(slackInbound({ ...base, bot_id: "B1" }, me)).toBeUndefined();
    expect(slackInbound({ ...base, user: "UBOT" }, me)).toBeUndefined();
    expect(slackInbound({ ...base, subtype: "message_changed" }, me)).toBeUndefined();
    expect(slackInbound({ ...base, subtype: "channel_join" }, me)).toBeUndefined();
    expect(slackInbound({ ...base, type: "reaction_added" }, me)).toBeUndefined();
    expect(slackInbound({ ...base, type: "app_mention", text: "<@UBOT>" }, me)).toBeUndefined();
    expect(slackInbound({ ...base, subtype: "thread_broadcast" }, me)).toBeDefined();
  });

  test("reconnect backoff: 1 s doubling to 30 s; Slack's Retry-After wins", () => {
    expect([1, 2, 3, 6, 9].map((n) => reconnectDelay(n))).toEqual([1_000, 2_000, 4_000, 30_000, 30_000]);
    expect(reconnectDelay(1, 5_000)).toBe(5_000);
  });
});

describe("Socket Mode (a fake Slack socket)", () => {
  const env = ["ORCA_SECRET_SLACK_BOT", "ORCA_SECRET_SLACK_APP", "ORCA_SECRET_OTHER_APP"] as const;
  afterEach(() => { for (const k of env) delete process.env[k]; });
  const tokens = () => { process.env.ORCA_SECRET_SLACK_BOT = "xoxb-test"; process.env.ORCA_SECRET_SLACK_APP = "xapp-test"; };

  test("connect with the app token, ack every envelope, ingest mentions and DMs, skip the rest, reconnect on disconnect", async () => {
    tokens();
    const slack = fakeSocketMode();
    const api = fakeWebApi(() => slack.url);
    const got: InboundEnvelope[] = [];
    const { ctx, abort, statuses } = fakeCtx(async (e) => { got.push(e); return "new"; });
    const a = slackAdapter(BOT);
    try {
      expect(a.caps.inbound).toBe("socket");
      await a.start(ctx);
      expect(api.calls.map((c) => [c.method, c.auth])).toEqual([["auth.test", "Bearer xoxb-test"], ["apps.connections.open", "Bearer xapp-test"]]);
      expect(await a.health()).toMatchObject({ ok: true, detail: "Socket Mode connected as UBOT" });
      expect(statuses.at(-1)).toMatchObject({ ok: true });

      const e1 = slack.event({ type: "app_mention", user: "U1", text: "<@UBOT> status?", ts: "1.2", channel: "C1", channel_type: "channel" });
      const e2 = slack.event({ type: "message", user: "U1", text: "<@UBOT> status?", ts: "1.2", channel: "C1", channel_type: "channel" });
      const e3 = slack.event({ type: "message", bot_id: "B1", user: "UBOT", text: "a post", ts: "1.3", channel: "C1" });
      const e4 = slack.event({ type: "message", user: "U2", text: "hello", ts: "1.4", channel: "D9", channel_type: "im" });
      await waitFor(() => slack.acks.length === 4 && got.length === 3);
      expect(slack.acks).toEqual([e1, e2, e3, e4]);
      expect(got.map((e) => [e.key, e.topic, e.source.channel, e.thread?.externalId, e.mentioned, e.text])).toEqual([
        ["slack:T1:C1:1.2", "ext.slack.message", "C1", "C1:1.2", true, "status?"],
        ["slack:T1:C1:1.2", "ext.slack.message", "C1", "C1:1.2", true, "status?"], // the core dedupes on the key
        ["slack:T1:D9:1.4", "ext.slack.message", DM_LINK, "D9:1.4", true, "hello"],
      ]);
      expect(got[0]!.actor).toEqual({ external: { adapter: "slack", id: "U1" } });
      expect(JSON.stringify(got)).not.toContain("xoxb-test");

      // Slack refreshes the link: the adapter opens a new one and keeps ingesting.
      slack.live().at(-1)!.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
      await waitFor(() => api.calls.filter((c) => c.method === "apps.connections.open").length === 2 && slack.live().length === 1, 5_000);
      expect(slack.socks.length).toBe(2);
      slack.event({ type: "app_mention", user: "U1", text: "<@UBOT> again", ts: "2.0", channel: "C1" });
      await waitFor(() => got.length === 4);
      expect(got[3]!.text).toBe("again");

      // A reply goes back into the thread the message came from: the DM's channel, from the thread id.
      const sent = await a.send({ externalId: DM_LINK, threadId: "D9:1.4" }, { text: "on it" }, "9");
      expect(api.calls.at(-1)).toMatchObject({ method: "chat.postMessage", body: { channel: "D9", text: "on it", thread_ts: "1.4" }, auth: "Bearer xoxb-test" });
      expect(sent).toEqual({ ok: true, externalMsgId: "77.7", threadId: "D9:1.4" });
      expect(await a.resolveUser!("U1")).toEqual({ id: "U1", name: "Saajan" });
      expect(api.calls.at(-1)!.method).toBe("users.info?user=U1");

      // Stop: the socket closes and nothing reconnects.
      abort.abort();
      await a.stop();
      await waitFor(() => slack.live().length === 0);
      await Bun.sleep(1_200);
      expect(api.calls.filter((c) => c.method === "apps.connections.open").length).toBe(2);
    } finally {
      abort.abort(); await a.stop(); api.restore(); slack.stop();
    }
  }, 15_000);

  test("start refuses a bad setup: no app token, a bad bot token, a revoked app token, a non-secret variable name", async () => {
    const slack = fakeSocketMode();
    process.env.ORCA_SECRET_SLACK_BOT = "xoxb-test";
    await expect(slackAdapter(BOT).start(fakeCtx().ctx)).rejects.toThrow("ORCA_SECRET_SLACK_APP is not set");
    await expect(slackAdapter({ ...BOT, config: { appTokenRef: "HOME" } }).start(fakeCtx().ctx)).rejects.toThrow("must start with ORCA_SECRET_");
    tokens();
    let api = fakeWebApi(() => slack.url, { "auth.test": () => Response.json({ ok: false, error: "invalid_auth" }) });
    try { await expect(slackAdapter(BOT).start(fakeCtx().ctx)).rejects.toThrow("auth.test: invalid_auth"); } finally { api.restore(); }
    api = fakeWebApi(() => slack.url, { "apps.connections.open": () => Response.json({ ok: false, error: "invalid_auth" }) });
    try { await expect(slackAdapter(BOT).start(fakeCtx().ctx)).rejects.toThrow("apps.connections.open: invalid_auth"); } finally { api.restore(); }
    // Another app-token variable, named in the row's config.
    delete process.env.ORCA_SECRET_SLACK_APP;
    process.env.ORCA_SECRET_OTHER_APP = "xapp-other";
    api = fakeWebApi(() => slack.url);
    const { ctx, abort } = fakeCtx();
    const a = slackAdapter({ ...BOT, config: { appTokenRef: "ORCA_SECRET_OTHER_APP" } });
    try {
      await a.start(ctx);
      expect(api.calls[1]).toMatchObject({ method: "apps.connections.open", auth: "Bearer xapp-other" });
    } finally { abort.abort(); await a.stop(); api.restore(); slack.stop(); }
  });

  test("a rate-limited connect waits Slack's Retry-After, then connects", async () => {
    tokens();
    const slack = fakeSocketMode();
    let limited = true;
    const api = fakeWebApi(() => slack.url, {
      "apps.connections.open": () => {
        if (!limited) return Response.json({ ok: true, url: slack.url });
        limited = false;
        return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "retry-after": "1" } });
      },
    });
    const { ctx, abort, statuses } = fakeCtx();
    const a = slackAdapter(BOT);
    try {
      const t0 = Date.now();
      await a.start(ctx); // resolves: a rate limit is not a bad setup
      expect(await a.health()).toMatchObject({ ok: false });
      expect(statuses[0]).toMatchObject({ ok: false });
      await waitFor(() => slack.live().length === 1, 4_000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
      await waitFor(() => statuses.at(-1)?.ok === true);
    } finally { abort.abort(); await a.stop(); api.restore(); slack.stop(); }
  }, 10_000);

  test("post as you (SLACK_TOKEN) and a bot row with socket: false stay outbound only", async () => {
    const api = fakeWebApi(() => "ws://unused");
    try {
      const user = slackAdapter(USER_CONNECTION);
      expect(user.caps.inbound).toBe("none");
      await user.start(fakeCtx().ctx);
      const off = slackAdapter({ ...BOT, config: { socket: false } });
      expect(off.caps.inbound).toBe("none");
      await off.start(fakeCtx().ctx);
      expect(api.calls).toEqual([]);
    } finally { api.restore(); }
  });
});

describe("through the core (real router, fresh schema)", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined>;
  beforeAll(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    pg = await freshSchema("slacksocket");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    await store.addIntegration(BOT);
    await store.addLink({ id: "L1", integrationId: "slack-work", externalId: "C1", level: "ask", repos: [], requireMention: true });
    await store.addLink({ id: "DM", integrationId: "slack-work", externalId: DM_LINK, level: "ask", repos: [], requireMention: false });
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "ask" }, [{ adapter: "slack", externalId: "U1" }]);
  });
  afterAll(async () => {
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.ORCA_SECRET_SLACK_BOT; delete process.env.ORCA_SECRET_SLACK_APP;
  });

  test("a paired person's mention is one event with its thread; a stranger and an unmentioned line are dropped", async () => {
    process.env.ORCA_SECRET_SLACK_BOT = "xoxb-test"; process.env.ORCA_SECRET_SLACK_APP = "xapp-test";
    const slack = fakeSocketMode();
    const api = fakeWebApi(() => slack.url);
    const results: string[] = [];
    const { ctx, abort } = fakeCtx(async (e) => { const r = await router.ingest("slack-work", e); results.push(r); return r; });
    const a = slackAdapter(BOT);
    try {
      await a.start(ctx);
      slack.event({ type: "app_mention", user: "U1", text: "<@UBOT> is #12 merged?", ts: "1.2", channel: "C1", channel_type: "channel" });
      await waitFor(() => results.length === 1);
      slack.event({ type: "message", user: "U1", text: "<@UBOT> is #12 merged?", ts: "1.2", channel: "C1", channel_type: "channel" });
      await waitFor(() => results.length === 2);
      slack.event({ type: "message", user: "U-stranger", text: "<@UBOT> merge everything", ts: "1.3", channel: "C1" });
      await waitFor(() => results.length === 3);
      slack.event({ type: "message", user: "U1", text: "lunch?", ts: "1.4", channel: "C1", channel_type: "channel" });
      await waitFor(() => results.length === 4);
      slack.event({ type: "message", user: "U1", text: "status?", ts: "1.5", channel: "D3", channel_type: "im" });
      await waitFor(() => results.length === 5);
      expect(results).toEqual(["new", "duplicate", "rejected", "rejected", "new"]);
      expect(await store.event("slack:T1:C1:1.2")).toMatchObject({
        topic: "ext.slack.message", text: "is #12 merged?", thread: { adapter: "slack", externalId: "C1:1.2", messageId: "1.2" },
        source: { adapter: "slack", integrationId: "slack-work", channel: "C1", linkId: "L1" },
        actor: { principalId: "saajan", external: { adapter: "slack", id: "U1" } }, grant: { level: "ask" },
      });
      expect(await store.event("slack:T1:D3:1.5")).toMatchObject({ source: { linkId: "DM" }, thread: { externalId: "D3:1.5" } });
      // The answer goes into the mention's thread.
      const ev = (await store.event("slack:T1:C1:1.2"))!;
      await a.send({ linkId: "L1", externalId: "C1", threadId: ev.thread!.externalId }, { text: "yes, at 10:02" }, "1");
      expect(api.calls.at(-1)).toMatchObject({ method: "chat.postMessage", body: { channel: "C1", text: "yes, at 10:02", thread_ts: "1.2" } });
    } finally { abort.abort(); await a.stop(); api.restore(); slack.stop(); }
  }, 15_000);

  test("an unknown sender's pairing code and orca post --thread both land in the sender's own thread", async () => {
    process.env.ORCA_SECRET_SLACK_BOT = "xoxb-test"; process.env.ORCA_SECRET_SLACK_APP = "xapp-test";
    const slack = fakeSocketMode();
    const api = fakeWebApi(() => slack.url);
    const results: string[] = [];
    const { ctx, abort } = fakeCtx(async (e) => { const r = await router.ingest("slack-work", e); results.push(r); return r; });
    const a = slackAdapter(BOT);
    dispatcher.resetPace();
    dispatcher.configure({ adapter: (id) => (id === "slack-work" ? a : undefined), web: async () => ({ ok: true }) });
    dispatcher.setRunning(() => ["slack-work"]);
    const posts = () => api.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body);
    try {
      await a.start(ctx);
      // (1) Strangers: a mention in a channel and a DM. Each gets its code in its own thread.
      slack.event({ type: "app_mention", user: "U-new", text: "<@UBOT> hi", ts: "3.1", channel: "C1", channel_type: "channel" });
      await waitFor(() => results.length === 1);
      slack.event({ type: "message", user: "U-dm", text: "hello?", ts: "4.1", channel: "D5", channel_type: "im" });
      await waitFor(() => results.length === 2);
      expect(results).toEqual(["rejected", "rejected"]);
      const codes = new Map((await store.pendingPairings()).map((p) => [p.externalId, p.code]));
      expect(codes.has("U-new") && codes.has("U-dm")).toBe(true); // (the first test's stranger has one too)
      // Slack's pace is one post per second per channel: a second C1 reply waits for the next second.
      const t0 = Date.now();
      await dispatcher.dispatchOnce(t0);
      await dispatcher.dispatchOnce(t0 + 1_500);
      expect(posts().filter((b) => ["3.1", "4.1"].includes(b.thread_ts)).sort((x, y) => x.thread_ts.localeCompare(y.thread_ts))).toEqual([
        { channel: "C1", text: pairingReply(codes.get("U-new")!), thread_ts: "3.1" },
        { channel: "D5", text: pairingReply(codes.get("U-dm")!), thread_ts: "4.1" }, // the DM itself, not the "im" link
      ]);

      // (2) A paired person asks; the orchestrator answers with the thread id from the fenced message.
      slack.event({ type: "app_mention", user: "U1", text: "<@UBOT> is #12 merged?", ts: "5.1", channel: "C1", channel_type: "channel" });
      await waitFor(() => results.length === 3);
      expect(results[2]).toBe("new");
      const thread = (await store.event("slack:T1:C1:5.1"))!.thread!.externalId;
      expect(thread).toBe("C1:5.1");
      expect(await orchestrator.tool({ repos: [] } as unknown as OrcaConfig, "post", { link: "L1", thread, _: ["Yes,", "at", "10:02."] })).toContain("(thread C1:5.1)");
      await dispatcher.dispatchOnce(t0 + 3_000);
      expect(posts().at(-1)).toEqual({ channel: "C1", text: "Yes, at 10:02.", thread_ts: "5.1" });
      expect((await store.deliveries()).every((d) => d.state === "sent" || d.target.kind !== "link")).toBe(true);
    } finally {
      abort.abort(); await a.stop(); api.restore(); slack.stop();
      dispatcher.configure({ adapter: () => undefined }); dispatcher.setRunning(() => []);
    }
  }, 15_000);
});
