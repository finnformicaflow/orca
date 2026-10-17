// Handoff packs (server/handoff.ts): context one Orca server hands to another through the browser.
// The source makes a pack (`orca handoff create`), the browser exports it and posts it to the
// target's import, which stores the files as attachments and queues ONE message to its
// orchestrator. The secret scan and the size cap block a send; the import re-checks both. Real
// Postgres; the orchestrator's queue is a recorder, so no agent launches.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as handoff from "../server/handoff";
import { tool } from "../server/orchestrator";
import type { OrcaConfig } from "../server/config";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
let dir: string;
let prev: Record<string, string | undefined> = {};
const cfg = { repos: [], portRange: [4100, 4199], staleHours: 24 } as unknown as OrcaConfig;

beforeEach(async () => {
  prev = { ORCA_DATABASE_URL: process.env.ORCA_DATABASE_URL, ORCA_TAILSCALE_BIN: process.env.ORCA_TAILSCALE_BIN };
  pg = await freshSchema("handoff");
  process.env.ORCA_DATABASE_URL = pg.url;
  process.env.ORCA_TAILSCALE_BIN = "/nonexistent/tailscale"; // the self name falls back to the instance name
  await db.close();
  dir = await mkdtemp(join(tmpdir(), "orca-handoff-"));
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
});

// Fake credentials are built at run time, so this public repo holds no token-shaped literal.
const fake = {
  slack: ["xo", "xp-", "1234567890-abcdefghij"].join(""),
  anthropic: ["sk-", "ant-", "a".repeat(30)].join(""),
  ghp: ["gh", "p_", "A".repeat(36)].join(""),
  pat: ["github", "_pat_", "B".repeat(30)].join(""),
  aws: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
  key: ["-----BEGIN ", "RSA PRIVATE", " KEY-----"].join(""),
  password: ["DB_PASS", "WORD=hunter22"].join(""),
};

async function chat(): Promise<number> {
  await db.startTurn({ repo: "orca", branch: "discord-design", runId: "run-h1", provider: "claude", instruction: "Design the Discord bridge", prompt: "p", startedAt: 1_700_000_000_000 });
  await db.finishTurn("run-h1", { status: "done", response: "Use one bot per server; the design is in docs/discord.md.", finishedAt: 1_700_000_100_000 });
  return (await db.conversations()).find((c) => c.branch === "discord-design")!.id;
}

test("orca handoff create: files, a chat transcript as markdown, and nothing is sent", async () => {
  const doc = join(dir, "design.md");
  await writeFile(doc, "# Discord design\n\nOne bot per server.\n");
  const chatId = await chat();
  const out = await tool(cfg, "handoff", { _: ["create"], to: "orca-personal-box", title: "Discord setup", message: "Set up the Discord integration.", file: "design.md", chat: String(chatId), _cwd: dir });
  expect(out).toContain('"Discord setup" for orca-personal-box: 2 files');
  expect(out).toContain("It is NOT sent");

  const [pack] = await handoff.list();
  expect(pack!.direction).toBe("out");
  expect(pack!.sentAt).toBeUndefined();
  expect(pack!.problems).toEqual([]);
  expect(pack!.preview.map((f) => [f.name, f.kind])).toEqual([["design.md", "file"], [`chat-${chatId}-discord-design.md`, "chat"]]);
  const transcript = pack!.preview[1]!.text!;
  expect(transcript).toContain("## Turn 1");
  expect(transcript).toContain("Design the Discord bridge");
  expect(transcript).toContain("Use one bot per server");
  expect(pack!.wouldSay.split("\n")[0]).toMatch(/^\[handoff from .+\] Discord setup$/);
  expect(await tool(cfg, "handoff", { _: ["list"] })).toContain("ready, waiting for the user's click");
});

