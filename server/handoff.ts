// Handoff packs: context one Orca server hands to another (a work box to a personal box). The boxes
// cannot reach each other, so the user's BROWSER carries the pack: it GETs the pack from the source
// (`exportPack`) and POSTs it to the target's `/api/handoff/import` (`importPack`), then marks it
// sent on the source. Nothing is sent without that click.
//
// A pack is a title, a message for the target's orchestrator and files: text files, chat
// transcripts rendered as markdown, and stored attachments. The bytes are rows of `attachment`; the
// pack (table `handoff`) lists them. On the target, each file becomes an attachment again and ONE
// message is queued to its orchestrator: `[handoff from <source>] <title>`, the message, the files.
//
// Safety: every file is under `HANDOFF_MAX_FILE_BYTES` (the pack under `HANDOFF_MAX_PACK_BYTES`), and
// the secret scan (`scanSecrets`) blocks the export AND the import of a pack with an obvious token.
// The import is accepted only from loopback or a Tailscale user device (`importCallerVerdict`),
// the switcher's own whois check, and only from a browser page (an Origin header).
import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { basename, isAbsolute, resolve } from "path";
import * as db from "./db";
import { attachmentRef } from "./attachments";
import type { AgentTurn } from "../shared/agent";

export const HANDOFF_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const HANDOFF_MAX_PACK_BYTES = 25 * 1024 * 1024;
export const HANDOFF_VERSION = 1;

export class HandoffError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// ---- the secret scan ----
export type SecretFinding = { where: string; line: number; kind: string };

