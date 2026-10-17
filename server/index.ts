import {
  API_PORT, configDocument, featuresOf, invalidateConfig, loadConfig, setInstanceTerminal, modelFor, parseConfigDocument,
  providerAllowed, providersFor, repoOf, runsHere, saveConfigDocument, type OrcaConfig, type RepoConfig,
} from "./config";
import * as git from "./git";
import * as gh from "./gh";
import * as agent from "./agent";
import * as attachments from "./attachments";
import * as preview from "./preview";
import * as forward from "./forward";
import { reachable } from "./peer";
import { portFree, reclaimBridgePort, waitForPortFree } from "./net";
import { RENEW_POLL_MS, refreshProfile, renewStaleLogins, routingInfo, setProfileEnabled, setProfileEnabledEverywhere, usage, usageAcrossInstances } from "./usage";
import * as ledger from "./ledger";
import * as db from "./db";
import * as outbox from "./outbox";
import * as transcript from "./transcript";
import { backfillRun } from "./backfill";
import { eventStream } from "./events";
import * as lease from "./lease";
import { writeHandoffFile } from "./state";
import { metrics, countAgentPoll } from "./metrics";
import { renderText, summarize } from "./diagnostics";
import { postAsUser as slackPost } from "./integrations/adapters/slack";
import * as integrations from "./integrations/registry";
import * as dispatcher from "./integrations/dispatcher";
import * as inbox from "./integrations/inbox";
import * as integrationStore from "./integrations/store";
import * as integrationAdmin from "./integrations/admin";
import { deadNotification, webAdapter } from "./integrations/adapters/web";
import * as orchestrator from "./orchestrator";
import * as primary from "./primary";
import * as mergeQueue from "./mergeQueue";
import * as upkeep from "./upkeep";
import * as notify from "./notify";
import { health, historyHours, instanceRate, monthCost, startMetricsSampler } from "./health";
import * as verbs from "./verbs";
import * as repos from "./repos";
import { BusyError, checkGate, compact, launchOptions, newWorktree, placement, removeWorktree, startPreview } from "./verbs";
import { ORCHESTRATOR_REPO, attachmentRefs, workstreamShots, followUpPrompt, mergeSafe, prDescriptionPrompt, sweepText, titleFromPrompt, validPrDescription, withAttachments } from "../web/src/workstream";
import { AGENT_PROVIDERS, attachCommand, isAgentProvider, providerBinary, type AgentOutcome, type AgentProvider, type AgentStep, type AgentTurn } from "../shared/agent";
import { providerOfModel } from "../shared/models";
import * as prShots from "./prShots";
import * as terminal from "./terminal";
import { diskStore, parseShotRequest, shooter, type ShotRequest } from "./screenshot";
import { listServers, serverGate } from "./servers";

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
// A rejected promise nobody awaited is fatal in Bun by default. A pooled connection's connect timeout
// while the database is unreachable (ERR_POSTGRES_CONNECTION_TIMEOUT, raised on #onClose to no
// query) killed the laptop bridge twice in 2026-10, each time a tailnet blip, and `bun --watch` does
// not restart a crashed process. Log and carry on: withRetry reopens the pool on the next query.
// ponytail: a safety net under every fire-and-forget, not a cure for whichever one leaked.
process.on("unhandledRejection", (e) => console.error("orca: unhandled rejection", e instanceof Error ? e.message : e));
process.on("uncaughtException", (e) => console.error("orca: uncaught exception", e instanceof Error ? e.stack ?? e.message : e));
const PREVIEW_BRIDGE = db.previewBridge();
if (!PREVIEW_BRIDGE && !(await portFree(API_PORT)) && reclaimBridgePort(API_PORT)) {
  console.log(`orca: reclaimed :${API_PORT} from a stale bridge`);
  await waitForPortFree(API_PORT);
}
// The database is NOT awaited: the shared Postgres lives on the cloud box, and a laptop whose box is
// down must still serve the board and run agents (turns journal to the outbox until it is back —
// server/outbox.ts). `db.open()` migrates on the first successful connect, whenever that is; until
// then queries fail fast with `DbUnavailable` and db.ts retries in the background. A migration ledger
// this code can't reconcile (another branch's step under one of main's ids, not safely re-runnable)
// still refuses to start, with instructions — at boot or at the first reconnect.
const refuse = (e: Error) => { console.error(e.message); process.exit(1); };
db.onFatal(refuse);
void db.open().catch((e) => {
  if (e instanceof db.MigrationRefused) refuse(e);
  // DbUnavailable: db.ts has said so in its one "database unreachable … running degraded" line.
  else db.logUnlessDown("orca: database open failed")(e);
});
// Background duties belong to ONE bridge per instance (server/primary.ts): whoever holds the instance's
// advisory lock. Everything below that acts on this instance's runs, previews, PRs or inventory waits
// for it (`onPrimary`) or checks it per tick (`primary.held()`); a secondary serves HTTP only. A
// preview bridge or a bridge started from a worktree never takes part.
primary.elect();
// A bridge whose own code was deleted (its worktree reaped) is stale by definition: leave.
primary.watchSource(() => shutdown("SIGTERM"));
primary.onPrimary(() => preview.reattach()); // re-adopt dev servers that outlived a crashed/hard-killed prior bridge
// Turns whose run died with a previous bridge would otherwise render "working…" forever. Leases are
// the authority on what's genuinely still running (they deliberately survive shutdown). Before
// writing one off, try to recover what it actually did from the provider's own session file — the
// agent usually kept working after the bridge died, and its answer is on disk.
const reconcile = () => db.reconcileRunning(lease.liveRunIds(), async ({ runId, sessionId }) => {
  const found = await backfillRun(runId, sessionId);
  return found?.response ? { response: found.response, structured: found.outcome } : undefined;
});
// Once this bridge is primary AND the database answers (now, at a takeover, or after an outage the
// bridge booted into): close what died. ONCE — a run cut short by the database going away again runs
// again when it is back (primary.whenUp). A preview bridge acts on none of this instance's runs.
const bootReconcile = primary.whenUp(async () => {
  if (PREVIEW_BRIDGE) return;
  const { closed, recovered } = await reconcile();
  if (closed) console.log(`orca: closed ${closed} interrupted turn(s), recovered ${recovered} from the provider's session`);
  // A wake that was in flight when the previous bridge stopped: re-queue what it was handling.
  await orchestrator.recover(await loadConfig(), reconcile);
}, "orca: boot reconcile failed");

