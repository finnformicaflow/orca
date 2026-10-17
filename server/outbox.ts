// The OUTBOX: history the database could not take, journaled to the state dir until it can.
//
// The laptop must keep running agents while the shared Postgres (on the cloud box) is unreachable —
// the day the box hung, the laptop bridge died with it, and nothing ran for the whole outage. So a
// turn's writes (start, steps, finish, check) and enrichment patches go through here: straight to the
// database when it answers, and when it throws `db.DbUnavailable`, into `~/.orca/outbox/` instead:
//   <runId>.json            one run's journal — its start, its numbered steps, its finish and check
//   enrichment-<ts>-<n>.json one enrichment patch, replayed in file-name (= arrival) order
// When the database comes back (`db.onAvailable`), `replay()` writes them through the SAME idempotent
// queries the live path uses — `startTurn` and the finish's rescue insert are ON CONFLICT (run_id) DO
// NOTHING, steps are keyed (run_id, seq) — so a replay that is interrupted and re-run lands every turn
// exactly once, with its original run id. No schema change.
//
// A run that has a journal keeps journaling until the replay drains it, so its writes reach the
// database in order. Each journal names the database it was meant for (`db.databaseKey()`, a hash —
// no credentials on disk): a test process sharing the state dir, or a bridge repointed at another
// database, never replays someone else's history.
//
// This is NOT advisory in the lease/ledger sense: it is the only copy of those turns until the replay
// lands them, so a corrupt file is kept (and logged), never silently dropped.
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import type { AgentStep, AgentTurn, StopReason, TurnCheck } from "../shared/agent";
import * as db from "./db";
import { readJsonDir, readJsonSync, statePath, stateDir, writeJsonSync } from "./state";

type StartInput = Parameters<typeof db.startTurn>[0];
type FinishInput = Parameters<typeof db.finishTurn>[1];

export type RunJournal = {
  kind: "turn";
  db: string;
  runId: string;
  repo?: string;
  branch?: string;
  start?: StartInput;
  steps: { seq: number; step: db.Fields }[];
  finish?: FinishInput;
  check?: TurnCheck;
  /** Bumped on every write, so a replay racing a still-running run knows not to delete what it
   *  hasn't written yet. */
  version: number;
};

type EnrichmentPatch = { kind: "enrichment"; db: string; repo: string; branch: string; fields: db.Fields; at: number };

const dir = () => join(stateDir(), "outbox");
const runFile = (runId: string) => statePath("outbox", `${runId.replace(/[^\w-]/g, "_")}.json`);

// In-memory mirror of the journals, keyed by absolute file path (the state dir can change under
// tests). A step-heavy run writes its journal hundreds of times; re-reading it each time would be
// quadratic.
const journals = new Map<string, RunJournal>();

function load(runId: string): RunJournal | undefined {
  const path = runFile(runId);
  const cached = journals.get(path);
  if (cached) return cached;
  const found = readJsonSync<RunJournal>(path);
  if (found?.kind === "turn") journals.set(path, found);
  return found?.kind === "turn" ? found : undefined;
}

function save(j: RunJournal): void {
  j.version++;
  const path = runFile(j.runId);
  journals.set(path, j);
  writeJsonSync(path, j);
}

function journalFor(runId: string, owner?: { repo?: string; branch?: string }): RunJournal {
  const j = load(runId) ?? { kind: "turn", db: db.databaseKey(), runId, steps: [], version: 0 };
  if (owner?.repo && !j.repo) j.repo = owner.repo;
  if (owner?.branch && !j.branch) j.branch = owner.branch;
  return j;
}

/** Whether this run has history waiting in the outbox (so its next write must queue behind it). */
export const pending = (runId: string): boolean => Boolean(load(runId));

/** Run `direct` against the database; if it is unreachable (or this run is already journaling),
 *  `journal` instead. Any other failure still throws — a bad query is not an outage. */
async function through(runId: string, direct: () => Promise<void>, journal: () => void): Promise<"db" | "outbox"> {
  if (!pending(runId)) {
    try {
      await direct();
      return "db";
    } catch (e) {
      if (!(e instanceof db.DbUnavailable)) throw e;
    }
  }
  journal();
  return "outbox";
}

export function startTurn(input: StartInput): Promise<"db" | "outbox"> {
  return through(input.runId, () => db.startTurn(input), () => {
    const j = journalFor(input.runId, input);
    j.start = input;
    save(j);
  });
}

export function finishTurn(runId: string, input: FinishInput): Promise<"db" | "outbox"> {
  return through(runId, () => db.finishTurn(runId, input), () => {
    const j = journalFor(runId, input.identity);
    j.finish = input;
    save(j);
  });
}

