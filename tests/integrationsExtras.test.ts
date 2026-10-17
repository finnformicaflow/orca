// The integrations core, second part (server/integrations/, docs/integrations/ADAPTERS.md):
// pairing codes for unknown senders, the orchestrator's channel verbs (post, channels, thread link,
// ask-user) under the wake's grant, "ask" permissions for work an outside sender caused, and digest
// subscriptions. Real Postgres (a fresh schema), the real router, dispatcher and orchestrator tool.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../server/db";
import * as orchestrator from "../server/orchestrator";
import * as router from "../server/integrations/router";
import * as dispatcher from "../server/integrations/dispatcher";
import * as store from "../server/integrations/store";
import { launchOptions, permissionFor } from "../server/verbs";
import type { Adapter } from "../server/integrations/adapter";
import {
  PAIRING_ALPHABET, PAIRING_TTL_MS, digestEnvelope, digestWindow, fenceExternal, grantRefusal, inboundEnvelope, pairingCode, pairingReply, replyToOf,
  type Envelope, type OutboundMessage, type Target,
} from "../shared/integrations";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, wakeProgress } from "../web/src/workstream";
import type { OrcaConfig, RepoConfig } from "../server/config";
import { native } from "./happydom";
import { freshSchema, type TestDb } from "./pg";

const dom = { fetch: globalThis.fetch, Response: globalThis.Response };
beforeAll(() => { Object.assign(globalThis, native); });
afterAll(() => { Object.assign(globalThis, dom); });

describe("decisions (pure)", () => {
  test("pairing codes: six characters from an alphabet with no 0/O or 1/I/L", () => {
    const code = pairingCode(new Uint8Array([0, 1, 2, 250, 251, 255]));
    expect(code).toHaveLength(6);
    expect([...code].every((c) => PAIRING_ALPHABET.includes(c))).toBe(true);
    expect(PAIRING_ALPHABET).not.toMatch(/[01OIL]/);
    expect(pairingReply("ABC234")).toContain("approve pairing code ABC234");
  });

  test("digests: fixed windows per subscription; one envelope with one line per event", () => {
    expect(digestWindow(7, 60, 1_000)).toEqual({ key: "7:60000", nextAt: 60_000 });
    expect(digestWindow(7, 60, 59_999)).toEqual({ key: "7:60000", nextAt: 60_000 });
    expect(digestWindow(7, 60, 60_000)).toEqual({ key: "7:120000", nextAt: 120_000 });
    const ev = (key: string, at: number, title: string, repo: string): Envelope => ({ id: key, key, topic: "orca.pr.ci_failed", at, source: { adapter: "orca" }, scope: { repo }, title, text: "CI is\nfailing." });
    const one = ev("a", 2, "A", "r");
    expect(digestEnvelope([one], "7:60000")).toBe(one);
    const d = digestEnvelope([ev("b", 3, "B", "x"), one], "7:60000");
    expect(d).toMatchObject({ key: "digest:7:60000", title: "2 events", text: "• A: CI is failing.\n• B: CI is failing." });
    expect(d.scope).toBeUndefined(); // two repos: no single workstream, so no thread
  });

  test("grants for the new verbs: post only on the wake's own link; ask-user and channels at ask; thread link needs work", () => {
    const ask = { level: "ask" as const, repos: [], linkId: "L1" };
    expect(grantRefusal(ask, "post", { link: "L1" })).toBeUndefined();
    expect(grantRefusal(ask, "post", { link: "L2" })).toContain("only on its own link (L1)");
    expect(grantRefusal(ask, "ask-user")).toBeUndefined();
    expect(grantRefusal(ask, "channels")).toBeUndefined();
    expect(grantRefusal(ask, "thread", { _: ["link"], repo: "r" })).toContain('needs "work"');
    expect(grantRefusal({ level: "work", repos: ["r"] }, "thread", { _: ["link"], repo: "r" })).toBeUndefined();
    expect(grantRefusal(ask, "preview", { status: "" })).toBeUndefined(); // bin/orca sends a bare --status as ""
    expect(grantRefusal(undefined, "post", { link: "anywhere" })).toBeUndefined();
  });

  test("a cut-off wake's report lists the channel verbs it ran, so the next wake does not post twice", () => {
    const steps = [
      { at: 1, kind: "tool" as const, id: "a", name: "Bash", input: { command: 'orca post --link L1 "Merged #12."' } },
      { at: 2, kind: "tool" as const, id: "b", name: "Bash", input: { command: 'orca ask-user "Merge #13?"' } },
      { at: 3, kind: "tool" as const, id: "c", name: "Bash", input: { command: "orca channels" } },
    ];
    const text = wakeProgress(steps as never);
    expect(text).toContain("orca post");
    expect(text).toContain("orca ask-user");
    expect(text).not.toContain("orca channels");
  });

  test("a workstream an outside sender's wake touched runs with permission prompts on", () => {
    const repo = { name: "r", agentPermissionMode: "bypass" } as RepoConfig;
    expect(permissionFor(repo)).toBe("bypass");
    expect(permissionFor(repo, { grantScope: { level: "work", repos: ["r"] } })).toBe("ask");
    expect(launchOptions({} as OrcaConfig, repo, "claude", undefined, { grantScope: { level: "work", repos: ["r"] } }).permissionMode).toBe("ask");
  });
});