// Runs still going under a lease are adopted, not written off: when each exits, its turn is finished
// from the session file and the orchestrator hears about it, as if the bridge had never restarted.
primary.onPrimary(async () => {
  const adopted = agent.adoptLeases(async (runId, sessionId, worktreePath) => {
    const found = await backfillRun(runId, sessionId, worktreePath);
    return found?.response ? { response: found.response, structured: found.outcome } : undefined;
  }, orchestrator.dir());
  if (adopted) console.log(`orca: adopted ${adopted} run(s) still going from the previous bridge`);
  // Became primary after the database was already up (a takeover): the boot-time reconcile is ours now.
  await bootReconcile();
});
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
  const fields = (await db.enrichment(repo.name))[message.branch];
  const pinned = fields?.preferredModel;
  const mergeWhenGreen = Boolean(fields?.mergeWhenGreen);
  await agent.runAgent(message.worktreePath, withAttachments(followUpPrompt(message.instruction, { mergeWhenGreen }), message.attachments), {
    ...launchOptions(cfg, repo, provider, typeof pinned === "string" ? pinned : undefined, fields),
    branch: message.branch, action: "followup", instruction: message.instruction,
  });
});

// The orchestrator's wake loop: a worker it is responsible for going idle wakes it, and its own run
// ending drains what queued up meanwhile. Config is read per event, like every request. The
// notification centre hears the same event first (it swallows its own failures), so a toast never
// waits on a wake.
agent.onRunFinished(async (run) => {
  if (!primary.held()) return; // a secondary reports nothing — the primary's hooks are the one voice
  await notify.onRunFinished(run);
  const cfg = await loadConfig();
  await orchestrator.onRunFinished(cfg, run);
  // New screenshots on a branch whose PR is already open refresh its Screenshots section.
  void prShots.afterRun(cfg.repos.find((r) => r.name === run.options.repo), run.options.branch,
    [run.result ?? "", ...(run.structured?.verification ?? [])].join("\n"));
});
// The merge queue (server/mergeQueue.ts): every marked PR this instance drives, once a minute. A red
// or refused PR the orchestrator owns is reported to it like a worker's problem; a merge, like a finish.
mergeQueue.onReport(async (text) => orchestrator.report(await loadConfig(), text));
setInterval(() => {
  if (!primary.held()) return;
  void loadConfig().then((cfg) => mergeQueue.tick(cfg)).catch(db.logUnlessDown("orca: merge queue pass failed"));
}, mergeQueue.MERGE_POLL_MS).unref();
// Only this bridge may run the orchestrator's wakes: a bridge on code too old for the election (a
// stray preview bridge, incident 2026-10-15) that launched one is stopped with it, and the wake is
// re-run here (orchestrator.evictForeignWake). Once a minute, on the primary.
const FOREIGN_WAKE_POLL_MS = 60_000;
primary.onPrimary(() => {
  const check = () => void loadConfig().then((cfg) => orchestrator.evictForeignWake(cfg, reconcile))
    .catch(db.logUnlessDown("orca: foreign-wake check failed"));
  check();
  setInterval(() => { if (primary.held()) check(); }, FOREIGN_WAKE_POLL_MS).unref();
});
// Automatic PR upkeep (server/upkeep.ts): an orchestrated workstream's open PR that conflicts, goes
// red or gets review threads is Address-PR'd on its own, on the instance holding its worktree. Never
// from a branch preview's bridge, which launches nothing.
if (!PREVIEW_BRIDGE) setInterval(() => {
  if (!primary.held()) return;
  void loadConfig().then((cfg) => upkeep.tick(cfg)).catch(db.logUnlessDown("orca: upkeep pass failed"));
}, upkeep.UPKEEP_POLL_MS).unref();
// Warm the review queue (gh.listReviewPrs) so its slow cold fetch is paid here, not by a caller. A
// local-only repo just fails quietly.
void loadConfig().then((cfg) => cfg.repos.filter(verbs.repoHere)
  .forEach((r) => void gh.listReviewPrs(r.repoPath).catch(() => {}))).catch(() => {});