export function setCheck(runId: string, check: TurnCheck, owner?: { repo?: string; branch?: string }): Promise<"db" | "outbox"> {
  return through(runId, () => db.setCheck(runId, check), () => {
    const j = journalFor(runId, owner);
    j.check = check;
    save(j);
  });
}

/** As `db.appendSteps`: numbered from `startSeq`, a re-sent seq is not duplicated. */
export async function appendSteps(runId: string, startSeq: number, steps: db.Fields[]): Promise<number> {
  let written = 0;
  await through(runId, async () => { written = await db.appendSteps(runId, startSeq, steps); }, () => {
    const j = journalFor(runId);
    const have = new Set(j.steps.map((s) => s.seq));
    steps.forEach((step, i) => { if (!have.has(startSeq + i)) { j.steps.push({ seq: startSeq + i, step }); written++; } });
    save(j);
  });
  return written;
}

/** The next step number for a run: the database's, or — while it is down — one past the journal's. */
export async function nextStepSeq(runId: string): Promise<number> {
  const j = load(runId);
  const journaled = j?.steps.length ? Math.max(...j.steps.map((s) => s.seq)) + 1 : 1;
  if (j) return journaled;
  try {
    return await db.nextStepSeq(runId);
  } catch (e) {
    if (e instanceof db.DbUnavailable) return journaled;
    throw e;
  }
}

/** The branch a journaled run belongs to (an adopted run whose turn never reached the database). */
export function owner(runId: string): { repo: string; branch: string } | undefined {
  const j = load(runId);
  return j?.repo && j.branch ? { repo: j.repo, branch: j.branch } : undefined;
}

/** A run's journaled steps newer than `afterSeq` (all of them by default). */
export function steps(runId: string, afterSeq = 0): { seq: number; step: db.Fields }[] {
  return (load(runId)?.steps ?? []).filter((s) => s.seq > afterSeq).sort((a, b) => a.seq - b.seq);
}

function allJournals(): RunJournal[] {
  if (!existsSync(dir())) return [];
  const out: RunJournal[] = [];
  for (const name of readdirSync(dir())) {
    if (!name.endsWith(".json") || name.startsWith("enrichment-")) continue;
    const j = load(name.slice(0, -".json".length));
    if (j) out.push(j);
  }
  return out;
}

const startedAt = (j: RunJournal) => j.start?.startedAt ?? j.finish?.identity?.startedAt ?? 0;

/** The journaled turns of a branch, oldest first, shaped like `db.turns` — what the chat shows while
 *  the database is down (and until the replay has landed them). */
export function turns(repo: string, branch: string): AgentTurn[] {
  return allJournals()
    .filter((j) => j.repo === repo && j.branch === branch && (j.start || j.finish?.identity))
    .sort((a, b) => startedAt(a) - startedAt(b))
    .map((j) => {
      const s = j.start, f = j.finish, id = f?.identity;
      const status = f?.status ?? "running";
      const ordered = [...j.steps].sort((a, b) => a.seq - b.seq);
      return {
        id: j.runId,
        provider: s?.provider ?? id!.provider,
        instruction: s?.instruction ?? id?.instruction,
        source: s?.source ?? id?.source,
        prompt: s?.prompt ?? id?.prompt ?? "",
        response: f?.response ?? "",
        structured: f?.structured,
        sessionId: f?.sessionId ?? s?.sessionId,
        failed: status === "error" ? true : undefined,
        stopped: status === "stopped" ? true : undefined,
        check: j.check,
        stopReason: f?.stopReason ?? (status === "done" ? "end_turn" : status === "error" ? "error" : status === "stopped" ? "interrupted" : undefined) as StopReason | undefined,
        startedAt: startedAt(j),
        finishedAt: f?.finishedAt,
        steps: ordered.length ? ordered.map((o) => o.step as unknown as AgentStep) : undefined,
        stepSeq: ordered.length ? ordered[ordered.length - 1]!.seq : undefined,
      } satisfies AgentTurn;
    });
}

/** `fromDb` (oldest first) with the branch's journaled turns merged in by run id — the database's copy
 *  wins once it has one. */