describe("with Postgres", () => {
  let pg: TestDb;
  let prev: Record<string, string | undefined> = {};
  const sent: { target: Target; msg: OutboundMessage; key: string }[] = [];
  const fake: Adapter = {
    kind: "slack", caps: { inbound: "socket", outbound: true, threads: true, edits: false, reactions: false, attachments: false, maxTextLength: 10_000 },
    start: async () => {}, stop: async () => {}, health: async () => ({ ok: true }),
    send: async (target, msg, key) => { sent.push({ target, msg, key }); return { ok: true, externalMsgId: `m${key}` }; },
  };
  const web: Envelope[] = [];

  beforeEach(async () => {
    prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_INSTANCE: process.env.ORCA_INSTANCE };
    process.env.ORCA_INSTANCE = "local";
    pg = await freshSchema("integrations2");
    process.env.ORCA_DATABASE_URL = pg.url;
    await db.close();
    router.resetPace();
    dispatcher.resetPace();
    sent.length = 0;
    web.length = 0;
    dispatcher.configure({ adapter: (id) => (id === "slack-work" ? fake : undefined), web: async (e) => { web.push(e); return { ok: true }; } });
    dispatcher.setRunning(() => ["slack-work"]);
    await store.addIntegration({ id: "slack-work", kind: "slack", name: "Work Slack", instance: "local", config: {}, enabled: true });
    await store.addLink({ id: "L1", integrationId: "slack-work", externalId: "C1", label: "#eng", level: "work", repos: ["r"], requireMention: false });
  });
  afterEach(async () => {
    dispatcher.configure({ adapter: () => undefined });
    dispatcher.setRunning(() => []);
    await db.close();
    await pg.drop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const msg = (eventId: string, from: string, channel = "C1", thread?: string) => inboundEnvelope({
    adapter: "slack", channel, eventId, from: { adapter: "slack", id: from, name: "Saajan" }, text: "is #12 merged?",
    ...(thread ? { thread: { adapter: "slack", externalId: thread } } : {}),
  });

  test("pairing: an unknown sender gets ONE code on their own place and a bell row; approval binds them and the next message is accepted", async () => {
    expect(await router.ingest("slack-work", msg("p1", "U9", "C1", "C1:5.5"), 1_000)).toBe("rejected");
    expect(await router.ingest("slack-work", msg("p2", "U9"), 2_000)).toBe("rejected"); // same pending code: no second reply
    const [pairing, ...more] = await store.pendingPairings(2_000);
    expect(more).toEqual([]);
    expect(pairing).toMatchObject({ adapter: "slack", externalId: "U9", name: "Saajan", linkId: "L1", expiresAt: 1_000 + PAIRING_TTL_MS });
    await dispatcher.dispatchOnce(3_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toMatchObject({ externalId: "C1", threadId: "C1:5.5" }); // answered where they wrote
    expect(sent[0]!.msg.text).toBe(pairingReply(pairing!.code));
    expect(web.map((e) => [e.topic, e.title])).toEqual([["orca.pairing.requested", "Pairing request from Saajan"]]);
    expect(web[0]!.text).toContain(`Approve code ${pairing!.code}`);

    await expect(store.approvePairing("NOPE22", { id: "x" }, 3_000)).rejects.toThrow("no pairing code NOPE22");
    const approved = await store.approvePairing(pairing!.code.toLowerCase(), { id: "saajan" }, 3_000);
    expect(approved).toMatchObject({ state: "approved", principalId: "saajan" });
    await expect(store.approvePairing(pairing!.code, { id: "saajan" }, 3_000)).rejects.toThrow("already approved");
    expect(await store.principalFor("slack", "U9")).toEqual({ id: "saajan", name: "Saajan", maxLevel: "ask" }); // a new person defaults to ask
    expect(await router.ingest("slack-work", msg("p3", "U9"), 4_000)).toBe("new");
    expect((await store.event("slack:p3"))?.grant).toMatchObject({ level: "ask", principalId: "saajan" });

    // A second identity bound to the SAME person keeps the person's name and level.
    await store.approvePairing((await store.pairingFor({ integrationId: "slack-work", adapter: "discord", externalId: "D1" }, () => "DISC23", 5_000)).pairing.code, { id: "saajan" }, 5_000);
    expect(await store.principalFor("discord", "D1")).toEqual({ id: "saajan", name: "Saajan", maxLevel: "ask" });
  });

  test("pairing: an expired code is refused, a denied one is gone, a notify link gives no code, and a catch-all link covers DMs", async () => {
    const { pairing } = await store.pairingFor({ integrationId: "slack-work", adapter: "slack", externalId: "U5" }, () => "OLDCDE", 0);
    await expect(store.approvePairing("OLDCDE", { id: "u5" }, PAIRING_TTL_MS + 1)).rejects.toThrow("has expired");
    expect(pairing.code).toBe("OLDCDE");
    const fresh = await store.pairingFor({ integrationId: "slack-work", adapter: "slack", externalId: "U5" }, () => "NEWCDE", PAIRING_TTL_MS + 1);
    expect(fresh).toMatchObject({ fresh: true, pairing: { code: "NEWCDE" } });
    expect(await store.denyPairing("NEWCDE")).toBe(true);
    expect(await store.pendingPairings(PAIRING_TTL_MS + 2)).toEqual([]);

    await store.addLink({ id: "L2", integrationId: "slack-work", externalId: "C2", level: "notify", repos: [], requireMention: false });
    expect(await router.ingest("slack-work", msg("n1", "U6", "C2"))).toBe("rejected");
    expect(await store.pendingPairings()).toEqual([]);

    expect(await router.ingest("slack-work", msg("dm1", "U7", "D-dm"))).toBe("rejected"); // no link for the DM, no catch-all
    expect(await store.pendingPairings()).toEqual([]);
    await store.addLink({ id: "Lstar", integrationId: "slack-work", externalId: "*", level: "ask", repos: [], requireMention: false });
    expect(await router.ingest("slack-work", msg("dm2", "U7", "D-dm"))).toBe("rejected");
    const [p] = await store.pendingPairings();
    expect(p).toMatchObject({ externalId: "U7", linkId: "Lstar" });
    await dispatcher.dispatchOnce();
    expect(sent.map((s) => s.target.externalId)).toEqual(["D-dm"]); // the reply goes to the DM, not to "*"
  });

  test("a place resolves to its own link, then each parent place in order, then the catch-all link", async () => {
    // A Linear issue sits in a project and a team: channel "issue:1", parents project, then team.
    await store.addPrincipal({ id: "ana", name: "Ana", maxLevel: "work" }, [{ adapter: "linear", externalId: "A1" }]);
    const ev = (id: string, channel: string, parents?: string[]) => ({
      ...inboundEnvelope({ adapter: "linear", channel, eventId: id, from: { adapter: "linear", id: "A1", name: "Ana" }, text: "hi" }),
      ...(parents ? { source: { adapter: "linear", channel, parents } } : {}),
    });
    await store.addLink({ id: "Lstar", integrationId: "slack-work", externalId: "*", level: "ask", repos: [], requireMention: false });
    await store.addLink({ id: "Lteam", integrationId: "slack-work", externalId: "team:ENG", level: "ask", repos: [], requireMention: false });
    expect(await router.ingest("slack-work", ev("x1", "issue:1", ["project:p-1", "team:ENG"]))).toBe("new");
    expect((await store.event("linear:x1"))?.source.linkId).toBe("Lteam");
    await store.addLink({ id: "Lproj", integrationId: "slack-work", externalId: "project:p-1", level: "ask", repos: [], requireMention: false });
    expect(await router.ingest("slack-work", ev("x2", "issue:1", ["project:p-1", "team:ENG"]))).toBe("new");
    expect((await store.event("linear:x2"))?.source.linkId).toBe("Lproj"); // the most specific parent wins
    expect(await router.ingest("slack-work", ev("x3", "issue:2", ["project:other"]))).toBe("new");
    expect((await store.event("linear:x3"))?.source.linkId).toBe("Lstar"); // no parent has a link: the catch-all
    await store.addLink({ id: "Lissue", integrationId: "slack-work", externalId: "issue:1", level: "ask", repos: [], requireMention: false });
    expect(await router.ingest("slack-work", ev("x4", "issue:1", ["project:p-1"]))).toBe("new");
    expect((await store.event("linear:x4"))?.source.linkId).toBe("Lissue"); // the place's own link first
  });

  test("machine events on a notify link: off by default; with machineEventsOnNotify they fan out but no agent gets them", async () => {
    await store.addLink({ id: "Lgh", integrationId: "slack-work", externalId: "repo:orca", level: "notify", repos: [], requireMention: false });
    await store.addSubscription({ topicPattern: "ext.github.*", filter: {}, targetKind: "web" });
    await store.addSubscription({ topicPattern: "ext.github.*", filter: {}, targetKind: "orchestrator" });
    const machine = (id: string) => ({ key: `gh:${id}`, topic: "ext.github.message" as const, at: 0, source: { adapter: "github", channel: "repo:orca" }, text: "PR #12 merged" });
    expect(await router.ingest("slack-work", machine("1"))).toBe("rejected"); // as today
    await store.addIntegration({ id: "slack-work", kind: "slack", name: "Work Slack", instance: "local", config: { machineEventsOnNotify: true }, enabled: true });
    expect(await router.ingest("slack-work", machine("2"))).toBe("new");
    const ev = await store.event("gh:2");
    expect(ev?.grant).toMatchObject({ level: "notify", linkId: "Lgh" });
    expect((await store.deliveries()).map((d) => d.target)).toEqual([{ kind: "web" }]); // not the orchestrator, not the inbound default
    await store.addPrincipal({ id: "ana", name: "Ana", maxLevel: "work" }, [{ adapter: "github", externalId: "ana" }]);
    expect(await router.ingest("slack-work", { ...machine("3"), actor: { external: { adapter: "github", id: "ana" } } })).toBe("rejected"); // a person still gets nothing on notify
  });

  test("orca post --reply answers the outside message that woke the orchestrator, on its link, place and thread", async () => {
    const cfg = { repos: [] } as unknown as OrcaConfig;
    // What the inbox hands the wake: the event's link, place and thread (shared replyToOf).
    const e = { key: "slack:e9", source: { adapter: "slack", linkId: "L1", channel: "C1" }, thread: { adapter: "slack", externalId: "C1:7.7" } };
    const replyTo = replyToOf(e)!;
    expect(replyTo).toEqual({ linkId: "L1", channel: "C1", threadId: "C1:7.7", eventKey: "slack:e9" });
    expect(replyToOf({ key: "x", source: { adapter: "orca" } })).toBeUndefined();
    expect(fenceExternal({ text: "hi", source: { adapter: "slack" } })).toContain('orca post --reply "<text>"');

    // It rides the queue with the message, so a busy orchestrator still knows where to answer.
    await db.queueMessage({ repo: ORCHESTRATOR_REPO, branch: ORCHESTRATOR_BRANCH, worktreePath: "/tmp/o", instruction: "q", attachments: [], grant: { level: "ask", repos: [] }, replyTo });
    expect((await db.claimQueuedMessage(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, "ask:"))?.replyTo).toEqual(replyTo);

    await expect(orchestrator.tool(cfg, "post", { reply: "Done." })).rejects.toThrow("this wake has no outside message to answer");
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: { level: "ask", repos: [], linkId: "L1" } as never, wakeReplyTo: replyTo as never });
    // bin/orca puts `--reply "Done."` in the flag's value; `--reply` then words works too.
    expect(await orchestrator.tool(cfg, "post", { reply: "Done." })).toContain("Queued for #eng (thread C1:7.7)");
    expect(await orchestrator.tool(cfg, "post", { reply: "", _: ["Merged", "too."] })).toContain("Queued for #eng");
    await dispatcher.dispatchOnce();
    expect(sent.map((x) => [x.target.externalId, x.target.threadId, x.msg.text])).toEqual([["C1", "C1:7.7", "Done."], ["C1", "C1:7.7", "Merged too."]]);

    // A catch-all link's reply goes to the DM it came from, never to "*".
    await store.addLink({ id: "Lstar", integrationId: "slack-work", externalId: "*", level: "ask", repos: [], requireMention: false });
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: { level: "ask", repos: [], linkId: "Lstar" } as never, wakeReplyTo: { linkId: "Lstar", channel: "D-dm" } as never });
    expect(await orchestrator.tool(cfg, "post", { reply: "Hi." })).toContain("D-dm");
    await dispatcher.dispatchOnce(Date.now() + 2_000);
    expect(sent.at(-1)!.target).toMatchObject({ externalId: "D-dm" });

    // The grant check sees the resolved link: a reply target outside the wake's own link is refused.
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: { level: "ask", repos: [], linkId: "L1" } as never, wakeReplyTo: { linkId: "Lstar", channel: "D-dm" } as never });
    await expect(orchestrator.tool(cfg, "post", { reply: "x" })).rejects.toThrow("only on its own link (L1)");
  });

  test("orca channels, post, thread link and ask-user — and the grant on post", async () => {
    const cfg = { repos: [{ name: "r", repoPath: "/nope", worktreeRoot: "/nope", baseBranch: "main", previewServices: [] }] } as unknown as OrcaConfig;
    await store.addSubscription({ topicPattern: "orca.question", filter: {}, targetKind: "link", targetId: "L1", digestSeconds: 0 });
    await store.pairingFor({ integrationId: "slack-work", adapter: "slack", externalId: "U3", name: "Ana" }, () => "WAIT23");
    const channels = await orchestrator.tool(cfg, "channels");
    expect(channels).toContain("link L1 · slack Work Slack on local · C1 (#eng) · work on r");
    expect(channels).toContain("sub 1 · orca.question → link L1");
    expect(channels).toContain("pairing WAIT23 · slack:U3 (Ana) waits for the user's approval");

    await expect(orchestrator.tool(cfg, "post", { link: "nope", _: ["hi"] })).rejects.toThrow('no link "nope"');
    expect(await orchestrator.tool(cfg, "thread", { _: ["link", "slack", "C1:9.9"], repo: "r", branch: "feat", link: "L1" })).toContain("Linked slack thread C1:9.9 to r/feat");
    expect(await store.threadLink("slack", "C1:9.9")).toMatchObject({ repo: "r", branch: "feat", linkId: "L1" });
    expect(await orchestrator.tool(cfg, "post", { link: "L1", repo: "r", branch: "feat", _: ["Merged", "#12."] })).toContain("Queued for #eng (thread C1:9.9)");
    expect(await orchestrator.tool(cfg, "ask-user", { _: ["Merge", "#12", "now?"] })).toContain("Asked.");
    await dispatcher.dispatchOnce();
    expect(sent.map((s) => [s.target.externalId, s.target.threadId, s.msg.text])).toEqual([
      ["C1", "C1:9.9", "Merged #12."],
      ["C1", undefined, "Merge #12 now?"], // the orca.question subscription
    ]);
    expect(web.map((e) => [e.topic, e.title, e.link])).toEqual([["orca.question", "The orchestrator asks", { orchestrator: true }]]);

    // Under an outside sender's "ask" grant from L1: post answers on L1 only; ask-user is allowed.
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: { level: "ask", repos: [], linkId: "L1" } as never });
    await store.addLink({ id: "L2", integrationId: "slack-work", externalId: "C2", level: "ask", repos: [], requireMention: false });
    await expect(orchestrator.tool(cfg, "post", { link: "L2", _: ["hi"] })).rejects.toThrow("only on its own link (L1)");
    expect(await orchestrator.tool(cfg, "post", { link: "L1", _: ["It merged."] })).toContain("Queued for #eng");
    await expect(orchestrator.tool(cfg, "thread", { _: ["link", "slack", "C1:1.1"], repo: "r", branch: "b" })).rejects.toThrow('needs "work"');
  });

  test("a restricted wake marks the workstream it steers with its grant (so its runs ask for permission)", async () => {
    const cfg = { repos: [{ name: "r", repoPath: "/nope", worktreeRoot: "/nope", baseBranch: "main", previewServices: [] }] } as unknown as OrcaConfig;
    const grant = { level: "work", repos: ["r"], linkId: "L1" };
    await db.patchEnrichment(ORCHESTRATOR_REPO, ORCHESTRATOR_BRANCH, { wakeGrant: grant as never });
    // The launch itself fails here (no repo on disk); the mark is written first, so every later run sees it.
    await expect(orchestrator.tool(cfg, "send", { repo: "r", branch: "feat", _: ["fix", "it"] })).rejects.toThrow();
    expect((await db.enrichment("r"))["feat"]?.grantScope).toEqual(grant);
  });

  test("a digest subscription sends one message per window, at the window's end", async () => {
    await store.addSubscription({ topicPattern: "orca.pr.ci_failed", filter: {}, targetKind: "link", targetId: "L1", digestSeconds: 60 });
    for (const [i, at] of [[1, 1_000], [2, 2_000], [3, 3_000]] as const) {
      await router.publish({ key: `pr-ci:r#${i}@a`, topic: "orca.pr.ci_failed", at, source: { adapter: "orca" }, scope: { repo: "r", branch: `b${i}` }, title: `#${i}`, text: "CI is failing." }, at);
    }
    await router.publish({ key: "pr-ci:r#4@a", topic: "orca.pr.ci_failed", at: 61_000, source: { adapter: "orca" }, title: "#4", text: "CI is failing." }, 61_000);
    expect((await store.deliveries()).map((d) => [d.digestKey, d.nextAt]).sort()).toEqual([["1:120000", 120_000], ["1:60000", 60_000], ["1:60000", 60_000], ["1:60000", 60_000]]);
    expect(await dispatcher.dispatchOnce(59_999)).toBe(0);
    expect(await dispatcher.dispatchOnce(60_000)).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ title: "3 events", text: "• #1: CI is failing.\n• #2: CI is failing.\n• #3: CI is failing." });
    expect((await store.deliveries({ state: "sent" }))).toHaveLength(3);
    expect(await store.threadsForWorkstream("r", "b1")).toEqual(new Map()); // a digest over three workstreams starts no thread
    expect(await dispatcher.dispatchOnce(120_000)).toBe(1);
    expect(sent[1]!.msg.text).toBe("CI is failing."); // a window of one is the event itself
  });

  test("a digest that fails retries as a whole", async () => {
    await store.addSubscription({ topicPattern: "orca.pr.*", filter: {}, targetKind: "link", targetId: "L1", digestSeconds: 10 });
    let n = 0;
    dispatcher.configure({ adapter: () => ({ ...fake, send: async () => { n++; return { ok: false, retryable: true, error: "down" }; } }) });
    await router.publish({ key: "a", topic: "orca.pr.merged", at: 0, source: { adapter: "orca" }, text: "a" }, 0);
    await router.publish({ key: "b", topic: "orca.pr.merged", at: 0, source: { adapter: "orca" }, text: "b" }, 0);
    expect(await dispatcher.dispatchOnce(10_000)).toBe(2);
    expect(n).toBe(1);
    expect((await store.deliveries()).map((d) => [d.state, d.attempts, d.nextAt])).toEqual([["failed", 1, 15_000], ["failed", 1, 15_000]]);
  });
});
