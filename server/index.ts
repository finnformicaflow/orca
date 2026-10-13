import {
  API_PORT, configDocument, featuresOf, invalidateConfig, loadConfig, modelFor, parseConfigDocument,
  providerAllowed, providersFor, repoOf, runsHere, saveConfigDocument, type OrcaConfig, type RepoConfig,
} from "./config";
import * as git from "./git";
import * as gh from "./gh";
import * as agent from "./agent";
import * as attachments from "./attachments";
import * as preview from "./preview";
import * as forward from "./forward";
import { portFree, reclaimBridgePort, waitForPortFree } from "./net";
import { routingInfo, setProfileEnabled, usage } from "./usage";
import * as ledger from "./ledger";
import * as db from "./db";
import * as transcript from "./transcript";
import { backfillRun } from "./backfill";
import { eventStream } from "./events";
import * as lease from "./lease";
import { writeHandoffFile } from "./state";
import { metrics, countAgentPoll } from "./metrics";
import { renderText, summarize } from "./diagnostics";
import { postMessage as slackPost } from "./slack-api";
import * as orchestrator from "./orchestrator";
import * as mergeQueue from "./mergeQueue";
import * as notify from "./notify";
import { health, historyHours, instanceRate, monthCost, startMetricsSampler } from "./health";
import * as verbs from "./verbs";
import { BusyError, checkGate, compact, launchOptions, newWorktree, placement, removeWorktree, startPreview } from "./verbs";
import { ORCHESTRATOR_REPO, attachmentRefs, followUpPrompt, mergeSafe, prDescriptionPrompt, sweepText, titleFromPrompt, validPrDescription, withAttachments } from "../web/src/workstream";
import { AGENT_PROVIDERS, attachCommand, isAgentProvider, providerBinary, type AgentOutcome, type AgentProvider, type AgentStep } from "../shared/agent";
import { providerOfModel } from "../shared/models";
import { diskStore, parseShotRequest, shooter, type ShotRequest } from "./screenshot";

/** Resume the implementation agent to write a template-exact PR body from its full context and the
 *  final git state. A self-contained fresh call is the fallback when the native session is missing
 *  or stale; invalid/empty output blocks creation instead of silently opening a title-only PR. */
async function resolvePrDescription(
  provider: typeof AGENT_PROVIDERS[number], worktreePath: string, base: string,
  input: { provided?: string; outcome?: AgentOutcome; sessionId?: string; task?: string },
): Promise<string> {
  // A user-supplied body avoids a model call entirely.
  if (input.provided?.trim()) { ledger.record({ kind: "pr-description", provider, status: "done", prDescriptionAvoided: true }); return input.provided.trim(); }
  if (input.provided !== undefined) throw new Error("PR description cannot be empty");
  const [template, summary, diff] = await Promise.all([
    git.readPrTemplate(worktreePath),
    git.changeSummary(worktreePath, base),
    git.worktreeDiff(worktreePath, base),
  ]);
  const { commits } = summary;
  if (!diff.trim()) throw new Error("Can't create a PR description because the branch has no changes from its base");
  const prompt = prDescriptionPrompt({
    template, diff, task: input.task, outcome: input.outcome,
    commits: commits.map((c) => c.subject).reverse(), // oldest-first
  });
  const startedAt = Date.now();
  let usedResume = Boolean(input.sessionId); // resuming the native session avoids a fresh full-context call
  let description = await agent.describePr(provider, prompt, { cwd: worktreePath, resume: input.sessionId });
  if (!validPrDescription(description ?? "", template) && input.sessionId) {
    usedResume = false;
    description = await agent.describePr(provider, prompt); // stale native session → self-contained same-provider retry
  }
  if (!validPrDescription(description ?? "", template)) {
    ledger.record({ kind: "pr-description", provider, status: "error", durationMs: Date.now() - startedAt, prDescriptionAvoided: false, errorKind: "invalid-description" });
    throw new Error(`The ${provider} agent did not return a complete PR description. No PR was created; retry Promote.`);
  }
  ledger.record({ kind: "pr-description", provider, status: "done", durationMs: Date.now() - startedAt, prDescriptionAvoided: usedResume });
  return description!.trim();
}

// Take the API port from a stale bridge (a prior dev run, or another checkout's instance) before
// binding — otherwise a fresh bridge with newer routes silently loses the bind and the UI proxies
// `/api` to the old code, 404ing on anything new (this is what made "Test master" report "not found").
// A branch preview's own bridge (db.previewBridge, scripts/preview-orca.sh) reads the shared database
// for its preview and does NOTHING else: none of the startup work below, which acts on this
// instance's runs, previews and metrics, and no write route (see `api`).
const PREVIEW_BRIDGE = db.previewBridge();
if (!PREVIEW_BRIDGE && !(await portFree(API_PORT)) && reclaimBridgePort(API_PORT)) {
  console.log(`orca: reclaimed :${API_PORT} from a stale bridge`);
  await waitForPortFree(API_PORT);
}
// Migrate before anything touches the database. A migration ledger this code can't reconcile (another
// branch's step under one of main's ids, not safely re-runnable) refuses to start with instructions.
await db.open().catch((e) => {
  if (!(e instanceof db.MigrationRefused)) throw e;
  console.error(e.message);
  process.exit(1);
});
if (!PREVIEW_BRIDGE) await preview.reattach(); // re-adopt dev servers that outlived a crashed/hard-killed prior bridge
// Turns whose run died with a previous bridge would otherwise render "working…" forever. Leases are
// the authority on what's genuinely still running (they deliberately survive shutdown). Before
// writing one off, try to recover what it actually did from the provider's own session file — the
// agent usually kept working after the bridge died, and its answer is on disk.
const reconcile = () => db.reconcileRunning(lease.liveRunIds(), async ({ runId, sessionId }) => {
  const found = await backfillRun(runId, sessionId);
  return found?.response ? { response: found.response, structured: found.outcome } : undefined;
});
const { closed, recovered } = PREVIEW_BRIDGE ? { closed: 0, recovered: 0 } : await reconcile();
if (closed) console.log(`orca: closed ${closed} interrupted turn(s), recovered ${recovered} from the provider's session`);
// Runs still going under a lease are adopted, not written off: when each exits, its turn is finished
// from the session file and the orchestrator hears about it, as if the bridge had never restarted.
const adopted = PREVIEW_BRIDGE ? 0 : agent.adoptLeases(async (runId, sessionId, worktreePath) => {
  const found = await backfillRun(runId, sessionId, worktreePath);
  return found?.response ? { response: found.response, structured: found.outcome } : undefined;
}, orchestrator.dir());
if (adopted) console.log(`orca: adopted ${adopted} run(s) still going from the previous bridge`);
// A follow-up queued while a run was in flight launches when that run finishes. The launcher lives
// here because it needs the repo's config (model, permission mode, timeout) — agent.ts stays
// ignorant of configuration.
agent.onQueuedMessage(async (message) => {
  const cfg = await loadConfig();
  const repo = repoOf(cfg, message.repo);
  const provider = isAgentProvider(message.provider) ? message.provider : "claude";
  if (!providerAllowed(repo, provider)) return; // opted out since it was queued
  // The pin lives in enrichment, so a message queued before a model switch still runs on the model
  // the card shows when it is dispatched.
  const pinned = (await db.enrichment(repo.name))[message.branch]?.preferredModel;
  await agent.runAgent(message.worktreePath, withAttachments(followUpPrompt(message.instruction), message.attachments), {
    ...launchOptions(cfg, repo, provider, typeof pinned === "string" ? pinned : undefined),
    branch: message.branch, action: "followup", instruction: message.instruction,
  });
});