export function mergeTurns(fromDb: AgentTurn[], repo: string, branch: string): AgentTurn[] {
  const have = new Set(fromDb.map((t) => t.id));
  const extra = turns(repo, branch).filter((t) => !have.has(t.id));
  if (!extra.length) return fromDb;
  return [...fromDb, ...extra].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

// ---- enrichment ----

let patchCounter = 0;
// The last enrichment the database gave us, per repo — served (with queued patches over it) while it
// is down, so a card keeps its title and session pointer rather than going blank.
const lastEnrichment = new Map<string, Record<string, db.Fields>>();

function queuedPatches(): (EnrichmentPatch & { file: string })[] {
  return readJsonDir<EnrichmentPatch>(dir(), (n) => n.startsWith("enrichment-"))
    .map(({ file, value }) => ({ file, ...value }))
    .filter((p) => p.kind === "enrichment");
}

const applyPatch = (into: Record<string, db.Fields>, p: { branch: string; fields: db.Fields }) => {
  const current = { ...(into[p.branch] ?? {}) };
  for (const [k, v] of Object.entries(p.fields)) {
    if (v === undefined || v === null) delete current[k]; else current[k] = v;
  }
  into[p.branch] = current;
};

/** `db.patchEnrichment`, or a queued patch while the database is down (or patches are still queued,
 *  so this one can't overtake them). */
export async function patchEnrichment(repo: string, branch: string, fields: db.Fields): Promise<{ queued: boolean }> {
  if (!queuedPatches().some((p) => p.db === db.databaseKey())) {
    try {
      await db.patchEnrichment(repo, branch, fields);
      return { queued: false };
    } catch (e) {
      if (!(e instanceof db.DbUnavailable)) throw e;
    }
  }
  const at = Date.now();
  const name = `enrichment-${String(at).padStart(15, "0")}-${String(++patchCounter).padStart(6, "0")}.json`;
  writeJsonSync(statePath("outbox", name), { kind: "enrichment", db: db.databaseKey(), repo, branch, fields, at } satisfies EnrichmentPatch);
  const known = lastEnrichment.get(repo);
  if (known) applyPatch(known, { branch, fields });
  return { queued: true };
}

/** A repo's enrichment: the database's (remembered), else the last one it gave plus queued patches.
 *  `degraded` says which. */
export async function enrichment(repo: string): Promise<{ data: Record<string, db.Fields>; degraded: boolean }> {
  try {
    const data = await db.enrichment(repo);
    lastEnrichment.set(repo, structuredClone(data));
    for (const p of queuedPatches()) if (p.repo === repo && p.db === db.databaseKey()) applyPatch(data, p);
    return { data, degraded: false };
  } catch (e) {
    if (!(e instanceof db.DbUnavailable)) throw e;
    return { data: structuredClone(lastEnrichment.get(repo) ?? {}), degraded: true };
  }
}

// ---- replay ----

let replaying: Promise<{ turns: number; enrichment: number }> | null = null;

/** Write everything journaled for THIS database through to it, oldest run first, then the enrichment
 *  patches in order. Serialised: concurrent calls share one pass. A write that fails leaves its file
 *  for the next pass. */
export function replay(): Promise<{ turns: number; enrichment: number }> {
  replaying ??= (async () => {
    let turnsLanded = 0, patches = 0;
    try {
      const mine = allJournals().filter((j) => j.db === db.databaseKey()).sort((a, b) => startedAt(a) - startedAt(b));
      for (const j of mine) {
        // A run still writing while we replay bumps `version`: go round again rather than delete
        // steps we haven't written. Everything here is idempotent, so a second pass is harmless.
        for (let pass = 0; pass < 5; pass++) {
          const seen = j.version;
          if (j.start) await db.startTurn(j.start);
          const ordered = [...j.steps].sort((a, b) => a.seq - b.seq);
          for (let i = 0; i < ordered.length;) {
            let k = i + 1;
            while (k < ordered.length && ordered[k]!.seq === ordered[k - 1]!.seq + 1) k++;
            await db.appendSteps(j.runId, ordered[i]!.seq, ordered.slice(i, k).map((o) => o.step));
            i = k;
          }
          if (j.finish) await db.finishTurn(j.runId, j.finish);
          if (j.check) await db.setCheck(j.runId, j.check);
          if (j.version !== seen) continue;
          const path = runFile(j.runId);
          journals.delete(path);
          rmSync(path, { force: true });
          turnsLanded++;
          break;
        }
      }
      for (const p of queuedPatches()) {
        if (p.db !== db.databaseKey()) continue;
        await db.patchEnrichment(p.repo, p.branch, p.fields);
        rmSync(p.file, { force: true });
        patches++;
      }
      if (turnsLanded || patches) console.log(`orca: outbox replayed ${turnsLanded} turn(s), ${patches} enrichment patch(es)`);
    } catch (e) {
      db.logUnlessDown("orca: outbox replay stopped (will retry when the database is next reachable)")(e);
    }
    return { turns: turnsLanded, enrichment: patches };
  })().finally(() => { replaying = null; });
  return replaying;
}

/** What is waiting, for /api/diagnostics and /api/health. */
export function summary(): { turns: number; enrichment: number } {
  return { turns: allJournals().filter((j) => j.db === db.databaseKey()).length, enrichment: queuedPatches().filter((p) => p.db === db.databaseKey()).length };
}

// A branch preview's read-only bridge shares this state dir but never writes: the real bridge replays.
db.onAvailable(() => (db.previewBridge() ? undefined : replay()));