/** Obvious credentials. A match blocks the send; the value itself is never echoed. */
const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "Slack token (xox…)", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "Anthropic API key (sk-ant-…)", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { kind: "GitHub token (ghp_…)", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { kind: "GitHub token (github_pat_…)", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: "AWS access key (AKIA…)", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "private key block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  // `PASSWORD=value`, `DB_PASSWORD="x"`: a non-empty value that is not a placeholder (`<…>`, `${…}`).
  { kind: "password assignment (PASSWORD=…)", re: /\b\w*PASSWORD\w*\s*=\s*["']?(?![\s"'<$*]|$)\S/i },
];

/** Each line of `text` with an obvious secret: which pattern, never the value. Pure. */
export function scanSecrets(text: string, where: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split("\n").forEach((line, i) => {
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) out.push({ where, line: i + 1, kind: p.kind });
  });
  return out;
}

/** The bytes as text when they look like text (no NUL in the first 8 KB), else undefined. Pure. */
export function asText(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  return new TextDecoder().decode(bytes);
}

/** Why this pack must not be sent: secrets, a file over the cap, a pack over the cap, a file the
 *  database lost. Empty means it may go. Pure. */
export function packProblems(pack: { title: string; message: string }, files: { name: string; bytes?: Uint8Array; size: number }[]): string[] {
  const problems: string[] = [];
  const findings = [...scanSecrets(pack.title, "title"), ...scanSecrets(pack.message, "message")];
  let total = 0;
  for (const f of files) {
    total += f.size;
    if (!f.bytes) { problems.push(`${f.name}: the file is gone from the database (attachments are kept 30 days); create the pack again`); continue; }
    if (f.size > HANDOFF_MAX_FILE_BYTES) problems.push(`${f.name}: ${mb(f.size)} is over the ${mb(HANDOFF_MAX_FILE_BYTES)} cap for one file`);
    const text = asText(f.bytes);
    if (text !== undefined) findings.push(...scanSecrets(text, f.name));
  }
  if (total > HANDOFF_MAX_PACK_BYTES) problems.push(`the pack is ${mb(total)}, over the ${mb(HANDOFF_MAX_PACK_BYTES)} cap`);
  for (const s of findings) problems.push(`${s.where} line ${s.line}: looks like a ${s.kind}. Remove it and create the pack again`);
  return problems;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---- create (on the source) ----
/** One chat as markdown: every turn's instruction and answer, oldest first. Pure. */
export function transcriptMarkdown(c: { id: number; repo: string; branch: string; title?: string }, turns: AgentTurn[]): string {
  const lines = [`# ${c.title ? `${c.title} — ` : ""}${c.repo}/${c.branch}`, "", `Orca chat #${c.id}, ${turns.length} turn${turns.length === 1 ? "" : "s"}.`];
  turns.forEach((t, i) => {
    const status = !t.finishedAt ? "running" : t.failed ? "failed" : t.stopped ? "stopped" : "done";
    lines.push("", `## Turn ${i + 1} — ${(t.startedAt ? new Date(t.startedAt).toISOString() : "?")} (${status})`, "", "### Instruction", "", (t.instruction ?? t.prompt).trim() || "(none)", "", "### Response", "", answer(t).trim() || "(no output)");
  });
  return `${lines.join("\n")}\n`;
}

const answer = (t: AgentTurn) => t.response || t.structured?.outcome || "";
const slug = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat";
const mimeOf = (name: string) => (/\.(md|markdown)$/i.test(name) ? "text/markdown" : Bun.file(name).type.split(";")[0] || "application/octet-stream");

async function storeBytes(name: string, bytes: Uint8Array, kind: db.HandoffFile["kind"]): Promise<db.HandoffFile> {
  if (bytes.byteLength > HANDOFF_MAX_FILE_BYTES) throw new HandoffError(`${name}: ${mb(bytes.byteLength)} is over the ${mb(HANDOFF_MAX_FILE_BYTES)} cap for one file`, 413);
  const id = crypto.randomUUID();
  const mimeType = mimeOf(name);
  await db.addAttachment({ id, filename: name, mimeType, bytes });
  return { name, kind, attachmentId: id, size: bytes.byteLength, mimeType };
}

export type CreateInput = {
  to: string; title: string; message?: string; source: string;
  /** Paths (absolute, or relative to `cwd`) or attachment ids / `orca-attachment://` references. */
  files?: string[]; cwd?: string;
  /** Conversation ids (`orca chats`). */
  chats?: number[];
};

/** Make a pending pack. Throws `HandoffError` on a bad file, a missing chat or a file over the cap.
 *  Secrets do not stop the create: the pack is stored and its Send is blocked with the reason, so
 *  the user sees what to fix. */
export async function createPack(input: CreateInput): Promise<{ pack: db.HandoffRow; problems: string[] }> {
  const to = input.to?.trim(), title = input.title?.trim();
  if (!to) throw new HandoffError("--to <server name> is required (the target server, e.g. its Tailscale hostname)");
  if (!title) throw new HandoffError("--title is required");
  const files: db.HandoffFile[] = [];
  for (const raw of input.files ?? []) {
    const v = raw.trim();
    const id = v.match(/^(?:orca-attachment:\/\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/.*)?$/)?.[1];
    if (id) {
      const row = await db.attachment(id);
      if (!row) throw new HandoffError(`no attachment ${id} (pruned after 30 days, or never stored)`);
      if (row.bytes.byteLength > HANDOFF_MAX_FILE_BYTES) throw new HandoffError(`${row.filename}: ${mb(row.bytes.byteLength)} is over the ${mb(HANDOFF_MAX_FILE_BYTES)} cap for one file`, 413);
      files.push({ name: row.filename, kind: "attachment", attachmentId: id, size: row.bytes.byteLength, mimeType: row.mimeType });
      continue;
    }
    const path = isAbsolute(v) ? v : resolve(input.cwd ?? process.cwd(), v);
    if (!existsSync(path)) throw new HandoffError(`--file ${v}: no such file on this machine`);
    const st = statSync(path);
    if (!st.isFile()) throw new HandoffError(`--file ${v}: not a file; pass each file with its own --file`);
    if (st.size > HANDOFF_MAX_FILE_BYTES) throw new HandoffError(`${basename(path)}: ${mb(st.size)} is over the ${mb(HANDOFF_MAX_FILE_BYTES)} cap for one file`, 413);
    files.push(await storeBytes(basename(path), new Uint8Array(await readFile(path)), "file"));
  }
  if (input.chats?.length) {
    const all = await db.conversations(10_000);
    for (const chatId of input.chats) {
      const c = all.find((x) => x.id === chatId);
      if (!c) throw new HandoffError(`no chat #${chatId} (see \`orca chats\`)`);
      const md = transcriptMarkdown(c, await db.conversationTurns(chatId));
      files.push(await storeBytes(`chat-${chatId}-${slug(c.title ?? c.branch)}.md`, new TextEncoder().encode(md), "chat"));
    }
  }
  const pack: db.HandoffRow = {
    id: crypto.randomUUID(), direction: "out", title, message: (input.message ?? "").trim(), target: to,
    source: input.source, files, createdAt: Date.now(),
  };
  if (files.reduce((n, f) => n + f.size, 0) > HANDOFF_MAX_PACK_BYTES) throw new HandoffError(`the pack is over the ${mb(HANDOFF_MAX_PACK_BYTES)} cap; split it`, 413);
  await db.addHandoff(pack);
  return { pack, problems: (await view(pack)).problems };
}

/** The chat id of a live workstream (the UI's Hand off on a card). */
export async function chatOf(repo: string, branch: string): Promise<number | undefined> {
  return (await db.conversations(10_000)).find((c) => c.repo === repo && c.branch === branch && !c.archived)?.id;
}

// ---- the list and its preview ----
export type PackView = db.HandoffRow & {
  /** Each file with its text when it is text (the preview shows exactly what goes). */
  preview: { name: string; kind: db.HandoffFile["kind"]; size: number; mimeType: string; text?: string; missing?: boolean }[];
  problems: string[];
  /** The message the target's orchestrator gets. */
  wouldSay: string;
};

const PREVIEW_CHARS = 200_000;

async function view(pack: db.HandoffRow): Promise<PackView> {
  const loaded = await Promise.all(pack.files.map(async (f) => ({ f, row: await db.attachment(f.attachmentId) })));
  const problems = pack.direction === "out" ? packProblems(pack, loaded.map(({ f, row }) => ({ name: f.name, size: f.size, bytes: row?.bytes }))) : [];
  return {
    ...pack, problems,
    preview: loaded.map(({ f, row }) => {
      const text = row ? asText(row.bytes) : undefined;
      return { name: f.name, kind: f.kind, size: f.size, mimeType: f.mimeType, ...(text !== undefined ? { text: text.slice(0, PREVIEW_CHARS) } : {}), ...(row ? {} : { missing: true }) };
    }),
    wouldSay: importMessage(pack.source, pack.title, pack.message, pack.files.map((f) => ({ name: f.name, size: f.size }))),
  };
}

export async function list(): Promise<PackView[]> {
  return Promise.all((await db.handoffs()).map(view));
}

export async function one(id: string): Promise<PackView | undefined> {
  const p = await db.handoff(id);
  return p && view(p);
}

// ---- export (source) / import (target) ----
export type WireFile = { name: string; kind: db.HandoffFile["kind"]; mimeType: string; size: number; data: string };
export type WirePack = { version: number; id: string; source: string; to: string; title: string; message: string; createdAt: number; files: WireFile[] };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** The pack as the browser carries it. Refuses (409) a pack with a problem, or one already sent. */
export async function exportPack(id: string): Promise<WirePack> {
  const pack = await db.handoff(id);
  if (!pack) throw new HandoffError(`no pack ${id}`, 404);
  if (pack.sentAt) throw new HandoffError(`this pack was already sent to ${pack.sentTo}`, 409);
  const rows = await Promise.all(pack.files.map((f) => db.attachment(f.attachmentId)));
  const problems = packProblems(pack, pack.files.map((f, i) => ({ name: f.name, size: f.size, bytes: rows[i]?.bytes })));
  if (problems.length) throw new HandoffError(`Send blocked: ${problems.join("; ")}`, 409);
  return {
    version: HANDOFF_VERSION, id: pack.id, source: pack.source, to: pack.target, title: pack.title, message: pack.message, createdAt: pack.createdAt,
    files: pack.files.map((f, i) => ({ name: f.name, kind: f.kind, mimeType: f.mimeType, size: f.size, data: b64(rows[i]!.bytes) })),
  };
}

/** The one message the target's orchestrator gets. Pure. */
export function importMessage(source: string, title: string, message: string, files: { name: string; size: number; ref?: string }[]): string {
  return [
    `[handoff from ${source}] ${title}`,
    ...(message ? ["", message] : []),
    "",
    files.length ? `Files (${files.length}), stored as attachments — read them:` : "No files.",
    ...files.map((f) => `- ${f.name} (${f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`})${f.ref ? ` ${f.ref}` : ""}`),
  ].join("\n");
}

const safeFileName = (n: unknown) => typeof n === "string" && n.trim() && n.length <= 200 && !/[/\\\0]/.test(n);

/** Store a carried pack here and queue its message. `queue` hands the text and the attachment
 *  references to this side's orchestrator. A pack id seen before is a no-op (`duplicate`). */
export async function importPack(raw: unknown, queue: (text: string, refs: string[]) => Promise<unknown>): Promise<{ duplicate: boolean; files: number; text?: string }> {
  const p = raw as Partial<WirePack> | null;
  if (!p || typeof p !== "object" || p.version !== HANDOFF_VERSION) throw new HandoffError(`not a handoff pack (version ${HANDOFF_VERSION} expected)`);
  if (typeof p.id !== "string" || !/^[\w-]{8,64}$/.test(p.id)) throw new HandoffError("the pack has no valid id");
  if (typeof p.title !== "string" || !p.title.trim() || typeof p.source !== "string" || !p.source.trim()) throw new HandoffError("the pack needs a title and a source");
  if (!Array.isArray(p.files)) throw new HandoffError("the pack has no file list");
  if (await db.handoff(p.id, "in")) return { duplicate: true, files: p.files.length };
  const files = p.files.map((f) => {
    if (!f || !safeFileName(f.name) || typeof f.data !== "string") throw new HandoffError("a file in the pack has no valid name or data");
    const bytes = new Uint8Array(Buffer.from(f.data, "base64"));
    return { name: f.name, kind: (["file", "chat", "attachment"].includes(f.kind) ? f.kind : "file") as db.HandoffFile["kind"], mimeType: typeof f.mimeType === "string" ? f.mimeType : mimeOf(f.name), bytes, size: bytes.byteLength };
  });
  // Checked again here: the target does not trust that the source checked.
  const problems = packProblems({ title: p.title, message: p.message ?? "" }, files);
  if (problems.length) throw new HandoffError(`Import refused: ${problems.join("; ")}`, 422);
  const stored: db.HandoffFile[] = [];
  for (const f of files) {
    const id = crypto.randomUUID();
    await db.addAttachment({ id, filename: f.name, mimeType: f.mimeType, bytes: f.bytes });
    stored.push({ name: f.name, kind: f.kind, attachmentId: id, size: f.size, mimeType: f.mimeType });
  }
  const refs = stored.map((f) => attachmentRef(f.attachmentId, f.name));
  const text = importMessage(p.source, p.title.trim(), (p.message ?? "").trim(), stored.map((f, i) => ({ name: f.name, size: f.size, ref: refs[i] })));
  await queue(text, refs);
  await db.addHandoff({
    id: p.id, direction: "in", title: p.title.trim(), message: (p.message ?? "").trim(), target: typeof p.to === "string" ? p.to : "",
    source: p.source, files: stored, createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(), sentAt: Date.now(),
  });
  return { duplicate: false, files: stored.length, text };
}

/** May this caller import? Only a browser page (an Origin header), and only from loopback or a
 *  Tailscale user device — the switcher's whois check (`checkCaller`), run here even for a
 *  same-origin call, which the gate lets through without it. Pure but for `whois`. */
export async function importCallerVerdict(origin: string | null, ip: string | undefined, whois: (ip: string) => Promise<{ ok: boolean; reason?: string }>): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!origin) return { ok: false, reason: "an import must come from an Orca page in a browser (no Origin header)" };
  if (!ip) return { ok: false, reason: "the caller address is unknown" };
  const plain = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (plain === "127.0.0.1" || plain === "::1") return { ok: true };
  const v = await whois(plain);
  return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? "the caller is not a Tailscale user device" };
}