// The orchestrator's wake loop: a worker it is responsible for going idle wakes it, and its own run
// ending drains what queued up meanwhile. Config is read per event, like every request. The
// notification centre hears the same event first (it swallows its own failures), so a toast never
// waits on a wake.
agent.onRunFinished(async (run) => {
  await notify.onRunFinished(run);
  await orchestrator.onRunFinished(await loadConfig(), run);
});
// The merge queue (server/mergeQueue.ts): every marked PR this instance drives, once a minute. A red
// or refused PR the orchestrator owns is reported to it like a worker's problem; a merge, like a finish.
mergeQueue.onReport(async (text) => orchestrator.report(await loadConfig(), text));
setInterval(() => {
  void loadConfig().then((cfg) => mergeQueue.tick(cfg)).catch((e) => console.error("orca: merge queue pass failed", e));
}, mergeQueue.MERGE_POLL_MS).unref();
// Warm the review queue (gh.listReviewPrs) so its slow cold fetch is paid here, not by a caller. A
// local-only repo just fails quietly.
void loadConfig().then((cfg) => cfg.repos.filter(verbs.repoHere)
  .forEach((r) => void gh.listReviewPrs(r.repoPath).catch(() => {})));
// A wake that was in flight when the previous bridge stopped: re-queue what it was handling.
if (!PREVIEW_BRIDGE) void loadConfig().then((cfg) => orchestrator.recover(cfg, reconcile)).catch((e) => console.error("orca: orchestrator recovery failed", e));

// Publish this instance's worktrees whether or not a browser is polling it: with two instances,
// the board on the OTHER machine shows this one's workstreams from the shared inventory, which
// only the owner can write. (A cloud box has no browser of its own; before this, its worktrees
// appeared only while someone's board happened to be forwarded to it.)
const INVENTORY_PUBLISH_MS = 10_000;
if (!PREVIEW_BRIDGE) setInterval(() => {
  void loadConfig().then((cfg) => Promise.all(cfg.repos.filter(verbs.repoHere).map((r) => agentRows(r).catch((e) => console.error(`orca: inventory publish failed for ${r.name}`, e)))));
  void publishPreviews(); // the same for previews: the running-previews menu on any machine lists them
}, INVENTORY_PUBLISH_MS).unref();

/** Publish this instance's previews now (and answer the aggregate list) — on the timer, and right
 *  after a start or stop so another machine's menu needn't wait for the tick. */
// No viewer on a publish, so no loopback forwards for the others' previews.
const publishPreviews = () => loadConfig().then((cfg) => verbs.previewRows(cfg, { loopback: false }))
  .catch((e) => { console.error("orca: preview publish failed", e); return []; });

// This machine's vitals into instance_metric once a minute, for the header chip's 24h graphs
// (server/health.ts). Each instance samples itself; either answers the history from Postgres.
if (!PREVIEW_BRIDGE) startMetricsSampler();

// Orphaned preview databases (a bridge crash / reaped worktree / worker test run that never dropped
// its own) and stale test-harness Docker containers — on this instance's repos only. At startup
// (whatever accumulated since the last run), then hourly; a run's own failures are logged, never
// thrown (see preview.reap).
const REAP_INTERVAL_MS = 60 * 60 * 1000;
function runReaper(): void {
  void loadConfig().then((cfg) => preview.reap(cfg.repos.filter(verbs.repoHere)))
    .catch((e) => console.error("orca: preview/container reap failed", e));
}
if (!PREVIEW_BRIDGE) {
  runReaper();
  setInterval(runReaper, REAP_INTERVAL_MS).unref();
}

// How many of a conversation's newest turns are sent with their steps attached (older ones load on unfold).
const STEPS_FOR_TURNS = 40;
const STEPS_FOR_PAGE = 10;

// How long shutdown waits for outstanding history writes before leaving anyway.
const DRAIN_TIMEOUT_MS = 5_000;

const DIST = new URL("../web/dist/", import.meta.url).pathname;

const json = (data: unknown, status = 200) => Response.json(data, { status });

const BRIDGE_BRANCH = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim() || undefined;
const bridgeInfo = () => ({ preview: PREVIEW_BRIDGE, branch: BRIDGE_BRANCH, port: API_PORT });

/** A caller-supplied base ref, rejected unless it looks like a branch name (never a `-flag` that git
 *  would read as an option). */
const baseParam = (url: URL): string | undefined => {
  const b = url.searchParams.get("base");
  return b && /^[\w.][\w./-]*$/.test(b) ? b : undefined;
};

/** Worktrees reported by OTHER instances, read back from Postgres. Tagged with the instance and its
 *  last check-in so the board can mark a sleeping machine's rows as stale rather than presenting them
 *  as current. Advisory: a database hiccup degrades to "just what this machine sees". */
async function foreignInventory(repo: string, exclude?: string): Promise<unknown[]> {
  try {
    const rows = await db.inventory(repo);
    return rows
      .filter((r) => r.instance !== (exclude ?? db.instanceName()))
      .map((r) => ({ ...r.data, instance: r.instance, instanceSeenAt: r.seenAt, remote: true }));
  } catch (e) {
    console.error("orca: inventory read failed", e);
    return [];
  }
}

/** Refuse an action a repo hasn't opted into. The bridge is the authority, not the client: a stale
 *  tab must not be able to post to Slack or start a preview a repo has since turned off. */
const notEnabled = (repo: RepoConfig, feature: string) =>
  json({ error: `${feature} is not enabled for ${repo.name} — turn it on in the repo's config` }, 403);

// Routes served by ANY instance because they read only Postgres — history stays readable even when
// the machine that produced it is asleep. Everything else touches a worktree or spawns a process and
// must run where the repo lives.
const DATABASE_ONLY = new Set([
  "/api/turns", "/api/enrichment", "/api/enrichment/import", "/api/config", "/api/config/document",
  "/api/usage", "/api/diagnostics", "/api/turns/steps", "/api/queued", "/api/queued/cancel", "/api/health",
  "/api/health/history", "/api/config/instance-rate",
  // Answered by EVERY instance: its own worktrees (if the repo is checked out here) plus what the
  // others published — a repo can live on several instances now, so no one instance owns the list.
  "/api/agents",
  // Needs no worktree, only SLACK_TOKEN — which is on the machine you click from, not the box.
  "/api/slack",
  // Every instance's running previews: this one's live, the others' as they published them.
  "/api/previews",
  // The notification centre: one table, written once by the instance where each event happened.
  "/api/notifications", "/api/notifications/read",
]);

// DATABASE_ONLY routes whose `?instance=` selects rows rather than a machine — never forwarded.
const INSTANCE_IS_A_FILTER = new Set(["/api/health/history"]);

/** Forward a request to the instance that owns the repo. Returns undefined when the request should
 *  be handled locally. (The chat's live stream is not forwarded — /api/events relays instead.) */
