// The unified inbox (docs/research/integrations.md §6.2, shared/inbox.ts, the /api/inbox routes'
// store reads): every inbound message and event from every integration, newest first, with its
// sender, workstream and reply state; the source and person filters; the thread view across inbound
// and outbound; the workstream cards' source chips. Real Postgres (a fresh schema), the real router,
// dispatcher and store; the only fake is the adapter's send — no external service is called.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as registry from "../server/integrations/registry";
import * as store from "../server/integrations/store";
import type { Adapter } from "../server/integrations/adapter";
import { inboundEnvelope } from "../shared/integrations";
import { replyToEvent as replyTo } from "../server/integrations/router";
import {
  conversationParam, replyRefusal, threadActions, muteKey, filterInbox, inboundConversation, inboxFacets, inboxRows, parseConversation, personId, sourceLabel, threadItems, threadSources,
} from "../shared/inbox";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

describe("pure", () => {
  test("a conversation: the thread, else the place, else the event itself; the URL form round-trips", () => {
    expect(inboundConversation({ id: "e1", thread: { adapter: "slack", externalId: "C1:1.2" }, source: { adapter: "slack", channel: "C1" } })).toEqual({ adapter: "slack", id: "C1:1.2" });
    expect(inboundConversation({ id: "e1", source: { adapter: "email", channel: "inbox" } })).toEqual({ adapter: "email", id: "inbox" });
    expect(inboundConversation({ id: "e1", source: { adapter: "orca" } })).toEqual({ adapter: "orca", id: "event:e1" });
    expect(parseConversation(conversationParam({ adapter: "github", id: "o/r#12" }))).toEqual({ adapter: "github", id: "o/r#12" });
    expect(parseConversation("nobar")).toBeUndefined();
    expect(parseConversation("|x")).toBeUndefined();
    expect(sourceLabel("github")).toBe("GitHub");
    expect(sourceLabel("matrix")).toBe("Matrix"); // a kind the core learns later shows its own name
  });
});

