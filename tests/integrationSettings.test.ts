// Settings > Integrations (docs/research/integrations.md §6.1): the page's pure decisions, and its
// server half end to end — the one GET (overview) and every POST path (admin.route) over a fresh
// Postgres schema, with the real registry and dispatcher. A fake chat kind is registered the way a
// later adapter registers, so the page's generic path (kinds from the registry) is what is tested.
// No real Slack, Discord or mail service: the adapter is a fake.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as admin from "../server/integrations/admin";
import * as dispatcher from "../server/integrations/dispatcher";
import * as registry from "../server/integrations/registry";
import * as router from "../server/integrations/router";
import * as store from "../server/integrations/store";
import type { Adapter } from "../server/integrations/adapter";
import type { Capabilities, OutboundMessage, SendResult } from "../shared/integrations";
import {
  healthLine, healthTone, integrationProblem, linkProblem, parseFilter, span, targetLabel,
  type IntegrationCard,
} from "../shared/integrationSettings";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

describe("decisions (pure)", () => {
  const card = (over: Partial<IntegrationCard> = {}): IntegrationCard => ({ id: "s", kind: "slack", name: "Work Slack", instance: "cloud", enabled: true, config: {}, running: false, ...over });

  test("health tone: off gray, missing secret red, unchecked amber, stale remote amber, else green", () => {
    const now = 100 * 60_000;
    expect(healthTone(card({ enabled: false }), now)).toBe("neutral");
    expect(healthTone(card({ secretSet: false, health: { ok: true } }), now)).toBe("error");
    expect(healthTone(card(), now)).toBe("warning");
    expect(healthTone(card({ health: { ok: false, error: "invalid_auth" } }), now)).toBe("error");
    expect(healthTone(card({ health: { ok: true, at: now - 11 * 60_000 } }), now)).toBe("warning");
    expect(healthTone(card({ running: true, health: { ok: true, at: 0 } }), now)).toBe("ready");
  });

  test("health line: connected time and last event, or the problem", () => {
    const now = 10 * 3_600_000;
    expect(healthLine(card({ enabled: false }), now)).toBe("Disconnected");
    expect(healthLine(card({ secretRef: "ORCA_SECRET_X", secretSet: false }), now)).toBe("ORCA_SECRET_X is not set on cloud");
    expect(healthLine(card({ health: { ok: true, startedAt: now - 2 * 3_600_000 }, lastEventAt: now - 3 * 60_000 }), now)).toBe("Connected 2h · last event 3m ago");
    expect(healthLine(card({ health: { ok: false, error: "invalid_auth" } }), now)).toBe("invalid_auth · no events yet");
    expect(healthLine(card(), now)).toBe("Not checked yet on cloud · no events yet");
    expect(span(30_000)).toBe("now");
  });

  test("forms: the same checks on page and server", () => {
    const kinds = ["slack", "webhook"];
    expect(integrationProblem({ id: "work-slack", kind: "slack", name: "W", instance: "cloud", secretRef: "ORCA_SECRET_SLACK_BOT" }, kinds, [])).toBeUndefined();
    expect(integrationProblem({ id: "Work Slack", kind: "slack", name: "W", instance: "cloud" }, kinds, [])).toContain("id");
    expect(integrationProblem({ id: "w", kind: "irc", name: "W", instance: "cloud" }, kinds, [])).toContain("kind");
    expect(integrationProblem({ id: "w", kind: "slack", name: "W", instance: "cloud", secretRef: "MY_TOKEN" }, kinds, [])).toContain("ORCA_SECRET_");
    expect(linkProblem({ id: "eng", integrationId: "w", externalId: "C1", level: "work", repos: [] })).toContain("repo");
    expect(linkProblem({ id: "eng", integrationId: "w", externalId: "C1", level: "ask", repos: [] })).toBeUndefined();
    expect(parseFilter("repo=orca, adapter=slack")).toEqual({ repo: "orca", adapter: "slack" });
    expect(parseFilter("")).toEqual({});
    expect(parseFilter("team=x")).toBeUndefined();
  });

  test("labels", () => {
    const links = [{ id: "eng", integrationId: "w", externalId: "C1", label: "#eng", level: "ask" as const, repos: [], requireMention: true }];
    expect(targetLabel({ targetKind: "link", targetId: "eng" }, links, [{ id: "w", name: "Work Slack" }])).toBe("#eng · Work Slack");
    expect(targetLabel({ targetKind: "link", targetId: "gone" }, links, [])).toBe("link gone (removed)");
    expect(targetLabel({ targetKind: "orchestrator" }, [], [])).toBe("the orchestrator");
  });
});