async function forwardToOwner(req: Request, url: URL, repo: RepoConfig, cfg: OrcaConfig, body: Record<string, unknown>): Promise<Response | undefined> {
  // An explicit `instance` on an otherwise local route (`/api/health?instance=cloud`) still forwards —
  // except where `instance` names whose rows to read, not where to run.
  if (DATABASE_ONLY.has(url.pathname) && (!url.searchParams.get("instance") || INSTANCE_IS_A_FILTER.has(url.pathname))) return undefined;
  const instance = db.instanceName();
  // Where this request belongs: an explicit instance, else the worktree's home, else the repo's
  // default (verbs.placement). A workstream placed on the laptop stays on the laptop even when the
  // repo's default is the cloud box.
  const home = await placement(repo, {
    instance: url.searchParams.get("instance") ?? body.instance, branch: url.searchParams.get("branch") ?? body.branch,
    worktreePath: url.searchParams.get("worktree") ?? body.worktreePath ?? body.worktree, key: body.key,
  });
  if (home === instance) return undefined;
  const base = cfg.instances?.[home];
  if (!base) {
    return json({ error: `this belongs on "${home}", which has no address configured (set instances.${home})` }, 502);
  }
  const target = new URL(url.pathname + url.search, base);
  try {
    // Streamed through, not buffered: a large body (a diff) reaches the browser as it arrives.
    const upstream = await fetch(target, {
      method: req.method,
      headers: req.headers,
      // The body was consumed by the JSON parse above; re-serialise it (a clone of a consumed
      // request has no text, and the forwarded request went out empty).
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(body),
      signal: req.signal,
    });
    // A preview relayed from its owner is opened from THIS machine's browser. Its tailnet url is the
    // default; only a repo whose app needs a secure context gets the opened service forwarded to
    // localhost here, with that URL as `localUrl`.
    if (url.pathname === "/api/preview" && upstream.ok) {
      const key = String(url.searchParams.get("key") ?? body.key ?? "");
      // The owner published whether this key needs a secure context; `repo` here may be repoOf's
      // fallback (the poll names no repo), which once localized every Orca preview to localhost.
      const secure = verbs.secureForRelay(await db.previewInventory().catch(() => []), key, repo.previewSecureContext);
      return json(forward.localize(key, (await upstream.json()) as { port: number; url: string; open: boolean }[], new URL(base).hostname, secure));
    }
    if (url.pathname === "/api/preview/stop") forward.release(String(body.key ?? ""));
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  } catch (e) {
    return json({ error: `${repo.runsOn} is unreachable: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
}

/** The Draft lane for a repo as THIS instance sees it: its own worktrees (reaped, statused,
 *  published to the shared inventory) plus what the other instances published. Called by the
 *  browser's poll and by the publish timer below, so an instance nobody is looking at still keeps
 *  its inventory current — the board on the other machine is read from it. */
async function agentRows(repo: RepoConfig): Promise<unknown[]> {
  // Source of truth for the Draft lane: live worktrees + run status + local mergeability.
  //
  // An instance only inspects the repos IT runs — it cannot stat another machine's disk — and
  // publishes what it found. The response is the union across instances, read back from Postgres,
  // so a board on either machine shows both and an instance that is asleep leaves its rows stale
  // rather than making the whole board slow or empty.
  const instance = db.instanceName();
  if (!verbs.repoHere(repo)) return foreignInventory(repo.name); // not checked out here: only what others see
  let wts = await git.listWorktrees(repo.repoPath, repo.worktreeRoot);
  // Auto-archive: worktrees whose PR merged or closed (on GitHub too) are reaped after a grace
  // period, unless that would lose work — then they're flagged and kept (verbs.cleanupRepo).
  const reapedBranches = new Set((await verbs.cleanupRepo(repo)).filter((c) => c.action === "reaped").map((c) => c.branch));
  wts = wts.filter((w) => !reapedBranches.has(w.branch));
  const live = await agent.detectRunning(wts.map((w) => w.branch)); // recover status lost on restart
  const base = await git.resolveBase(repo.repoPath, repo.baseBranch); // origin/<base>, not stale local
  const mine = await Promise.all(wts.map(async (w) => {
    const run = agent.status(w.worktreePath);
    const agentStatus = run.status !== "idle" ? run.status : live.has(w.branch) ? "running" : "idle";
    return {
      ...w,
      agentStatus,
      agentError: run.error,
      agentResult: run.result,
      agentOutcome: run.structured,
      agentMeta: run.meta,
      agentCheck: run.check,
      agentStartedAt: run.startedAt,
      agentFinishedAt: run.finishedAt,
      agentProvider: run.provider,
      agentRunId: run.runId,
      agentPrompt: run.prompt,
      sessionId: run.sessionId,
      mergeClean: await git.mergeClean(repo.repoPath, base, w.branch),
    };
  }));
  // Publish before responding, so the other instance's next poll sees this one's work.
  await db.publishInventory(repo.name, mine.map((w) => ({ branch: w.branch, data: w as unknown as db.Fields })))
    .catch((e) => console.error("orca: inventory publish failed", e)); // advisory — never fail a poll
  return [...mine, ...(await foreignInventory(repo.name, instance))];
}

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  // Read per request, not once at startup: the configuration lives in the database now, so adding a
  // repo or changing a setting takes effect on the next call rather than the next deploy. Cached in
  // config.ts and invalidated on write, so this is a map lookup in the common case.
  const cfg = await loadConfig();
  if (PREVIEW_BRIDGE && req.method !== "GET") {
    return json({ error: "This is a branch preview's bridge: it reads the shared database but changes nothing. Use the main Orca for actions." }, 403);
  }
  // Pasted/dropped files (any type): stored in the shared database, answered as references
  // (server/attachments.ts) that whichever instance runs the agent turns into a local file. The
  // field is still `paths` so the composer needn't care. Handled before the JSON body parse below —
  // this is the one multipart route.
  if (req.method === "POST" && p === "/api/attachments") {
    const files = (await req.formData()).getAll("files").filter((f): f is File => typeof f !== "string");
    try {
      return json({ paths: await attachments.store(files) });
    } catch (e) {
      if (e instanceof attachments.AttachmentTooLarge) return json({ error: e.message }, 413);
      throw e;
    }
  }
  // One stored attachment's bytes, for the chat's thumbnail / file chip. Read from Postgres, so any
  // instance answers it whichever one took the upload. Served inline but sandboxed and never sniffed:
  // a pasted SVG or HTML file must not run as this (unauthenticated) origin.
  const stored = req.method === "GET" && p.match(/^\/api\/attachments\/([0-9a-f-]{36})$/);
  if (stored) {
    const file = await db.attachment(stored[1]!);
    if (!file) return json({ error: "attachment not found (pruned after 30 days, or never stored)" }, 404);
    return new Response(file.bytes as Uint8Array<ArrayBuffer>, { headers: {
      "Content-Type": file.mimeType, "Content-Disposition": `inline; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "Cache-Control": "private, max-age=86400, immutable",
    } });
  }
  // PUT carries a body too (the pasted config document) — parsing only POST silently handed the
  // handler an empty object, which then failed validation as "repos must be a non-empty array".
  const body: any = req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => ({})) : {};
  // The orchestrator. Its tool route carries the repo INSIDE the command's arguments, so these are
  // answered before a request is resolved to (and possibly forwarded for) a repo.
  // The live feed for every chat in the tab, multiplexed (server/events.ts). Not repo-scoped and never
  // forwarded: this instance serves its own bus and relays the others', so it is answered here before
  // a request is resolved to a repo.
  if (req.method === "GET" && p === "/api/events") {
    const self = db.instanceName();
    const others = url.searchParams.get("local") ? [] : Object.entries(cfg.instances ?? {}).filter(([n]) => n !== self).map(([, base]) => base);
    return eventStream(req, others);
  }
  // Screenshots (server/screenshot.ts): the one capped browser on this box, behind one queue. Never
  // forwarded — a worker shoots a preview on its own instance.
  if (req.method === "POST" && p === "/api/screenshot") {
    let shot: ShotRequest;
    try { shot = parseShotRequest(body); } catch (e) { return json({ error: (e as Error).message }, 400); }
    return json(await shooter().shoot(shot));
  }
  const shotId = p.match(/^\/api\/screenshots\/(shot-[\w-]+)$/)?.[1];
  if (req.method === "GET" && shotId) {
    const file = diskStore().path(shotId);
    return file ? new Response(Bun.file(file), { headers: { "content-type": "image/png" } }) : json({ error: "not found" }, 404);
  }
  if (p.startsWith("/api/orchestrator") && cfg.orchestratorOn && cfg.orchestratorOn !== db.instanceName()) {
    // ONE instance hosts the orchestrator (orchestratorOn); everything about it goes there.
    const base = cfg.instances?.[cfg.orchestratorOn];
    if (!base) return json({ error: `the orchestrator lives on "${cfg.orchestratorOn}", which has no address configured (set instances.${cfg.orchestratorOn})` }, 502);
    try {
      const upstream = await fetch(new URL(url.pathname + url.search, base), { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : JSON.stringify(body), signal: req.signal });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } catch (e) {
      return json({ error: `${cfg.orchestratorOn} is unreachable: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  }
  if (req.method === "POST" && p === "/api/orchestrator/event") {
    // A worker report from another instance (its run-finished hook), delivered to the orchestrator here.
    if (typeof body.text !== "string") return json({ error: "text required" }, 400);
    await orchestrator.deliverReport(cfg, body.text, typeof body.key === "string" ? body.key : undefined);
    return json({ ok: true });
  }
  if (p === "/api/cleanup/sweep") {
    // The one-off sweep (`orca sweep`): a dry run unless `confirm`. Not repo-scoped — this instance
    // sweeps its own disk and asks every other instance to sweep theirs (`local` stops the fan-out).
    const confirm = req.method === "POST" && body.confirm === true;
    const reports = body.local ? [await verbs.sweep(cfg, { confirm })] : await verbs.sweepAll(cfg, { confirm });
    return json({ reports, text: sweepText(reports) });
  }
  if (req.method === "GET" && p === "/api/orchestrator") return json(await orchestrator.status(cfg));
  if (req.method === "POST" && p === "/api/orchestrator/model") {
    try { await orchestrator.setModel(body.model); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/orchestrator/message") {
    if (typeof body.text !== "string" || !body.text.trim()) return json({ error: "text required" }, 400);
    return json(await orchestrator.message(cfg, body.text, body.attachments ?? []));
  }
  if (req.method === "POST" && p === "/api/orchestrator/tool") {
    // What `bin/orca` calls. A refusal is a 400 with a message written for the model to act on.
    try {
      return json({ text: await orchestrator.tool(cfg, String(body.verb ?? ""), body.args ?? {}) });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  // Every repo-scoped call names its repo (query for GET, body for POST); defaults to the first.
  // The orchestrator's conversation is recorded under a reserved repo name that is no git repo —
  // only the database-backed chat routes (turns, stream, queued) are ever asked for it.
  const repoName = url.searchParams.get("repo") ?? body.repo;
  const repo = repoName === ORCHESTRATOR_REPO
    ? { name: ORCHESTRATOR_REPO, repoPath: orchestrator.dir(), worktreeRoot: orchestrator.dir(), baseBranch: "", previewServices: [] }
    : repoOf(cfg, repoName);
  // A repo this instance doesn't run is handled by the instance that does.
  const forwarded = await forwardToOwner(req, url, repo, cfg, body);
  if (forwarded) return forwarded;

  if (req.method === "POST" && p === "/api/compact") {
    // The context ring's Compact button: `/compact` in this conversation's own session. A busy
    // session (a run in flight, here or under a lease) is a 409 the button shows, never queued.
    try {
      return json(repo.name === ORCHESTRATOR_REPO ? await orchestrator.compact(cfg) : await compact(cfg, repo as RepoConfig, String(body.branch ?? "")));
    } catch (e) {
      const busy = e instanceof BusyError || (e instanceof Error && /already running/.test(e.message));
      return json({ error: busy ? new BusyError().message : e instanceof Error ? e.message : String(e) }, busy ? 409 : 400);
    }
  }
  if (req.method === "GET" && p === "/api/health") {
    // This machine's vitals, for the header's instance chip. `?instance=` reaches another instance
    // through the ordinary placement forwarding (an explicit instance beats everything). The rate is
    // this machine's (config → IMDS estimate → 0); `month` is that rate over this month's uptime,
    // for the card's Cost cell (absent when the query fails — vitals must still answer).
    const [h, rate] = await Promise.all([health(), loadConfig().then((c) => instanceRate(c.instanceHourlyUsd))]);
    const month = rate.hourlyUsd > 0 ? await monthCost(rate.hourlyUsd).catch(() => undefined) : undefined;
    return json({ ...h, rate, month });
  }
  if (req.method === "GET" && p === "/api/notifications") {
    // The centre's rows (any instance answers: one table). `since` is the catch-up cursor after a
    // dropped stream, in ms.
    const since = Number(url.searchParams.get("since"));
    return json(await db.notifications({ since: Number.isFinite(since) && since > 0 ? since : undefined, limit: Number(url.searchParams.get("limit")) || undefined }));
  }
  if (req.method === "POST" && p === "/api/notifications/read") {
    // The only write: a notification is unread or read, and nothing is deleted from here.
    const ids = body.all === true ? "all" : Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
    const changed = await db.markNotificationsRead(ids);
    return json({ ok: true, changed });
  }
  if (req.method === "GET" && p === "/api/health/history") {
    // An instance's recorded vitals (instance_metric), oldest first — read from Postgres, so either
    // instance answers for either, even when the one asked about is down.
    return json(await db.metricHistory(url.searchParams.get("instance") || db.instanceName(), historyHours(url.searchParams.get("hours"))));
  }
  if (req.method === "GET" && p === "/api/usage") {
    // Claude (OAuth usage endpoint) + Codex (local app-server) both expose read-only rate-limit
    // windows from the CLI's login. The Cursor CLI exposes no such endpoint — `about`/`status` report
    // only auth + subscription tier, no utilization — so there is deliberately no Cursor usage here.
    return json(await usage());
  }
  if (req.method === "POST" && p === "/api/usage/profile") {
    // Hydra state is PER HOST — not in DATABASE_ONLY, so an explicit ?instance= (or body.instance)
    // forwards to that machine via the ordinary placement path above; omitted, it answers here.
    const name = String(body.name ?? "");
    if (!name) return json({ error: "name required" }, 400);
    try {
      return json({ profiles: await setProfileEnabled(name, Boolean(body.enabled)) });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  if (req.method === "GET" && p === "/api/diagnostics") {
    // Efficiency report over the run ledger + process metrics. `?format=text` for the terminal.
    const report = summarize(ledger.all(), metrics(), await routingInfo(), preview.lastReapReport(), db.migrationReport());
    return url.searchParams.get("format") === "text"
      ? new Response(renderText(report), { headers: { "content-type": "text/plain; charset=utf-8" } })
      : json(report);
  }
  if (req.method === "GET" && p === "/api/config/document") {
    // The stored document, paths still templated — what a settings UI edits and what you'd paste
    // into another machine.
    return json(await configDocument());
  }
  if (req.method === "PUT" && p === "/api/config/document") {
    // Paste-a-document, wrangler style: the whole config is the unit, so repos absent from it are
    // removed. Invalid input is REJECTED with every problem listed — never half-applied.
    const { config, errors } = parseConfigDocument(body.config ?? body);
    if (!config) return json({ errors }, 400);
    await saveConfigDocument(config);
    return json({ ok: true, repos: config.repos.map((r) => r.name) });
  }
  if (req.method === "POST" && p === "/api/config/instance-rate") {
    // Settings' Machine cost: one instance's USD/hour (null clears it, back to the IMDS estimate / 0).
    const instance = typeof body.instance === "string" ? body.instance.trim() : "";
    const usd = body.hourlyUsd === null || body.hourlyUsd === "" ? null : Number(body.hourlyUsd);
    if (!instance || (usd !== null && !(Number.isFinite(usd) && usd >= 0))) return json({ error: "instance and a non-negative hourlyUsd (or null) are required" }, 400);
    await db.setInstanceHourlyUsd(instance, usd);
    invalidateConfig();
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/config") {
    const available = AGENT_PROVIDERS.filter((provider) => Boolean(Bun.which(providerBinary(provider))));
    const repos = await Promise.all(cfg.repos.map(async (r) => ({
      name: r.name, baseBranch: r.baseBranch, slackChannel: r.slackChannel, prLabels: r.prLabels,
      previewLabel: r.previewLabel,
      hasRemote: await git.hasRemote(r.repoPath),
      defaultModel: modelFor(cfg, r), // what an unpinned card runs on (Claude), so the picker can show it
      // Opt-ins travel to the client so it can hide what the bridge would refuse — the bridge still
      // enforces, because a tab open since before a change would otherwise offer the old actions.
      features: featuresOf(r),
      providers: providersFor(r, available),
    })));
    const agentProviders = available;
    // apiPort lets the browser open the terminal WebSocket straight at the bridge — the Vite dev proxy
    // (Bun runtime) can't forward a WS upgrade. In the built app this equals the page's own port.
    // This instance's name and the others', so the New-draft box can place a workstream and a card
    // can say where it lives. `runsOn` is each repo's default placement.
    return json({
      repos: repos.map((r, i) => ({ ...r, runsOn: cfg.repos[i]!.runsOn })),
      staleHours: cfg.staleHours, agentProviders, apiPort: API_PORT,
      instance: db.instanceName(), instances: Object.keys(cfg.instances ?? {}),
      instanceHourlyUsd: cfg.instanceHourlyUsd ?? {},
      // Which bridge answered — a branch preview labels itself with it (BridgeLabel), so a number
      // read from main's bridge is never mistaken for the branch's.
      bridge: bridgeInfo(),
    });
  }
  // The orchestrator's verbs over HTTP, so an orchestrator on one instance can spawn / send /
  // address on another: these go through the same placement forwarding as every repo route.
  if (req.method === "POST" && p === "/api/workstreams/move") {
    // Move a workstream's worktree to another instance (verbs.moveWorkstream). Placement forwards
    // this to the instance that holds it now; the target adopts over HTTP.
    try { return json(await verbs.moveWorkstream(cfg, repo, String(body.branch), String(body.to))); }
    catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 409); }
  }
  if (req.method === "POST" && p === "/api/workstreams/archive") {
    // `orca archive` for a workstream living here, sent by the orchestrator's instance. Placement
    // forwards it to the instance holding the worktree, which is the only one that can remove it.
    await verbs.archiveWorkstream(repo, String(body.branch));
    return json({ ok: true, instance: db.instanceName() });
  }
  if (req.method === "POST" && p === "/api/workstreams/spawn") {
    const ws = await verbs.createWorkstream(cfg, repo, { prompt: String(body.prompt ?? ""), title: body.title, model: body.model, fields: { orchestrated: true } });
    return json({ ...ws, instance: db.instanceName() });
  }
  if (req.method === "POST" && p === "/api/workstreams/followup") {
    if (typeof body.model === "string") await db.patchEnrichment(repo.name, String(body.branch), { preferredModel: body.model, preferredProvider: providerOfModel(body.model) });
    const r = await verbs.followUp(cfg, repo, String(body.branch), { instruction: String(body.instruction ?? "") });
    await db.patchEnrichment(repo.name, String(body.branch), { orchestrated: true });
    return json({ ...r, instance: db.instanceName() });
  }
  if (req.method === "POST" && p === "/api/conflicts/settle") {
    // The board's Address PR / Resolve conflicts call this first: a changelog-only conflict is merged,
    // unioned and pushed here, and the agent is asked only about what's left.
    if (!body.branch) return json({ error: "branch required" }, 400);
    return json(await verbs.settleConflict(repo, String(body.branch)));
  }
  if (req.method === "POST" && p === "/api/workstreams/address") {
    const r = await verbs.addressPr(cfg, repo, String(body.branch));
    await db.patchEnrichment(repo.name, String(body.branch), { orchestrated: true });
    return json({ ...r, instance: db.instanceName() });
  }
  if (req.method === "POST" && p === "/api/workstreams") {
    // The selected provider summarises the prompt into a short title (falls back locally); jitter suffix
    // (à la Claude Code branch names) keeps names collision-resistant.
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (!providerAllowed(repo, provider)) return notEnabled(repo, `The ${provider} agent`);
    const title = (featuresOf(repo).aiTitles ? await agent.summarize(provider, body.prompt) : undefined)
      ?? titleFromPrompt(body.prompt);
    return json({ ...(await newWorktree(repo, title)), title, instance: db.instanceName() });
  }
  if (req.method === "GET" && p === "/api/summary") {
    const wt = url.searchParams.get("worktree");
    if (!wt) return json({ error: "worktree required" }, 400);
    // A branch with a PR is measured against that PR's target, not the repo default — otherwise a
    // stacked PR's card diffstat counts the whole stack while its detail page counts only its own.
    return json(await git.changeSummary(wt, await git.resolveBase(repo.repoPath, baseParam(url) ?? repo.baseBranch)));
  }
  if (req.method === "GET" && p === "/api/diff") {
    const wt = url.searchParams.get("worktree");
    if (!wt) return json({ error: "worktree required" }, 400);
    return json({ diff: await git.worktreeDiff(wt, await git.resolveBase(repo.repoPath, repo.baseBranch)) });
  }
  if (req.method === "POST" && p === "/api/promote") {
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (!providerAllowed(repo, provider)) return notEnabled(repo, `The ${provider} agent`);
    // No body from the UI → resume the implementation agent to fill the repo template (or Orca's
    // default) from its full task context and the final diff. Invalid output blocks PR creation.
    const base = await git.resolveBase(repo.repoPath, repo.baseBranch);
    // With AI descriptions off, Promote costs nothing and blocks on nothing: the body is the repo's
    // template or its commit list. That's the difference between a ~60s Promote and an instant one.
    const describe = featuresOf(repo).aiPrDescription
      ? resolvePrDescription(provider, body.worktreePath, base, {
          provided: body.body, outcome: body.outcome, sessionId: body.sessionId, task: body.task,
        })
      : git.resolvePrBody(body.worktreePath, base, body.body);
    const [, prBody] = await Promise.all([
      git.pushBranch(body.worktreePath, body.branch), // the branch must exist on origin for `gh pr create`
      describe,
    ]);
    const pr = await gh.createPr(body.worktreePath, {
      title: body.title, body: prBody, base: repo.baseBranch, head: body.branch, draft: body.draft,
    });
    if (body.labels?.length) await gh.addLabel(repo.repoPath, pr.number, body.labels.join(",")).catch(() => {});
    return json(pr);
  }
  if (req.method === "GET" && p === "/api/prs") {
    const prs = await gh.listPrs(repo.repoPath, repo.previewLabel ?? "preview"); // source of truth for the PR lanes
    void notify.prs(repo.name, prs); // CI failing / conflicts, once per PR — read off the list, no extra call
    return json(prs);
  }
  if (req.method === "GET" && p === "/api/prs/merged") {
    // `since` is the client's local midnight in ms — see gh.listMerged.
    const since = Number(url.searchParams.get("since"));
    return json(await gh.listMerged(repo.repoPath, Number.isFinite(since) && since > 0 ? since : undefined));
  }
  const commentsMatch = p.match(/^\/api\/prs\/(\d+)\/comments$/);
  if (req.method === "GET" && commentsMatch) {
    // Conversation comments newer than `since` (ISO) — the agent decides what needs a response.
    return json(await gh.conversationComments(repo.repoPath, Number(commentsMatch[1]), url.searchParams.get("since") || undefined));
  }
  const reviewEvidenceMatch = p.match(/^\/api\/prs\/(\d+)\/review-evidence$/);
  if (req.method === "GET" && reviewEvidenceMatch) {
    return json(await gh.reviewEvidence(repo.repoPath, Number(reviewEvidenceMatch[1])));
  }
  const reviewSignalMatch = p.match(/^\/api\/prs\/(\d+)\/review-signal$/);
  if (req.method === "GET" && reviewSignalMatch) {
    return json(await gh.reviewSignal(repo.repoPath, Number(reviewSignalMatch[1])));
  }
  const ciEvidenceMatch = p.match(/^\/api\/prs\/(\d+)\/ci-evidence$/);
  if (req.method === "GET" && ciEvidenceMatch) {
    return json(await gh.ciEvidence(repo.repoPath, Number(ciEvidenceMatch[1])));
  }
  if (req.method === "GET" && p === "/api/prs/review") {
    return json(await gh.listReviewPrs(repo.repoPath)); // coworker PRs (the review queue)
  }
  const detailMatch = p.match(/^\/api\/prs\/(\d+)$/);
  if (req.method === "GET" && detailMatch) {
    return json(await gh.prDetail(repo.repoPath, Number(detailMatch[1])));
  }
  const diffMatch = p.match(/^\/api\/prs\/(\d+)\/diff$/);
  if (req.method === "GET" && diffMatch) {
    return json({ diff: await gh.prDiff(repo.repoPath, Number(diffMatch[1])) });
  }
  if (req.method === "POST" && p === "/api/prs/merge-when-green") {
    // Mark (or with `cancel`, unmark) a PR merge-when-green — the PR menu's and `orca merge`'s route.
    try {
      const pr = body.pr === undefined ? undefined : Number(body.pr);
      return json({ text: await orchestrator.mergeWhenGreen(cfg, repo, { pr, branch: body.branch, small: Boolean(body.small), by: body.by, cancel: Boolean(body.cancel) }) });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  if (req.method === "POST" && p === "/api/merge") {
    const status = await gh.prStatus(repo.repoPath, body.pr);
    if (!mergeSafe(status)) {
      const why = status.mergeable === "CONFLICTING" ? "has merge conflicts"
        : status.ciStatus === "failing" ? "CI is failing"
        : status.ciStatus === "pending" ? "CI is still running — use auto-merge to merge once it passes"
        : "isn't ready to merge";
      return json({ error: `Can't merge — PR ${why}`, status }, 409);
    }
    await gh.mergePr(repo.repoPath, body.pr);
    if (body.branch) await db.archive(repo.name, body.branch); // finished, not forgotten — the chat history stays
    if (body.worktreePath) await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/prs/close") {
    await gh.closePr(repo.repoPath, body.pr); // abandon without merging
    if (body.worktreePath) {
      agent.stop(body.worktreePath);
      await agent.killInWorktree(body.worktreePath);
      preview.stop(body.worktreePath, true); // teardown: drop this preview's DB
      await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    }
    if (body.branch) await git.deleteBranch(repo.repoPath, body.branch);
    if (body.branch) await db.archive(repo.name, body.branch);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/preview") {
    if (!featuresOf(repo).previews) return notEnabled(repo, "Previews");
    const svcs = await startPreview(cfg, repo, body.key, body.worktree, typeof body.branch === "string" ? body.branch : undefined);
    void publishPreviews();
    return json(svcs);
  }
  if (req.method === "POST" && p === "/api/preview/master") {
    if (!featuresOf(repo).previews) return notEnabled(repo, "Previews");
    // "Test master": spin up a preview of the base branch itself, in a detached worktree of the
    // latest base. Same machinery as a branch preview (copy env, link node_modules, start services),
    // keyed by the worktree path — so status/stop go through the existing /api/preview endpoints.
    const { worktreePath } = await git.baseWorktree(repo.repoPath, repo.worktreeRoot, repo.baseBranch);
    await git.copyToWorktree(repo.repoPath, worktreePath, repo.copyToWorktree);
    await git.linkToWorktree(repo.repoPath, worktreePath, repo.linkToWorktree);
    await preview.start(worktreePath, worktreePath, repo.previewServices, cfg.portRange);
    void publishPreviews();
    const host = preview.ownerHost(cfg.instances, db.instanceName());
    void notify.watchPreview({ key: worktreePath, repo: repo.name, title: `${repo.name} ${repo.baseBranch}`, host });
    return json({ worktreePath, svcs: await preview.status(worktreePath, host) });
  }
  if (req.method === "GET" && p === "/api/previews") {
    // Every instance's running previews (not repo-scoped): this one's live, the others' published.
    // Forward the others' previews here only for a page served from localhost (the Host it asked
    // for — Vite's proxy keeps it): a phone, or anyone pointed at the box, opens the owner's url.
    return json(await verbs.previewRows(cfg, { loopback: ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) }));
  }
  if (req.method === "GET" && p === "/api/preview") {
    const key = url.searchParams.get("key");
    return json(key ? await preview.status(key, preview.ownerHost(cfg.instances, db.instanceName())) : []);
  }
  if (req.method === "POST" && p === "/api/preview/stop") {
    preview.stop(body.key, true); // teardown: drop this preview's DB
    notify.forgetPreview(String(body.key ?? "")); // a preview you stopped mid-boot is not a failed one
    // The placement goes with it, so a refreshed page stops looking for it here.
    await db.clearPreviewPlacement(String(body.key ?? "")).catch((e) => console.error("orca: preview placement clear failed", e));
    void publishPreviews();
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/slack") {
    // The one Slack path for every provider: post the message VERBATIM from your identity via
    // chat.postMessage (SLACK_TOKEN). No model, no per-agent branching — deterministic and instant.
    // A failure surfaces as an error rather than silently degrading, so a post that didn't land is
    // never mistaken for one that did.
    if (!featuresOf(repo).slack) return notEnabled(repo, "Slack posting");
    if (!repo.slackChannel) return json({ error: "no Slack channel configured for this repo" }, 400);
    const r = await slackPost(repo.slackChannel, String(body.text ?? ""));
    if (!r.ok) return json({ error: `Slack post failed: ${r.error ?? "unknown error"}` }, 502);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/handoff") {
    // Write the portable-transcript seed for an interactive cross-provider handoff; Copy CLI `cat`s it.
    return json({ path: writeHandoffFile(repo.name, String(body.branch), String(body.content ?? "")) });
  }
  if (req.method === "POST" && p === "/api/worktrees/adopt") {
    const wt = await git.adoptWorktree(repo.repoPath, repo.worktreeRoot, body.branch);
    await git.copyToWorktree(repo.repoPath, wt.worktreePath, repo.copyToWorktree);
    await git.linkToWorktree(repo.repoPath, wt.worktreePath, repo.linkToWorktree);
    return json(wt);
  }
  if (req.method === "POST" && p === "/api/worktrees/sync") {
    // Pull remote work down: fetch once, fast-forward each worktree to its upstream (never forces).
    return json(await git.syncWorktrees(repo.repoPath, repo.worktreeRoot));
  }
  if (req.method === "POST" && p === "/api/worktrees/remove") {
    await removeWorktree(repo, body.worktreePath, body.branch, Boolean(body.deleteBranch)); // never deletes a branch with an open PR
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/agents") {
    countAgentPoll();
    // Queued messages live in the shared database, so the count is attached here for every row —
    // this instance's worktrees and the others' alike — rather than published with stale inventory.
    const [rows, queued] = await Promise.all([agentRows(repo), db.queuedCounts(repo.name).catch(() => new Map<string, number>())]);
    return json(rows.map((r) => ({ ...(r as Record<string, unknown>), queued: queued.get((r as { branch: string }).branch) ?? 0 })));
  }
  if (req.method === "POST" && p === "/api/prs/label") {
    await gh.addLabel(repo.repoPath, body.pr, repo.previewLabel ?? "preview");
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/prs/ready") {
    await gh.markReady(repo.repoPath, body.pr);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/prs/auto-merge") {
    if (!featuresOf(repo).autoMerge) return notEnabled(repo, "Auto-merge");
    await gh.enableAutoMerge(repo.repoPath, body.pr); // GitHub merges once checks + reviews pass
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/prs/disable-auto-merge") {
    await gh.disableAutoMerge(repo.repoPath, body.pr); // cancel the queued auto-merge
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/prs/draft") {
    await gh.convertToDraft(repo.repoPath, body.pr);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/merge-local") {
    await git.mergeLocal(repo.repoPath, repo.baseBranch, body.branch);
    if (body.branch) await db.archive(repo.name, body.branch);
    if (body.worktreePath) await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/agents/run") {
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (!providerAllowed(repo, provider)) return notEnabled(repo, `The ${provider} agent`);
    if (agent.isRunning(body.worktreePath)) {
      // Queued rather than refused: the run in flight finishes and this goes next, exactly as a
      // follow-up typed mid-run does (see /api/agent below) — a board action landing on a busy
      // worktree is a double-click or a race, not an error.
      if (body.branch) {
        const queued = await db.queueMessage({
          repo: repo.name, branch: body.branch, worktreePath: body.worktreePath,
          instruction: body.instruction ?? body.prompt, attachments: body.attachments ?? [], provider,
        });
        return json({ status: "queued", queued });
      }
      return json({ error: "an agent is already running for this worktree" }, 409);
    }
    const receipt = await agent.runAgent(body.worktreePath, body.prompt, {
      ...launchOptions(cfg, repo, provider, body.model),
      resume: body.resume, history: body.history, handoffFrom: body.handoffFrom, branch: body.branch,
      action: body.action, evidenceChars: body.evidenceChars, instruction: body.instruction,
    });
    return json(receipt);
  }
  if (req.method === "POST" && (p === "/api/agent" || p === "/api/claude")) {
    // Generic action in a worktree (or the repo for repo-level actions). Keep /api/claude as a
    // compatibility alias for older clients; it always selects Claude unless provider is explicit.
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (!providerAllowed(repo, provider)) return notEnabled(repo, `The ${provider} agent`);
    if (agent.isRunning(body.key)) {
      // Any action landing on a busy worktree (a typed follow-up, Address PR, Resolve conflicts,
      // Retry, Fix) is QUEUED rather than refused — the composer already invited exactly that ("the
      // agent is working — queue the next instruction"), and this route used to 409 every other
      // board action, losing the message. The CLI's `address`/`send` queue the same way (verbs.ts).
      if (body.branch && body.worktree) {
        const queued = await db.queueMessage({
          repo: repo.name, branch: body.branch, worktreePath: body.worktree,
          instruction: body.instruction ?? body.prompt, attachments: body.attachments ?? [], provider,
        });
        return json({ status: "queued", queued });
      }
      return json({ error: "an agent is already running for this worktree" }, 409);
    }
    const cwd = body.worktree || repo.repoPath;
    // Which Claude LOGIN runs this is hydra's decision (the `claude` on PATH is its shim); a resume
    // works on any login because hydra shares sessions between them. Orca just launches.
    const receipt = await agent.launch(body.key, cwd, body.prompt, {
      ...launchOptions(cfg, repo, provider, body.model),
      resume: body.resume, history: body.history, handoffFrom: body.handoffFrom, branch: body.branch,
      action: body.action, evidenceChars: body.evidenceChars, instruction: body.instruction,
    });
    return json(receipt);
  }
  if (req.method === "GET" && p === "/api/enrichment") {
    // What git/gh can't recover about a branch — prompt, title, provider/session pointer, follow
    // state, Slack timestamps. Lived in localStorage until it outgrew a 5MB shared bucket.
    return json(await db.enrichment(repo.name));
  }
  if (req.method === "POST" && p === "/api/enrichment") {
    if (!body.branch) return json({ error: "branch required" }, 400);
    await db.patchEnrichment(repo.name, body.branch, body.fields ?? {});
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/suggest-title") {
    if (!featuresOf(repo).aiTitles) return notEnabled(repo, "AI titles");
    // AI-name a card for the rename flow. Prefer the original task prompt; for a PR with no Orca
    // prompt (adopted / opened outside Orca — the "broken title" case), summarise its title + body.
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (!providerAllowed(repo, provider)) return notEnabled(repo, `The ${provider} agent`);
    // Name from the best signal available: the original task prompt, else a PR's title+body (adopted
    // PRs), else the branch's own commit subjects (a local card with work but no Orca prompt), and
    // finally the branch name — so a local card can always be named rather than erroring.
    let context = String(body.prompt ?? "").trim();
    if (!context && body.pr) {
      const d = await gh.prDetail(repo.repoPath, body.pr).catch(() => null);
      if (d) context = `${d.title}\n\n${d.body}`.trim();
    }
    if (!context && body.worktreePath) {
      const s = await git.changeSummary(body.worktreePath, repo.baseBranch).catch(() => null);
      if (s?.commits.length) context = s.commits.map((c) => c.subject).join("\n");
    }
    if (!context && body.branch) context = String(body.branch).replace(/[-_/]+/g, " ").trim(); // last resort
    if (!context) return json({ error: "no context to name from" }, 400);
    return json({ title: (await agent.summarize(provider, context)) ?? titleFromPrompt(context) });
  }
  if (req.method === "POST" && p === "/api/rename") {
    const title = String(body.title ?? "").trim();
    if (!body.branch || !title) return json({ error: "branch and title required" }, 400);
    if (body.pr) await gh.editTitle(repo.repoPath, body.pr, title); // PR title is the card title; make it stick on GitHub
    await db.patchEnrichment(repo.name, body.branch, { title }); // record it locally too (shown for pre-PR locals)
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/enrichment/import") {
    // One-shot adoption of a browser's pre-DB localStorage, transcripts included. Idempotent: it
    // only fills workstreams the DB doesn't already own.
    return json({ imported: await db.importEnrichment(body.entries ?? []) });
  }
  if (req.method === "GET" && p === "/api/turns") {
    // The durable conversation for a branch — written server-side at run start/exit, so it survives
    // a bridge restart, a closed tab, and follow-ups that land faster than the client polls.
    const branch = url.searchParams.get("branch");
    if (!branch) return json({ error: "branch required" }, 400);
    // Paged when the client asks for a page (`limit`, and `before` = the cursor the previous page
    // returned): the newest `limit` turns as `{ turns, older }`. Without `limit` the whole
    // conversation comes back as a plain array, as it always did — an older client keeps working.
    // The orchestrator's conversation is hundreds of turns; a chat opens on its tail and fetches
    // older pages as you scroll up.
    const pageSize = Number(url.searchParams.get("limit")) || 0;
    const page = pageSize ? await db.turnPage(repo.name, branch, { limit: pageSize, before: url.searchParams.get("before") ?? undefined }) : null;
    const turns = page ? page.turns : await db.turns(repo.name, branch);
    // Each turn carries its recorded steps (the agent's thought process) — for the NEWEST
    // `STEPS_FOR_TURNS` turns, in ONE query. Older turns come without; the chat fetches a turn's
    // steps when you unfold it (/api/turns/steps from seq 0). A 300-turn conversation used to mean
    // 300 queries and megabytes on every open, and the database may be on the other machine now.
    // An older PAGE comes with no steps at all — its turns are finished, and unfolding fetches them.
    // A paged request is the chat opening: steps ride along for the newest STEPS_FOR_PAGE turns only
    // (the running one, and the few you'd unfold without scrolling); the 40-turn attachment was
    // 450 KB of the orchestrator's 620 KB first page.
    const limit = Number(url.searchParams.get("steps")) || (page ? STEPS_FOR_PAGE : STEPS_FOR_TURNS);
    const recent = page && url.searchParams.get("before") ? [] : turns.slice(-limit);
    const bySteps = await db.stepsForRuns(recent.map((t) => t.id));
    for (const t of recent) {
      const numbered = bySteps.get(t.id) ?? [];
      if (numbered.length) {
        t.steps = numbered.map((n) => n.step as unknown as AgentStep);
        t.stepSeq = numbered[numbered.length - 1]!.seq; // where the live tail resumes from
      }
    }
    // The full prompt (instruction + scaffolding + the orchestrator's board snapshot and notes) is
    // never shown: the chat renders `instruction`, and falls back to trimming the prompt only for
    // turns recorded before the instruction was stored. For the orchestrator's 375 turns the prompts
    // were 3.6 MB of a 5.3 MB response — seconds over the tailnet, for nothing on screen.
    // Files the message carried, read off the stored prompt (an agent chat's instruction is just the
    // typed text; the references live in the prompt, which is blanked next) — the chat shows them.
    for (const t of turns) {
      const files = attachmentRefs(`${t.instruction ?? ""}\n${t.prompt}`);
      if (files.length) t.attachments = files;
    }
    for (const t of turns) if (t.instruction !== undefined) t.prompt = "";
    return json(page ? { turns, older: page.older } : turns);
  }
  if (req.method === "GET" && p === "/api/queued") {
    const branch = url.searchParams.get("branch");
    if (!branch) return json({ error: "branch required" }, 400);
    return json(await db.queuedMessages(repo.name, branch));
  }
  if (req.method === "POST" && p === "/api/queued/cancel") {
    await db.cancelQueuedMessage(Number(body.id));
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/turns/steps") {
    // Catch-up after a dropped stream: the steps recorded since the cursor the client holds. The
    // live path is the stream above; this exists so a reconnect resumes rather than refetching a
    // whole conversation, and it reads Postgres so any instance can answer it.
    const branch = url.searchParams.get("branch");
    const runId = url.searchParams.get("runId");
    if (!branch || !runId) return json({ error: "branch and runId required" }, 400);
    const since = Number(url.searchParams.get("since")) || 0;
    const fresh = await transcript.numbered(runId, { afterSeq: since });
    const turn = (await db.turns(repo.name, branch)).find((t) => t.id === runId);
    return json({
      steps: fresh.map((f) => f.step),
      seq: fresh.length ? fresh[fresh.length - 1]!.seq : since,
      // The client stops polling and refetches the conversation once the turn has its outcome.
      finished: Boolean(turn?.finishedAt),
    });
  }
  if (req.method === "POST" && p === "/api/agent/stop") {
    // Stop the run without discarding anything: the worktree, its commits, and the provider session
    // all stay, so a follow-up resumes the same conversation and redirects it. This is the "it's
    // going the wrong way" button — NOT Discard, which reaps the branch.
    if (!body.key) return json({ error: "key required" }, 400);
    const runId = agent.stop(body.key);
    if (runId) void notify.stopped(runId); // the centre hears it from here: a stopped run never reaches the run-finished hook
    return json({ ok: true, runId });
  }
  if (req.method === "GET" && (p === "/api/agent/status" || p === "/api/claude/status")) {
    const key = url.searchParams.get("key");
    if (!key) return json({ error: "key required" }, 400);
    return json(agent.status(key));
  }
  return json({ error: "not found" }, 404);
}