describe("with Postgres", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    pg = await freshSchema("inbox");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
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

  test("rows, facets, filters, reply state, the thread view and the card chips over every source", async () => {
    // Slack: one channel, a paired person; email: a catch-all mailbox, another person; a webhook.
    await store.addIntegration({ id: "slack-work", kind: "slack", name: "Work Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_BOT", enabled: true });
    await store.addIntegration({ id: "mail", kind: "email", name: "Mail", instance: "local", config: {}, secretRef: "ORCA_SECRET_MAIL", enabled: true });
    await store.addIntegration({ id: "hook", kind: "webhook", name: "Deploys", instance: "local", config: {}, secretRef: "ORCA_SECRET_HOOK", enabled: true });
    await store.addLink({ id: "eng", integrationId: "slack-work", externalId: "C1", label: "#eng", level: "work", repos: ["r"], requireMention: false });
    await store.addLink({ id: "mailbox", integrationId: "mail", externalId: "*", level: "ask", repos: [], requireMention: false });
    await store.addLink({ id: "deploys", integrationId: "hook", externalId: "deploys", level: "ask", repos: [], requireMention: false });
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "work" }, [{ adapter: "slack", externalId: "U1" }]);
    await store.addPrincipal({ id: "ada", name: "Ada", maxLevel: "ask" }, [{ adapter: "email", externalId: "ada@example.com" }]);
    await store.addSubscription({ topicPattern: "orca.run.*", filter: { repo: "r" }, targetKind: "link", targetId: "eng" });
    await store.addSubscription({ topicPattern: "orca.question", filter: {}, targetKind: "link", targetId: "eng" });

    let fail = false;
    const fake: Adapter = {
      kind: "slack", caps: { inbound: "none", outbound: true, threads: true, edits: false, reactions: false, attachments: false, maxTextLength: 4000 },
      start: async () => {}, stop: async () => {}, health: async () => ({ ok: true }),
      send: async (t, _m, key) => fail ? { ok: false, retryable: false, error: "channel_not_found" } : { ok: true, externalMsgId: `ts${key}`, threadId: t.threadId ?? `C1:ts${key}` },
    };
    dispatcher.configure({ adapter: () => fake });
    dispatcher.setRunning(() => ["slack-work", "mail", "hook"]);

    // 1. Orca posts that r/feat finished: the post starts the workstream's Slack thread.
    await router.publish({ key: "run:a:finished", topic: "orca.run.finished", at: 1_000, source: { adapter: "orca" }, scope: { repo: "r", branch: "feat" }, text: "feat is done" }, 1_000);
    await dispatcher.dispatchOnce(1_000);
    const [tl] = await store.threadLinks();
    expect(tl).toMatchObject({ adapter: "slack", linkId: "eng", repo: "r", branch: "feat" });
    const thread = tl!.externalThreadId;

    // 2. Saajan answers in that thread; 3. Orca replies there (orca post); the reply is sent.
    expect(await router.ingest("slack-work", inboundEnvelope({ adapter: "slack", channel: "C1", eventId: "Ev1", from: { adapter: "slack", id: "U1", name: "saajan.k" }, text: "Can you also fix the header?", thread: { adapter: "slack", externalId: thread }, at: 2_000 }), 2_000)).toBe("new");
    await router.publish({ key: "post:1", topic: "orca.message", at: 3_000, source: { adapter: "orca", linkId: "eng" }, text: "On it." }, 3_000,
      [{ subscriptionId: null, target: { kind: "link", integrationId: "slack-work", adapter: "slack", linkId: "eng", externalId: "C1", threadId: thread } }]);
    await dispatcher.dispatchOnce(3_000);

    // 4. Ada mails in (no thread: the mailbox is the conversation); 5. a deploy hook fires (no person).
    expect(await router.ingest("mail", inboundEnvelope({ adapter: "email", channel: "orca@example.com", eventId: "<m1@example.com>", from: { adapter: "email", id: "ada@example.com", name: "Ada L" }, text: "Is the demo up?", at: 4_000 }), 4_000)).toBe("new");
    expect(await router.ingest("hook", { key: "webhook:hook:d1", topic: "ext.webhook.deploy", at: 5_000, source: { adapter: "webhook", channel: "deploys" }, title: "Deploy", text: "v1.2 is live" }, 5_000)).toBe("new");

    // 5b. Saajan writes at the top of #eng (no thread): the channel itself is the conversation.
    expect(await router.ingest("slack-work", inboundEnvelope({ adapter: "slack", channel: "C1", eventId: "Ev2", from: { adapter: "slack", id: "U1" }, text: "Anyone on the flaky test?", at: 5_500 }), 5_500)).toBe("new");

    // 6. The orchestrator asks you (a subscription posts it to #eng); its Slack delivery goes dead.
    fail = true;
    await router.publish({ key: "question:1", topic: "orca.question", at: 6_000, source: { adapter: "orca" }, text: "Merge #12 now?" }, 6_000);
    await dispatcher.dispatchOnce(6_000);

    // An unknown sender is not in the inbox (the gate rejected the message; a pairing code went back).
    expect(await router.ingest("slack-work", inboundEnvelope({ adapter: "slack", channel: "C1", eventId: "Ev9", from: { adapter: "slack", id: "U9" }, text: "hi", at: 7_000 }), 7_000)).toBe("rejected");

    const events = await store.inboxEvents({ limit: 300 });
    const all = inboxRows(events, await store.linkDeliveries(0), await store.threadLinks(), await store.principalNames());
    // Newest first; only inbox topics (not the run event, the post, the pairing reply or request).
    expect(all.map((r) => [r.adapter, r.kind])).toEqual([["orca", "question"], ["slack", "message"], ["webhook", "event"], ["email", "message"], ["slack", "message"]]);
    const [question, top, hook, mail, slack] = all;
    // The question's broadcast to #eng came after Saajan's top-level message, but it is not a reply to it.
    expect(top).toMatchObject({ conversation: "slack|C1", text: "Anyone on the flaky test?" });
    expect(top!.reply).toBeUndefined();
    const topConv = await store.conversation({ adapter: "slack", id: "C1" });
    expect(threadItems(topConv.events, topConv.outbound, new Map()).map((i) => i.dir)).toEqual(["in"]);
    expect(slack).toMatchObject({ sender: { name: "Saajan", principalId: "saajan", externalId: "U1" }, workstream: { repo: "r", branch: "feat" }, reply: { state: "sent" }, conversation: `slack|${thread}` });
    expect(mail).toMatchObject({ sender: { name: "Ada", principalId: "ada" }, conversation: "email|orca@example.com" });
    expect(mail!.reply).toBeUndefined(); // nothing went back to Ada yet
    expect(hook).toMatchObject({ title: "Deploy", text: "v1.2 is live" });
    expect(hook!.sender).toBeUndefined();
    expect(question).toMatchObject({ reply: { state: "dead", error: "channel_not_found" } });

    // Facets over every row; the filters by source and by person.
    expect(inboxFacets(all)).toEqual({
      unread: 5, muted: 0,
      sources: [{ adapter: "slack", count: 2 }, { adapter: "email", count: 1 }, { adapter: "orca", count: 1 }, { adapter: "webhook", count: 1 }],
      people: [{ id: "saajan", name: "Saajan", count: 2 }, { id: "ada", name: "Ada", count: 1 }],
    });
    expect(filterInbox(all, { source: "slack" }).map((r) => r.id)).toEqual([top!.id, slack!.id]);
    expect(filterInbox(all, { person: personId("email", mail!.sender!) }).map((r) => r.id)).toEqual([mail!.id]);
    expect(filterInbox(all, { source: "slack", person: "ada" })).toEqual([]);

    // Paging: a window before an id holds only older events.
    expect((await store.inboxEvents({ before: hook!.id, limit: 300 })).map((e) => e.id)).toEqual([mail!.id, slack!.id]);
    expect(await store.inboxEvents({ limit: 2 })).toHaveLength(2);

    // The thread view: the post that started the thread, Saajan's message, Orca's reply, in order.
    const conv = await store.conversation(parseConversation(slack!.conversation)!);
    expect(conv.link).toMatchObject({ repo: "r", branch: "feat" });
    const items = threadItems(conv.events, conv.outbound, await store.principalNames(), new Map([["eng", "#eng"]]));
    expect(items.map((i) => [i.dir, i.text, i.dir === "out" ? i.state : i.sender?.name])).toEqual([
      ["out", "feat is done", "sent"], ["in", "Can you also fix the header?", "Saajan"], ["out", "On it.", "sent"],
    ]);
    expect(items[0]).toMatchObject({ to: "#eng", adapter: "slack" });

    // A question's thread is the question and its own deliveries.
    const q = threadItems(...(await (async () => { const c = await store.conversation(parseConversation(question!.conversation)!); return [c.events, c.outbound] as const; })()), new Map());
    expect(q.map((i) => [i.dir, i.dir === "out" ? i.state : i.text])).toEqual([["in", "Merge #12 now?"], ["out", "dead"]]);

    // The card chip: r/feat has a Slack thread.
    expect([...threadSources(await store.threadLinks())]).toEqual([["r::feat", ["slack"]]]);
  });
  test("Reply, read state, mute, the unread filter and Link to workstream", async () => {
    await store.addIntegration({ id: "slack-work", kind: "slack", name: "Work Slack", instance: "local", config: {}, secretRef: "ORCA_SECRET_SLACK_BOT", enabled: true });
    await store.addIntegration({ id: "mail", kind: "email", name: "Mail", instance: "local", config: {}, secretRef: "ORCA_SECRET_MAIL", enabled: true });
    await store.addLink({ id: "eng", integrationId: "slack-work", externalId: "C1", level: "ask", repos: [], requireMention: false });
    await store.addLink({ id: "mailbox", integrationId: "mail", externalId: "*", level: "ask", repos: [], requireMention: false });
    await store.addPrincipal({ id: "saajan", name: "Saajan", maxLevel: "ask" }, [{ adapter: "slack", externalId: "U1" }]);
    await store.addPrincipal({ id: "ada", name: "Ada", maxLevel: "ask" }, [{ adapter: "email", externalId: "ada@example.com" }]);
    const sent: { adapter: string; target: any; msg: any }[] = [];
    const fake = (kind: string): Adapter => ({
      kind, caps: { inbound: "none", outbound: true, threads: true, edits: false, reactions: false, attachments: false, maxTextLength: 4000 },
      start: async () => {}, stop: async () => {}, health: async () => ({ ok: true }),
      send: async (target, msg) => { sent.push({ adapter: kind, target, msg }); return { ok: true, externalMsgId: `m${sent.length}` }; },
    });
    dispatcher.configure({ adapter: (id: string) => fake(id === "mail" ? "email" : "slack") });
    dispatcher.setRunning(() => ["slack-work", "mail"]);

    await router.ingest("slack-work", inboundEnvelope({ adapter: "slack", channel: "C1", eventId: "Ev1", from: { adapter: "slack", id: "U1" }, text: "Status?", thread: { adapter: "slack", externalId: "C1:1.5" }, at: 1_000 }), 1_000);
    await router.ingest("mail", inboundEnvelope({ adapter: "email", channel: "orca@example.com", eventId: "<m1@x>", from: { adapter: "email", id: "ada@example.com" }, text: "Hi", thread: { adapter: "email", externalId: "<root@x>", messageId: "<m1@x>" }, at: 2_000 }), 2_000);
    const [mail, slack] = await store.inboxEvents({ limit: 10 });

    // Reply: the orca post path to the event's own place and thread; email answers In-Reply-To.
    await replyTo(slack!.id, "  Green, merging now. ", 3_000);
    await replyTo(mail!.id, "Hello Ada", 3_000);
    await dispatcher.dispatchOnce(3_000);
    expect(sent.map((s) => [s.adapter, s.target.externalId, s.target.threadId, s.msg.text, s.msg.replyToExternalMsgId])).toEqual([
      ["slack", "C1", "C1:1.5", "Green, merging now.", undefined],
      ["email", "orca@example.com", "<root@x>", "Hello Ada", "<m1@x>"], // the catch-all link's "*" is no place: the event's channel is
    ]);
    await expect(replyTo(slack!.id, "   ")).rejects.toThrow("the reply is empty");
    expect(replyRefusal({ key: "question:1", topic: "orca.question", source: { adapter: "orca" } }, "x", undefined)).toContain("nowhere to reply");

    const rowsNow = async () => {
      const events = await store.inboxEvents({ limit: 10 });
      return inboxRows(events, await store.linkDeliveries(0), await store.threadLinks(), await store.principalNames(),
        { read: await store.readEvents(events.map((e) => e.id)), muted: await store.mutedSenders() });
    };
    let rows = await rowsNow();
    expect(rows.map((r) => [r.adapter, r.read, r.canReply, r.canLink, r.reply?.state])).toEqual([["email", false, true, true, "sent"], ["slack", false, true, true, "sent"]]);
    expect(inboxFacets(rows)).toMatchObject({ unread: 2, muted: 0 });

    // Read state: per user, undone by unread, kept out of the Unread filter.
    await store.setRead([slack!.id, "no-such-event"], true);
    rows = await rowsNow();
    expect(filterInbox(rows, { unread: true }).map((r) => r.adapter)).toEqual(["email"]);
    await store.setRead([slack!.id], false);
    expect(filterInbox(await rowsNow(), { unread: true })).toHaveLength(2);

    // Mute: the sender's rows leave the inbox and its facets; the Muted filter shows only them.
    await store.setMuted("email", "ada@example.com", true, "Ada");
    rows = await rowsNow();
    expect(filterInbox(rows, {}).map((r) => r.adapter)).toEqual(["slack"]);
    expect(filterInbox(rows, { muted: true }).map((r) => r.adapter)).toEqual(["email"]);
    expect(inboxFacets(rows)).toMatchObject({ muted: 1, unread: 1, people: [{ id: "saajan", name: "Saajan", count: 1 }] });
    expect(await store.mutedSenders()).toEqual(new Set([muteKey("email", "ada@example.com")]));
    await store.setMuted("email", "ada@example.com", false);
    expect(filterInbox(await rowsNow(), {})).toHaveLength(2);

    // Link to workstream: the conversation is bound; the row can no longer be linked, and shows it.
    await store.setThreadLink({ adapter: "slack", externalThreadId: "C1:1.5", linkId: "eng", repo: "r", branch: "feat" });
    const linked = (await rowsNow()).find((r) => r.adapter === "slack")!;
    expect(linked).toMatchObject({ canLink: false, workstream: { repo: "r", branch: "feat" } });

    // The thread view's actions: reply to the newest linked event, mute its sender, what is unread.
    const conv = await store.conversation({ adapter: "slack", id: "C1:1.5" });
    expect(threadActions(conv.events, !!conv.link, { read: new Set(), muted: new Set() }, await store.principalNames())).toEqual({
      replyTo: slack!.id, canLink: false, sender: { eventId: slack!.id, name: "Saajan", muted: false }, unread: [slack!.id], // the paired name, not the handle
    });
    expect(threadItems(conv.events, conv.outbound, new Map()).map((i) => i.dir)).toEqual(["in", "out"]);
  });
});