test("export → import: the target stores the files as attachments and queues one message; a second send is a no-op", async () => {
  const doc = join(dir, "notes.md");
  await writeFile(doc, "research notes\n");
  const { pack } = await handoff.createPack({ to: "orca-personal-box", title: "Discord setup", message: "Read these first.", files: [doc], source: "orca-flow-box" });
  const wire = await handoff.exportPack(pack.id);
  expect(wire.source).toBe("orca-flow-box");
  expect(Buffer.from(wire.files[0]!.data, "base64").toString()).toBe("research notes\n");

  const queued: { text: string; refs: string[] }[] = [];
  const queue = async (text: string, refs: string[]) => { queued.push({ text, refs }); };
  const r = await handoff.importPack(JSON.parse(JSON.stringify(wire)), queue);
  expect(r).toMatchObject({ duplicate: false, files: 1 });
  expect(queued).toHaveLength(1);
  expect(queued[0]!.text).toStartWith("[handoff from orca-flow-box] Discord setup\n\nRead these first.");
  expect(queued[0]!.text).toContain("- notes.md (15 B) orca-attachment://");
  const id = queued[0]!.refs[0]!.match(/orca-attachment:\/\/([0-9a-f-]{36})\//)![1]!;
  expect(new TextDecoder().decode((await db.attachment(id))!.bytes)).toBe("research notes\n");

  // A double click, or a retry after the mark-sent call failed: no second message.
  expect(await handoff.importPack(wire, queue)).toMatchObject({ duplicate: true });
  expect(queued).toHaveLength(1);

  await db.markHandoffSent(pack.id, "orca-personal-box");
  expect((await handoff.one(pack.id))!.sentTo).toBe("orca-personal-box");
  await expect(handoff.exportPack(pack.id)).rejects.toThrow("already sent");
});

test("the secret scan finds each obvious token kind, by line, without the value", () => {
  for (const [k, v] of Object.entries(fake)) {
    const hits = handoff.scanSecrets(`fine\nvalue ${v} here`, "f.md");
    expect(hits.length, k).toBeGreaterThan(0);
    expect(hits[0]!.line).toBe(2);
    expect(hits[0]!.kind).not.toContain(v);
  }
  // Placeholders and prose are not secrets.
  expect(handoff.scanSecrets("PASSWORD=\nPASSWORD=<your password>\nDB_PASSWORD=${DB_PASSWORD}\nthe password is in 1Password", "f")).toEqual([]);
});

test("a secret blocks the send: the pack is stored, its export is refused with the reason, and the import refuses it too", async () => {
  const leaky = join(dir, "env.txt");
  await writeFile(leaky, `HOME=/x\n${fake.slack}\n`);
  const out = await tool(cfg, "handoff", { _: ["create"], to: "orca-personal-box", title: "Leaky", file: leaky });
  expect(out).toContain("Send is BLOCKED");
  expect(out).toContain("env.txt line 2: looks like a Slack token");
  expect(out).not.toContain(fake.slack);
  const [pack] = await handoff.list();
  expect(pack!.problems[0]).toContain("env.txt line 2");
  const err = await handoff.exportPack(pack!.id).catch((e) => e);
  expect(err).toBeInstanceOf(handoff.HandoffError);
  expect(err.status).toBe(409);
  expect(err.message).toContain("Send blocked: env.txt line 2");

  // A message with a key is caught too, and the target does not trust the source's check.
  const wire = { version: 1, id: "pack-0001", source: "a", to: "b", title: "t", message: `use ${fake.anthropic}`, createdAt: 1, files: [] };
  const queued: string[] = [];
  const refused = await handoff.importPack(wire, async (t) => { queued.push(t); }).catch((e) => e);
  expect(refused.status).toBe(422);
  expect(refused.message).toContain("message line 1: looks like a Anthropic API key");
  expect(queued).toEqual([]);
});

test("the size cap: a file over it is refused at create and at import", async () => {
  const big = join(dir, "big.log");
  await writeFile(big, new Uint8Array(handoff.HANDOFF_MAX_FILE_BYTES + 1));
  const err = await handoff.createPack({ to: "b", title: "Big", files: [big], source: "a" }).catch((e) => e);
  expect(err.status).toBe(413);
  expect(err.message).toContain("big.log: 10.0 MB is over the 10.0 MB cap");
  expect(await handoff.list()).toEqual([]);

  const data = Buffer.from(new Uint8Array(handoff.HANDOFF_MAX_FILE_BYTES + 1)).toString("base64");
  const wire = { version: 1, id: "pack-0002", source: "a", to: "b", title: "t", message: "", createdAt: 1, files: [{ name: "big.bin", kind: "file", mimeType: "application/octet-stream", size: 0, data }] };
  const refused = await handoff.importPack(wire, async () => {}).catch((e) => e);
  expect(refused.status).toBe(422);
  expect(refused.message).toContain("big.bin");
});

test("import caller: a browser page only, from loopback or a whois-verified user device", async () => {
  const userDevice = async () => ({ ok: true });
  const taggedBox = async () => ({ ok: false, reason: "the caller is a tagged node (tag:orca), not a user device" });
  expect(await handoff.importCallerVerdict(null, "127.0.0.1", userDevice)).toMatchObject({ ok: false, reason: expect.stringContaining("no Origin") });
  expect(await handoff.importCallerVerdict("http://localhost:8788", "::ffff:127.0.0.1", taggedBox)).toEqual({ ok: true });
  expect(await handoff.importCallerVerdict("http://orca-flow-box:8787", "100.64.0.5", userDevice)).toEqual({ ok: true });
  expect(await handoff.importCallerVerdict("http://orca-flow-box:8787", "100.64.0.9", taggedBox)).toMatchObject({ ok: false, reason: expect.stringContaining("tagged node") });
});

test("the Handoffs page's pure parts: the target server by name, never the source; the card's draft link", async () => {
  const { handoffTarget, handoffDraftPath, parseHandoffDraft, byteSize } = await import("../web/src/workstream");
  const servers = [{ name: "orca-flow-box", url: "http://a:8787" }, { name: "orca-personal-box", url: "http://b:8787" }];
  const flow = { name: "orca-flow-box" };
  expect(handoffTarget(servers, "ORCA-personal-box", flow)?.url).toBe("http://b:8787");
  expect(handoffTarget(servers, "orca-flow-box", flow)).toBeUndefined(); // never to itself
  expect(handoffTarget(servers, "orca-flow-box", { name: "", url: "http://a:8787" })).toBeUndefined(); // the chosen base is the source too
  expect(handoffTarget(servers, "nope", flow, "http://b:8787")?.name).toBe("orca-personal-box");
  expect(handoffTarget(servers, "nope", flow, "http://a:8787")).toBeUndefined();
  const path = handoffDraftPath({ repo: "orca", branch: "feat/discord", title: "Discord & co" });
  expect(path.startsWith("/handoffs?")).toBe(true);
  expect(parseHandoffDraft(path.slice("/handoffs".length))).toEqual({ repo: "orca", branch: "feat/discord", title: "Discord & co" });
  expect(parseHandoffDraft("?repo=orca")).toBeNull();
  expect([byteSize(812), byteSize(4300), byteSize(1_400_000)]).toEqual(["812 B", "4.2 KB", "1.3 MB"]);
});