// Publish this instance's worktrees whether or not a browser is polling it: with two instances,
// the board on the OTHER machine shows this one's workstreams from the shared inventory, which
// only the owner can write. (A cloud box has no browser of its own; before this, its worktrees
// appeared only while someone's board happened to be forwarded to it.)
const INVENTORY_PUBLISH_MS = 10_000;
if (!PREVIEW_BRIDGE) setInterval(() => {
  if (!primary.held()) return;
  void loadConfig().then((cfg) => Promise.all(cfg.repos.filter(verbs.repoHere).map((r) => agentRows(r).catch(db.logUnlessDown(`orca: inventory publish failed for ${r.name}`))))).catch(() => {});
  void publishPreviews(); // the same for previews: the running-previews menu on any machine lists them
}, INVENTORY_PUBLISH_MS).unref();

/** Publish this instance's previews now (and answer the aggregate list) — on the timer, and right
 *  after a start or stop so another machine's menu needn't wait for the tick. */
// No viewer on a publish, so no loopback forwards for the others' previews.
const publishPreviews = () => loadConfig().then((cfg) => verbs.previewRows(cfg, { loopback: false }))
  .catch((e) => { db.logUnlessDown("orca: preview publish failed")(e); return []; });

// This machine's vitals into instance_metric once a minute, for the header chip's 24h graphs
// (server/health.ts). Each instance samples itself; either answers the history from Postgres.
primary.onPrimary(() => { startMetricsSampler(); });

// Stale hydra logins (an access token that lapsed — hydra never renews one, a Claude launch does):
// renewed on THIS host by one minimal launch each, so the rotation never routes to one. Every 30
// minutes on the primary; each instance renews its own logins (server/usage.ts renewStaleLogins).
if (!PREVIEW_BRIDGE) primary.onPrimary(() => {
  const renew = () => void renewStaleLogins(primary.held).catch(db.logUnlessDown("orca: stale-login renew failed"));
  renew();
  setInterval(renew, RENEW_POLL_MS).unref();
});

// Orphaned preview databases (a bridge crash / reaped worktree / worker test run that never dropped
// its own) and stale test-harness Docker containers — on this instance's repos only. At startup
// (whatever accumulated since the last run), then hourly; a run's own failures are logged, never
// thrown (see preview.reap).
const REAP_INTERVAL_MS = 60 * 60 * 1000;
function runReaper(): void {
  if (!primary.held()) return;
  void loadConfig().then((cfg) => preview.reap(cfg.repos.filter(verbs.repoHere)))
    .catch(db.logUnlessDown("orca: preview/container reap failed"));
}
primary.onPrimary(() => {
  runReaper();
  setInterval(runReaper, REAP_INTERVAL_MS).unref();
});

// The integrations layer (server/integrations/). On the primary only, with the database up: start
// the adapters this instance runs (integration.instance), then the delivery dispatcher. The
// orchestrator's deliveries are served only where it lives (orchestratorOn). Re-synced every minute,
// so an integration row added, moved or disabled takes effect without a restart.
const web = webAdapter(notify.emit);
dispatcher.configure({
  adapter: integrations.adapterFor,
  web: web.deliver,
  orchestrator: async (e) => inbox.toOrchestrator(await loadConfig(), e),
  workstream: async (repo, branch, e) => inbox.toWorkstream(await loadConfig(), repo, branch, e),
  serves: (kind) => kind !== "orchestrator" || !lastOrchestratorOn || lastOrchestratorOn === db.instanceName(),
  dead: async (d, error) => { await notify.emit(deadNotification(d, error)); },
});
dispatcher.setRunning(integrations.runningIds);
let lastOrchestratorOn: string | undefined;
const INTEGRATIONS_SYNC_MS = 60_000;
const syncIntegrations = async () => {
  if (!primary.held()) return;
  lastOrchestratorOn = (await loadConfig()).orchestratorOn;
  await integrations.sync();
};
primary.whenUp(async () => {
  await syncIntegrations();
  dispatcher.start();
  setInterval(() => void syncIntegrations().catch(db.logUnlessDown("orca: integrations sync failed")), INTEGRATIONS_SYNC_MS).unref();
  setInterval(() => void integrationStore.pruneEvents().catch(db.logUnlessDown("orca: event prune failed")), REAP_INTERVAL_MS).unref();
}, "orca: integrations start failed");

// How many of a conversation's newest turns are sent with their steps attached (older ones load on unfold).
const STEPS_FOR_TURNS = 40;
const STEPS_FOR_PAGE = 10;

// How long shutdown waits for outstanding history writes before leaving anyway.
const DRAIN_TIMEOUT_MS = 5_000;

const DIST = new URL("../web/dist/", import.meta.url).pathname;

const json = (data: unknown, status = 200) => Response.json(data, { status });
/** A principal id from a display name: "Saajan P." → "saajan-p". */
const principalSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "person";

/** A read answered without the database: the marker rides in a header (an array body has nowhere
 *  else to put it), and an object body also gets `dbUnavailable: true`. */