// The files that name the CURRENT build are never cached: the page (which names the hashed bundle),
// version.json (the open tab's "a newer build is deployed" check), the PWA manifest and sw.js (so
// the browser sees a new build's service worker on its next check). The hashed
// assets keep the browser's default caching.
const UNCACHED = new Set(["index.html", "version.json", "manifest.webmanifest", "sw.js"]);
const staticHeaders = (name: string): HeadersInit => ({
  ...(UNCACHED.has(name) ? { "Cache-Control": "no-cache" } : {}),
  ...(name.endsWith(".webmanifest") ? { "Content-Type": "application/manifest+json" } : {}),
});

async function serveStatic(url: URL): Promise<Response> {
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = Bun.file(DIST + name);
  if (await file.exists()) return new Response(file, { headers: staticHeaders(name) });
  const index = Bun.file(DIST + "index.html");
  if (await index.exists()) return new Response(index, { headers: staticHeaders("index.html") }); // SPA fallback
  return new Response("Orca bridge up. Build the UI with `bun run build`, or use `bun run dev`.");
}

// Bind to localhost ONLY by default. (The keystrokes-into-a-shell WebSocket that made this critical
// is gone, but the bridge still runs agents with repo-granted authority, so it stays off the network
// until there is a deliberate reason — and an ACL — to expose it.) ORCA_BIND lists the addresses to
// listen on, comma-separated: a deployed box binds its tailnet interface; a laptop that another
// instance must reach binds loopback (its own UI, the Vite proxy) AND its tailnet address. Never
// 0.0.0.0, or the same process is also served to whatever café wifi the machine is on.
const BIND = (process.env.ORCA_BIND || "127.0.0.1").split(",").map((h) => h.trim()).filter(Boolean);
for (const hostname of BIND) Bun.serve({
  port: API_PORT,
  hostname,
  // gh calls (esp. list with per-PR detail) can run past Bun's 10s default; give them room so a
  // slow response completes instead of timing out to a confusing empty/errored page.
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      return url.pathname.startsWith("/api/") ? await api(req, url) : await serveStatic(url);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
});

// Shutdown. Agents are deliberately left running — a restart shouldn't lose in-progress work; they're
// re-surfaced via ps (agent.detectRunning) and killed explicitly on discard (agent.killInWorktree).
//
// SIGINT and SIGTERM differ on purpose:
//  - SIGINT is you at a terminal pressing Ctrl-C. You want your ports back, so previews are killed.
//  - SIGTERM is a service manager stopping the process (a deploy, a reboot). Killing every preview on
//    every deploy would be gratuitous, and `preview.reattach()` re-adopts them on the way back up.
//
// Either way we DRAIN first: an in-flight run's history write is fire-and-forget, so exiting without
// waiting can lose the turn the database exists to keep.
let draining = false;
async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (draining) return; // a second Ctrl-C shouldn't interrupt the drain
  draining = true;
  if (signal === "SIGINT") preview.killAll();
  try {
    await Promise.race([
      agent.flushHistory(),
      new Promise((r) => setTimeout(r, DRAIN_TIMEOUT_MS)), // never hang a deploy on a wedged write
    ]);
  } catch { /* best effort — we are leaving either way */ }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void shutdown(sig); });

console.log(`orca bridge → http://localhost:${API_PORT}`);