describe("with Postgres", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  const CAPS: Capabilities = { inbound: "socket", outbound: true, threads: true, edits: false, reactions: false, attachments: false, maxTextLength: 2000 };
  const sends: { externalId: string; msg: OutboundMessage }[] = [];
  let result: SendResult = { ok: true, externalMsgId: "m1" };
  const fakeChat = (): Adapter => ({
    kind: "fakechat", caps: CAPS, start: async () => {}, stop: async () => {},
    health: async () => ({ ok: true, detail: "signed in as orca-bot" }),
    send: async (t, msg) => { sends.push({ externalId: t.externalId, msg }); return result; },
  });
  // A later adapter's one line: the page needs no change for it.
  registry.register("fakechat", fakeChat, { label: "Fake chat", caps: CAPS, place: "room", secretExample: "ORCA_SECRET_FAKECHAT" });

  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE, ORCA_SECRET_FAKECHAT: process.env.ORCA_SECRET_FAKECHAT };
    process.env.ORCA_INSTANCE = "local";
    process.env.ORCA_SECRET_FAKECHAT = "fake-token";
    pg = await freshSchema("intsettings");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    sends.length = 0;
    result = { ok: true, externalMsgId: "m1" };
  });
  afterEach(async () => {
    await dispatcher.stop();
    await registry.stopAll();
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const connect = async () => {
    await admin.route("/api/integrations/save", { id: "chat", kind: "fakechat", name: "Team chat", instance: "local", secretRef: "ORCA_SECRET_FAKECHAT" });
    await admin.route("/api/integrations/links/save", { id: "eng", integrationId: "chat", externalId: "R1", label: "#eng", level: "work", repos: ["orca"], requireMention: true });
  };

  test("connect, link, and the overview: kinds from the registry, secret status, links", async () => {
    await expect(admin.route("/api/integrations/save", { id: "x", kind: "fakechat", name: "X", instance: "local", secretRef: "MY_TOKEN" })).rejects.toThrow("ORCA_SECRET_");
    await connect();
    const o = await admin.overview("local");
    expect(o.kinds.map((k) => k.kind)).toEqual(expect.arrayContaining(["slack", "webhook", "fakechat"]));
    expect(o.kinds.find((k) => k.kind === "fakechat")).toMatchObject({ label: "Fake chat", place: "room" });
    expect(o.integrations).toEqual([expect.objectContaining({ id: "chat", kind: "fakechat", secretRef: "ORCA_SECRET_FAKECHAT", secretSet: true, enabled: true })]);
    expect(o.links).toEqual([expect.objectContaining({ id: "eng", level: "work", repos: ["orca"], requireMention: true })]);
    // Another instance cannot see this one's environment: the secret status is unknown there.
    expect((await admin.overview("cloud")).integrations[0]!.secretSet).toBeUndefined();
    // Disconnect keeps the row and its links.
    await admin.route("/api/integrations/enabled", { id: "chat", on: false });
    const off = await admin.overview("local");
    expect(off.integrations[0]!.enabled).toBe(false);
    expect(off.links).toHaveLength(1);
  });

  test("Test: the card's health check is recorded; a link's test goes through the real delivery path", async () => {
    await connect();
    await registry.stopAll(); // a save syncs the registry; stop it to see the not-running answer
    expect(await admin.testIntegration("chat", "local")).toMatchObject({ ok: false, detail: "not running on this instance's primary bridge" });
    await registry.startOne((await store.integration("chat"))!);
    expect(await admin.testIntegration("chat", "local")).toEqual({ ok: true, detail: "signed in as orca-bot" });
    await expect(admin.testIntegration("chat", "cloud")).rejects.toThrow("runs on local");
    const card = (await admin.overview("local")).integrations[0]!;
    expect(card).toMatchObject({ running: true, health: { ok: true, detail: "signed in as orca-bot" } });

    dispatcher.configure({ adapter: registry.adapterFor });
    dispatcher.setRunning(registry.runningIds);
    dispatcher.start(50);
    expect(await admin.route("/api/integrations/links/test", { id: "eng" })).toMatchObject({ state: "sent" });
    expect(sends).toEqual([{ externalId: "R1", msg: expect.objectContaining({ title: "Orca test message", topic: "orca.integration.test" }) }]);
    // The test came FROM Orca, so it does not move the card's "last event" (what the platform brought in).
    expect((await admin.overview("local")).integrations[0]!.lastEventAt).toBeUndefined();

    result = { ok: false, retryable: false, error: "not_in_channel" };
    expect(await admin.route("/api/integrations/links/test", { id: "eng" })).toMatchObject({ state: "dead", error: "not_in_channel" });
    const dead = (await admin.overview("local")).dead;
    expect(dead).toEqual([expect.objectContaining({ topic: "orca.integration.test", attempts: 1, lastError: "not_in_channel", target: expect.objectContaining({ kind: "link", externalId: "R1" }) })]);

    // Retry one: back to pending, and the dispatcher sends it again.
    result = { ok: true };
    expect(await admin.route("/api/integrations/deliveries/retry", { id: dead[0]!.id })).toEqual({ ok: true, retried: 1 });
    for (let i = 0; i < 40 && (await admin.overview("local")).dead.length; i++) await Bun.sleep(50);
    for (let i = 0; i < 40 && sends.length < 3; i++) await Bun.sleep(50);
    expect(sends).toHaveLength(3);
    expect((await store.deliveries({ state: "dead" }))).toHaveLength(0);
  });

  test("people: an unknown sender's pairing code shows; approval makes a person the gate then trusts; deny closes a code", async () => {
    await connect();
    const msg = (id: string, from = "U9", name?: string) => ({ key: `fakechat:${id}`, topic: "ext.fakechat.message" as const, at: Date.now(), source: { adapter: "fakechat", channel: "R1" }, actor: { external: { adapter: "fakechat", id: from, ...(name ? { name } : {}) } }, mentioned: true, text: "status?" });
    // The core's gate: an unknown sender is dropped and gets a pairing code, which the page lists.
    expect(await router.ingest("chat", msg("e1", "U9", "Saajan"))).toBe("rejected");
    const [p] = (await admin.overview("local")).pairings;
    expect(p).toMatchObject({ integrationId: "chat", adapter: "fakechat", externalId: "U9", name: "Saajan", state: "pending" });
    // Approve as a new person (the page's POST pairing/approve {code, name, maxLevel} → the core's approvePairing).
    await store.approvePairing(p!.code, { id: "saajan", name: "Saajan", maxLevel: "ask" });
    const o = await admin.overview("local");
    expect(o.pairings).toEqual([]);
    expect(o.people).toEqual([{ id: "saajan", name: "Saajan", maxLevel: "ask", identities: [{ adapter: "fakechat", externalId: "U9" }] }]);
    expect(await router.ingest("chat", msg("e2"))).toBe("new");
    expect((await store.event("fakechat:e2"))!.grant).toMatchObject({ level: "ask", principalId: "saajan" }); // min(work link, ask person)
    expect((await admin.overview("local")).integrations[0]!.lastEventAt).toBeGreaterThan(0);

    // A second sender joins the existing person ({code, principal}); deny closes a third.
    router.resetPace();
    await router.ingest("chat", msg("e4", "U10"));
    await router.ingest("chat", msg("e5", "U11"));
    const codes = new Map((await admin.overview("local")).pairings.map((x) => [x.externalId, x.code]));
    await store.approvePairing(codes.get("U10")!, { id: "saajan" });
    expect(await store.denyPairing(codes.get("U11")!)).toBe(true);
    expect((await admin.overview("local")).people[0]).toMatchObject({ maxLevel: "ask", identities: [{ externalId: "U10" }, { externalId: "U9" }] });
    expect((await admin.overview("local")).pairings).toEqual([]);

    // Level change, unpair, remove.
    await admin.route("/api/integrations/people/save", { id: "saajan", name: "Saajan", maxLevel: "work" });
    await admin.route("/api/integrations/identities/remove", { adapter: "fakechat", externalId: "U10" });
    expect((await admin.overview("local")).people[0]).toMatchObject({ maxLevel: "work", identities: [{ externalId: "U9" }] });
    await admin.route("/api/integrations/people/remove", { id: "saajan" });
    expect((await admin.overview("local")).people).toEqual([]);
    expect(await router.ingest("chat", msg("e3"))).toBe("rejected");
  });

  test("subscriptions: add with a filter, route an event, remove; removing a link or integration takes its subscriptions", async () => {
    await connect();
    await expect(admin.route("/api/integrations/subscriptions/add", { topicPattern: "orca.pr.*", targetKind: "link", targetId: "nope" })).rejects.toThrow("pick a link");
    const { id } = (await admin.route("/api/integrations/subscriptions/add", { topicPattern: "orca.pr.*", filter: { repo: "orca" }, targetKind: "link", targetId: "eng", digestSeconds: 600 })) as { id: number };
    expect((await admin.overview("local")).subscriptions).toEqual([{ id, topicPattern: "orca.pr.*", filter: { repo: "orca" }, targetKind: "link", targetId: "eng", digestSeconds: 600 }]);
    expect((await router.publish({ key: "k1", topic: "orca.pr.merged", at: 0, source: { adapter: "orca" }, scope: { repo: "orca" }, text: "merged" })).deliveries).toHaveLength(1);
    expect((await router.publish({ key: "k2", topic: "orca.pr.merged", at: 0, source: { adapter: "orca" }, scope: { repo: "other" }, text: "merged" })).deliveries).toHaveLength(0);
    await admin.route("/api/integrations/subscriptions/remove", { id });
    expect((await admin.overview("local")).subscriptions).toEqual([]);

    await admin.route("/api/integrations/subscriptions/add", { topicPattern: "orca.run.finished", targetKind: "link", targetId: "eng" });
    await admin.route("/api/integrations/subscriptions/add", { topicPattern: "orca.question", targetKind: "web" });
    await admin.route("/api/integrations/links/remove", { id: "eng" });
    expect((await admin.overview("local")).subscriptions.map((s) => s.targetKind)).toEqual(["web"]);

    await admin.route("/api/integrations/links/save", { id: "eng2", integrationId: "chat", externalId: "R2", level: "notify" });
    await admin.route("/api/integrations/subscriptions/add", { topicPattern: "orca.pr.*", targetKind: "link", targetId: "eng2" });
    await admin.route("/api/integrations/remove", { id: "chat" });
    const o = await admin.overview("local");
    expect(o.integrations).toEqual([]);
    expect(o.links).toEqual([]);
    expect(o.subscriptions.map((s) => s.targetKind)).toEqual(["web"]);
  });

  test("Retry all: every dead delivery back to pending", async () => {
    await connect();
    dispatcher.configure({ adapter: () => fakeChat() });
    dispatcher.setRunning(() => ["chat"]);
    await admin.route("/api/integrations/subscriptions/add", { topicPattern: "orca.pr.*", targetKind: "link", targetId: "eng" });
    result = { ok: false, retryable: false, error: "channel_not_found" };
    for (const k of ["a", "b"]) await router.publish({ key: k, topic: "orca.pr.merged", at: 0, source: { adapter: "orca" }, text: k }, 0);
    await dispatcher.dispatchOnce(0);
    expect((await admin.overview("local")).dead).toHaveLength(2);
    expect(await admin.route("/api/integrations/deliveries/retry", {})).toEqual({ ok: true, retried: 2 });
    expect((await admin.overview("local")).dead).toHaveLength(0);
    expect(await admin.route("/api/integrations/nothing-here", {})).toBeUndefined();
  });
});