const degradedJson = (data: unknown, status = 200) => Response.json(
  data && typeof data === "object" && !Array.isArray(data) ? { ...data, dbUnavailable: true } : data,
  { status, headers: { "x-orca-database": db.databaseStatus() } },
);

// Reads whose honest answer, with the database unreachable, is "nothing" — everything else that
// needed it is a 503 (an empty answer to a write, or to the orchestrator's status, would mislead).
const EMPTY_WHEN_DOWN: Record<string, () => unknown> = {
  "/api/queued": () => [],
  "/api/notifications": () => [],
  "/api/health/history": () => [],
  "/api/config/document": () => ({}),
};

/** What a request that hit `DbUnavailable` gets instead of a 500. */
function whenDatabaseDown(req: Request, url: URL, e: db.DbUnavailable): Response {
  const empty = req.method === "GET" ? EMPTY_WHEN_DOWN[url.pathname] : undefined;
  if (empty) return degradedJson(empty());
  return degradedJson({ error: `${e.message} — this needs the database; it will work again once it is back` }, 503);
}

const BRIDGE_BRANCH = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim() || undefined;
const bridgeInfo = () => ({ preview: PREVIEW_BRIDGE, branch: BRIDGE_BRANCH, port: API_PORT, ...primary.state() });

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
    db.logUnlessDown("orca: inventory read failed")(e);
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
  "/api/turns", "/api/turns/local", "/api/enrichment", "/api/enrichment/import", "/api/config", "/api/config/document",
  // /api/usage merges every reachable instance's reading (usageAcrossInstances); /api/usage/local is
  // what that merge fetches from a PEER — always this host's own, unmerged, never forwarded (a repo's
  // placement must not send it chasing a worktree that has nothing to do with hydra).
  "/api/usage", "/api/usage/local", "/api/diagnostics", "/api/turns/steps", "/api/queued", "/api/queued/cancel", "/api/health",
  "/api/health/history", "/api/config/instance-rate", "/api/config/terminal",
  // A workstream's reported screenshots, read off its turns (the files are served per shot).
  "/api/shots",
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
  // An offline peer black-holes the connect; without this a forward hung for over a minute.
  if (!(await reachable(base))) return json({ error: `${home} is unreachable (no connection to ${new URL(base).host})` }, 502);
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
  // Reaping and publishing are the primary's: a secondary (a stray bridge on stale code) only looks.
  const duties = primary.held() && !PREVIEW_BRIDGE;
  const reapedBranches = new Set((duties ? await verbs.cleanupRepo(repo) : []).filter((c) => c.action === "reaped").map((c) => c.branch));
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
  if (duties) await db.publishInventory(repo.name, mine.map((w) => ({ branch: w.branch, data: w as unknown as db.Fields })))
    .catch(db.logUnlessDown("orca: inventory publish failed")); // advisory — never fail a poll
  return [...mine, ...(await foreignInventory(repo.name, instance))];
}

// The remote address of each request, for the routes that must know who asks (the terminal's).
const remoteAddr = new WeakMap<Request, string | undefined>();
/** The web terminal's owner gate for a plain request: a known Orca page and the owner (server/terminal.ts). */
async function terminalOwner(req: Request, cfg: OrcaConfig): Promise<Response | undefined> {
  if (!terminal.originAllowed(req.headers.get("origin"), req.headers.get("host"), await terminal.trustedOrigins(cfg))) return json({ error: "cross-origin request refused" }, 403);
  const id = await terminal.identify(terminal.callerAddress(remoteAddr.get(req), req.headers), undefined, undefined, cfg.serverSwitcher?.allowedLogins ?? []);
  return id.ok ? undefined : json({ error: `refused: ${id.reason}` }, 403);
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
  // An integration's HTTP door (a signed webhook, a relay's push): the RAW body, for its signature, so
  // before the JSON parse. Answered by the instance that runs the integration, never forwarded.
  const inbound = req.method === "POST" && p.match(/^\/api\/integrations\/([A-Za-z0-9_.-]+)\/inbound$/);
  if (inbound) return integrations.handle(inbound[1]!, req, await req.text());
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
  // The server switcher (server/servers.ts): the Orca servers a browser may switch to. Answered here,
  // never forwarded — each server names itself and its own discovery.
  if (req.method === "GET" && p === "/api/servers") return json(await listServers(cfg.serverSwitcher));
  // The server's off switch for the switcher (on unless false): sets `serverSwitcher.enabled` and keeps
  // the rest of the document. No web control calls it; the browser has no switch of its own.
  if (req.method === "POST" && p === "/api/config/server-switcher") {
    if (typeof body.enabled !== "boolean") return json({ error: "enabled must be true or false" }, 400);
    const doc = await configDocument();
    const prev = doc.serverSwitcher && typeof doc.serverSwitcher === "object" ? doc.serverSwitcher as Record<string, unknown> : {};
    const { config, errors } = parseConfigDocument({ ...doc, serverSwitcher: { ...prev, enabled: body.enabled } });
    if (!config) return json({ errors }, 400);
    await saveConfigDocument(config);
    return json({ ok: true, enabled: body.enabled });
  }
  // Screenshots (server/screenshot.ts): the one capped browser on this box, behind one queue. Never
  // forwarded — a worker shoots a preview on its own instance. The response is streamed as one JSON
  // object per line — `{queued: N}` while N jobs are still ahead, then the result — so the CLI can
  // print progress instead of sitting silent past its Bash caller's own patience; `req.signal` lets
  // a CLI that gave up waiting pull its job back out of the queue before a browser ever launches it.
  if (req.method === "POST" && p === "/api/screenshot") {
    let shot: ShotRequest;
    try { shot = parseShotRequest(body); } catch (e) { return json({ error: (e as Error).message }, 400); }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const write = (obj: unknown) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`)); } catch { /* client gone */ } };
        try {
          write(await shooter().shoot(shot, { signal: req.signal, onQueue: (ahead) => write({ queued: ahead }) }));
        } catch (e) {
          write({ error: (e as Error).message });
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  }
  const shotId = p.match(/^\/api\/screenshots\/(shot-[\w-]+)$/)?.[1];
  if (req.method === "GET" && shotId) {
    const file = diskStore().path(shotId);
    if (file) return new Response(Bun.file(file), { headers: { "content-type": "image/png" } });
    // A shot is a file on the instance that took it; a page served by another one asks its peers
    // (`?local` so a peer never asks back).
    if (!url.searchParams.has("local")) {
      for (const [name, base] of Object.entries(cfg.instances ?? {})) {
        if (name === db.instanceName() || !(await reachable(base))) continue;
        const r = await fetch(new URL(`/api/screenshots/${shotId}?local`, base)).catch(() => undefined);
        if (r?.ok) return new Response(r.body, { headers: { "content-type": "image/png" } });
      }
    }
    return json({ error: "not found" }, 404);
  }
  if (p.startsWith("/api/orchestrator") && cfg.orchestratorOn && cfg.orchestratorOn !== db.instanceName()) {
    // ONE instance hosts the orchestrator (orchestratorOn); everything about it goes there.
    const base = cfg.instances?.[cfg.orchestratorOn];
    if (!base) return json({ error: `the orchestrator lives on "${cfg.orchestratorOn}", which has no address configured (set instances.${cfg.orchestratorOn})` }, 502);
    if (!(await reachable(base))) return json({ error: `${cfg.orchestratorOn} is unreachable (no connection to ${new URL(base).host})` }, 502);
    try {
      const upstream = await fetch(new URL(url.pathname + url.search, base), { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : JSON.stringify(body), signal: req.signal });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } catch (e) {
      return json({ error: `${cfg.orchestratorOn} is unreachable: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  }
  // A secondary bridge (server/primary.ts) never wakes the orchestrator: what would launch a wake is
  // refused, so a stray bridge on stale code can't run one with its own PATH and port.
  if (!primary.held() && req.method === "POST" && (p === "/api/orchestrator/event" || p === "/api/orchestrator/message" || (p === "/api/compact" && body.repo === ORCHESTRATOR_REPO))) {
    return json({ error: `this is a secondary bridge (${primary.state().reason}); the orchestrator is driven by the instance's primary bridge` }, 503);
  }
  if (req.method === "GET" && p === "/api/integrations") {
    // Settings > Integrations in one read (server/integrations/admin.ts): the kinds the registry
    // knows, every integration with its health and last event, links, people, pending pairing codes,
    // subscriptions and the dead deliveries. `running` keeps the diagnostics' map of this bridge.
    return json({ ...(await integrationAdmin.overview()), running: await integrations.health() });
  }
  if (req.method === "POST" && p === "/api/integrations/test") {
    // The card's Test: the adapter's own health check, on the instance that runs it.
    const row = await integrationStore.integration(String(body.id ?? ""));
    if (!row) return json({ error: `no integration ${String(body.id ?? "")}` }, 404);
    if (row.instance !== db.instanceName()) {
      try { return json(await orchestrator.viaInstance(cfg, row.instance, "/api/integrations/test", { id: row.id })); }
      catch (e) { return json({ ok: false, detail: e instanceof Error ? e.message : String(e) }); }
    }
    return json(await integrationAdmin.testIntegration(row.id));
  }
  if (req.method === "POST" && p.startsWith("/api/integrations/")) {
    try {
      const out = await integrationAdmin.route(p, body);
      if (out !== undefined) return json(out);
    } catch (e) {
      if (e instanceof integrationAdmin.AdminError) return json({ error: e.message }, 400);
      throw e;
    }
  }
  // Pairing (server/integrations/router.ts): an unknown sender got a code; you approve it here, which
  // binds their platform identity to a principal (new, or an existing id). The Settings page calls
  // the same routes later. Body: { code, principal?, name?, maxLevel? ("notify" | "ask" | "work") }.
  if (req.method === "GET" && p === "/api/integrations/pairing") return json({ pairings: await integrationStore.pendingPairings() });
  if (req.method === "POST" && p === "/api/integrations/pairing/approve") {
    const level = body.maxLevel;
    if (level !== undefined && !["notify", "ask", "work"].includes(level)) return json({ error: 'maxLevel must be "notify", "ask" or "work"' }, 400);
    const code = String(body.code ?? "").trim().toUpperCase();
    if (!code) return json({ error: "code required" }, 400);
    const pending = (await integrationStore.pendingPairings()).find((x) => x.code === code);
    const id = typeof body.principal === "string" && body.principal.trim() ? body.principal.trim()
      : principalSlug(String(body.name ?? pending?.name ?? pending?.externalId ?? code));
    try {
      const pairing = await integrationStore.approvePairing(code, { id, ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}), ...(level ? { maxLevel: level } : {}) });
      return json({ pairing });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  if (req.method === "POST" && p === "/api/integrations/pairing/deny") {
    return (await integrationStore.denyPairing(String(body.code ?? ""))) ? json({ ok: true }) : json({ error: "no pending pairing code with that value" }, 404);
  }
  if (req.method === "POST" && p === "/api/orchestrator/event") {
    // A worker report from another instance (its run-finished hook), delivered to the orchestrator here.
    // Kept as an alias: scripts now post to a webhook integration (/api/integrations/<id>/inbound),
    // which is signed and goes through the permission gate.
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
  // The GitHub page: this host's signed-in `gh` accounts (per host, like /api/usage) and the commit
  // identity each carries; a save writes the shared config.
  if (req.method === "GET" && p === "/api/github/accounts") return json({ accounts: await repos.accountsHere(cfg) });
  if (req.method === "POST" && p === "/api/github/accounts") {
    await repos.setAccount(cfg, String(body.login ?? ""), { name: body.name as string | undefined, email: body.email as string | undefined });
    return json({ accounts: await repos.accountsHere(await loadConfig()) });
  }
  if (req.method === "POST" && p === "/api/repos/add") {
    // `orca repo add --on <this instance>`: clone here, append to the shared config.
    return json(await repos.add(cfg, String(body.nameWithOwner ?? ""), { name: typeof body.name === "string" ? body.name : undefined }));
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
  // only the database-backed chat routes (turns, stream, queued) are ever asked for it, PLUS any
  // route (like /api/compact) that launches a run against its session: that one must land on
  // cfg.orchestratorOn, same as the dedicated /api/orchestrator block above — so the synthetic repo
  // carries `runsOn` as its home, the same fallback forwardToOwner already uses for a real repo's
  // default placement.
  const repoName = url.searchParams.get("repo") ?? body.repo;
  const repo = repoName === ORCHESTRATOR_REPO
    ? { name: ORCHESTRATOR_REPO, repoPath: orchestrator.dir(), worktreeRoot: orchestrator.dir(), baseBranch: "", previewServices: [], runsOn: cfg.orchestratorOn }
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
    // this machine's (config → IMDS estimate → 0); `month` is that rate over this month's uptime
    // ledger, from its configured billing start, for the card's Cost cell (absent when the query
    // fails — vitals must still answer).
    const cfg = await loadConfig();
    const [h, rate] = await Promise.all([health(), instanceRate(cfg.instanceHourlyUsd)]);
    const since = Date.parse(cfg.instanceBillingSince?.[db.instanceName()] ?? "");
    const month = rate.hourlyUsd > 0 ? await monthCost(rate.hourlyUsd, Number.isFinite(since) ? { billingSince: since } : {}).catch(() => undefined) : undefined;
    return json({ ...h, rate, month, database: db.databaseStatus(), outbox: outbox.summary() });
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
  if (req.method === "GET" && p === "/api/usage/local") {
    // What usageAcrossInstances fetches from a PEER: this host's own reading, unmerged.
    return json(await usage());
  }
  if (req.method === "GET" && p === "/api/usage") {
    // Claude (OAuth usage endpoint) + Codex (local app-server) both expose read-only rate-limit
    // windows from the CLI's login. The Cursor CLI exposes no such endpoint — `about`/`status` report
    // only auth + subscription tier, no utilization — so there is deliberately no Cursor usage here.
    // Usage belongs to the Claude ACCOUNT, not the machine answering — merged across every reachable
    // instance (usageAcrossInstances), the freshest OK reading per login winning over whichever host
    // the browser happens to be pointed at.
    return json(await usageAcrossInstances(cfg.instances, db.instanceName(), cfg.orchestratorOn));
  }
  if (req.method === "POST" && p === "/api/usage/profile") {
    // Hydra state is PER HOST — not in DATABASE_ONLY, so an explicit ?instance= (or body.instance)
    // forwards to that machine via the ordinary placement path above and applies there only.
    // Omitted (the card's switch), it is one decision for the account: applied on every host that
    // has the login (setProfileEnabledEverywhere).
    const name = String(body.name ?? "");
    if (!name) return json({ error: "name required" }, 400);
    const explicit = Boolean(body.instance ?? url.searchParams.get("instance"));
    try {
      return json({ profiles: explicit ? await setProfileEnabled(name, Boolean(body.enabled)) : await setProfileEnabledEverywhere(name, Boolean(body.enabled), cfg.instances, db.instanceName(), cfg.orchestratorOn) });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  if (req.method === "POST" && p === "/api/usage/refresh") {
    // Same per-host placement as /api/usage/profile above — forced when an explicit ?instance=
    // names another machine, answered here otherwise. Fixes a "token stale" row without SSH: re-reads
    // usage and, if the token lapsed, renews it with one minimal launch (server/usage.ts).
    const name = String(body.name ?? "");
    if (!name) return json({ error: "name required" }, 400);
    try {
      return json({ profiles: await refreshProfile(name, { host: db.instanceName() }) });
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
    // The web terminal's flag is NOT part of a pasted document: only Settings' own route sets it.
    await saveConfigDocument({ ...config, ...(cfg.terminal ? { terminal: cfg.terminal } : {}) });
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
  if (req.method === "POST" && p === "/api/config/terminal") {
    // Settings' Terminal row: one instance's web terminal on or off. It hands out a shell, so it is
    // gated like the terminal itself — the owner only, never a cross-origin page.
    const gate = await terminalOwner(req, cfg);
    if (gate) return gate;
    const instance = typeof body.instance === "string" ? body.instance.trim() : "";
    if (!instance || typeof body.on !== "boolean") return json({ error: "instance and on (true or false) are required" }, 400);
    await setInstanceTerminal(instance, body.on);
    console.log(`orca: terminal ${body.on ? "enabled" : "disabled"} instance=${instance} at=${new Date().toISOString()}`);
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/config") {
    const available = AGENT_PROVIDERS.filter((provider) => Boolean(Bun.which(providerBinary(provider))));
    const repos = await Promise.all(cfg.repos.map(async (r) => ({
      name: r.name, baseBranch: r.baseBranch, slackChannel: r.slackChannel, prLabels: r.prLabels,
      previewLabel: r.previewLabel,
      mergePolicy: r.mergePolicy, // so the actions bar can show Merge when green disabled with the queue's own refusal
      hasRemote: await git.hasRemote(r.repoPath),
      owner: (await git.remoteNameWithOwner(r.repoPath).catch(() => "")).split("/")[0] || undefined, // the switcher prefixes it when repos span accounts
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
      terminal: cfg.terminal ?? {},
      // Each machine's address: the terminal panel connects to a machine's own bridge directly (a
      // bridge never relays another machine's shell). Tailnet addresses, no secret.
      instanceUrls: cfg.instances ?? {},
      // `ok`, or `unreachable since <iso>`: the bridge serves (and runs agents) without the database,
      // from the last good config, journaling history until it is back.
      database: db.databaseStatus(),
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
  if (req.method === "POST" && p === "/api/workstreams/stop") {
    // `orca stop` for a workstream living here. Placement forwards it to the instance holding the
    // worktree, which is the only one that can find and stop the running process.
    const r = await verbs.stopWorkstream(repo, String(body.branch), { dropQueue: Boolean(body.dropQueue) });
    return json({ ...r, instance: db.instanceName() });
  }
  if (req.method === "POST" && p === "/api/workstreams/spawn") {
    const ws = await verbs.createWorkstream(cfg, repo, { prompt: String(body.prompt ?? ""), title: body.title, model: body.model, fields: { orchestrated: true, ...(body.grantScope ? { grantScope: body.grantScope } : {}) } });
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
  if (req.method === "GET" && p === "/api/shots") {
    return json(workstreamShots(await db.turns(repo.name, url.searchParams.get("branch") ?? "")));
  }
  // `orca pr-shots`: the workstream's newest reported screenshots into its open PR's description.
  // Run where the worktree lives — the shots are files on that instance's disk.
  if (req.method === "POST" && p === "/api/prs/shots") {
    return json(await prShots.attachPrShots(repo, String(body.branch), { pr: body.pr ? Number(body.pr) : undefined }));
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
    void prShots.attachPrShots(repo, body.branch, { pr: pr.number }).catch((e) => console.warn(`orca: PR #${pr.number} screenshots: ${(e as Error).message}`));
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
    const merged = await gh.listMerged(repo.repoPath, Number.isFinite(since) && since > 0 ? since : undefined);
    // The browser has no git, so `headBehindPr` (mergedPrIsHistory's reuse-vs-behind fact) is
    // computed here, where the repo is actually checked out, and shipped down on each row.
    const heads = new Map((await git.listWorktrees(repo.repoPath, repo.worktreeRoot)).map((w) => [w.branch, w.head]));
    return json(await Promise.all(merged.map(async (m) => {
      const head = heads.get(m.branch);
      if (!head || !m.headSha || head === m.headSha) return m;
      return { ...m, headBehindPr: await git.isAncestor(repo.repoPath, head, m.headSha, m.branch) };
    })));
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
      ...launchOptions(cfg, repo, provider, body.model, body.branch ? (await db.enrichment(repo.name))[body.branch] : undefined),
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
      ...launchOptions(cfg, repo, provider, body.model, body.branch ? (await db.enrichment(repo.name))[body.branch] : undefined),
      resume: body.resume, history: body.history, handoffFrom: body.handoffFrom, branch: body.branch,
      action: body.action, evidenceChars: body.evidenceChars, instruction: body.instruction,
    });
    return json(receipt);
  }
  if (req.method === "GET" && p === "/api/enrichment") {
    // What git/gh can't recover about a branch — prompt, title, provider/session pointer, follow
    // state, Slack timestamps. Lived in localStorage until it outgrew a 5MB shared bucket.
    // With the database down: the last copy it gave, with the queued patches over it.
    const { data, degraded } = await outbox.enrichment(repo.name);
    return degraded ? degradedJson(data) : json(data);
  }
  if (req.method === "POST" && p === "/api/enrichment") {
    if (!body.branch) return json({ error: "branch required" }, 400);
    const { queued } = await outbox.patchEnrichment(repo.name, body.branch, body.fields ?? {}); // queued while the database is down
    return json({ ok: true, ...(queued ? { queued: true, dbUnavailable: true } : {}) });
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
    await outbox.patchEnrichment(repo.name, body.branch, { title }); // record it locally too (shown for pre-PR locals)
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
    const before = url.searchParams.get("before") ?? undefined;
    // With the database unreachable the conversation is what this machine journaled (server/outbox.ts)
    // — the live run included — flagged `dbUnavailable` so the chat says it will sync later.
    let page: db.TurnPage | null = null, turns: AgentTurn[], degraded = false;
    try {
      page = pageSize ? await db.turnPage(repo.name, branch, { limit: pageSize, before }) : null;
      turns = page ? page.turns : await db.turns(repo.name, branch);
    } catch (e) {
      if (!(e instanceof db.DbUnavailable)) throw e;
      degraded = true;
      page = pageSize ? { turns: [], older: null } : null;
      turns = [];
    }
    // Journaled turns the replay hasn't landed yet belong at the newest end.
    if (!before) turns = outbox.mergeTurns(turns, repo.name, branch);
    if (page) page.turns = turns;
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
    const bySteps = degraded ? new Map<string, { seq: number; step: db.Fields }[]>() : await db.stepsForRuns(recent.map((t) => t.id));
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
    const body = page ? { turns, older: page.older } : turns;
    return degraded ? degradedJson(body) : json(body);
  }
  if (req.method === "GET" && p === "/api/turns/local") {
    // THIS machine's journaled turns for a branch (server/outbox.ts): what ran while the database
    // was unreachable and hasn't been replayed into it yet. Never forwarded — it is this disk.
    const branch = url.searchParams.get("branch");
    if (!branch) return json({ error: "branch required" }, 400);
    return json({ turns: outbox.turns(repo.name, branch), database: db.databaseStatus() });
  }
  if (req.method === "GET" && p === "/api/queued") {
    const branch = url.searchParams.get("branch");
    if (!branch) return json({ error: "branch required" }, 400);
    const queued = await db.queuedMessages(repo.name, branch);
    // A message queued from the orchestrator's `orca send --attach` carries its attachment refs
    // embedded in the instruction text (withAttachments), not the structured field a browser-originated
    // send fills in separately — union both, like /api/turns does for a turn's prompt.
    for (const m of queued) {
      const embedded = attachments.refsIn(m.instruction);
      if (embedded.length) m.attachments = [...new Set([...m.attachments, ...embedded])];
    }
    return json(queued);
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
    const turn = outbox.mergeTurns(await db.turns(repo.name, branch).catch((e) => {
      if (e instanceof db.DbUnavailable) return [];
      throw e;
    }), repo.name, branch).find((t) => t.id === runId);
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
    // Stop then sends the next queued message at once, as a finished run does.
    const runId = body.key === orchestrator.dir() ? await orchestrator.stop(await loadConfig()) : await agent.interrupt(body.key);
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
for (const hostname of BIND) Bun.serve<terminal.TerminalData>({
  port: API_PORT,
  hostname,
  // gh calls (esp. list with per-PR detail) can run past Bun's 10s default; give them room so a
  // slow response completes instead of timing out to a confusing empty/errored page.
  idleTimeout: 60,
  // The web terminal's socket (server/terminal.ts) — the only WebSocket the bridge serves.
  websocket: terminal.websocket,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      try { return await serveStatic(url); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
    }
    // The terminal runs its own gate (owner + same Origin) and is never a cross-server call.
    if (url.pathname === terminal.PATH) {
      try { return await terminal.upgrade(req, server, { config: loadConfig, here: db.instanceName() }); }
      catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
    }
    remoteAddr.set(req, server.requestIP(req)?.address);
    const handle = async (): Promise<Response> => {
      try {
        const res = await api(req, url);
        // Every API answer says when it was given without the database, so any caller can tell.
        if (db.unavailableSince() !== null) { try { res.headers.set("x-orca-database", db.databaseStatus()); } catch { /* immutable */ } }
        return res;
      } catch (e) {
        if (e instanceof db.DbUnavailable) return whenDatabaseDown(req, url, e);
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    };
    // A cross-origin call from another Orca server's page (servers.ts `trustedOrigin`) gets CORS and
    // a Tailscale whois check (errors included, so its page can read them); anything else —
    // same-origin, no Origin, the switcher off — passes through unchanged.
    if (!req.headers.get("origin")) return handle();
    const switcher = await loadConfig().then((c) => c.serverSwitcher).catch(() => undefined);
    return serverGate(req, server.requestIP(req)?.address, switcher, handle)
      .catch((e) => json({ error: e instanceof Error ? e.message : String(e) }, 500));
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
  void primary.release(); // the next bridge takes the duties now, not at its next retry
  void dispatcher.stop();
  void integrations.stopAll(); // close sockets so the next primary can open them
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
