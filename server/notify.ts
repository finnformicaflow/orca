// The ONE place a notification is emitted from. Three sources feed it — a run ending (agent.ts's
// run-finished hook), a preview coming up or not (watched here after preview.start), and an open
// PR's CI / conflict state (read off the ordinary PR list) — and every one of them goes through
// `emit`: the row is written once (db.addNotification dedupes on the event's key), then pushed on
// the bus so every tab, on either instance, hears it. Nothing here may break the run, preview or
// request that produced the event: every failure is logged and swallowed, as the ledger's are.
import * as db from "./db";
import * as bus from "./bus";
import * as preview from "./preview";
import type { RunFinished } from "./agent";
import { ORCHESTRATOR_REPO } from "../web/src/workstream";
import * as router from "./integrations/router";
import { notificationEnvelope } from "../shared/integrations";
import { checkNotification, prNotifications, previewNotification, runNotification, type Notification, type NotificationInput } from "../shared/notifications";

/** Record and push one event. Returns the row, or undefined when it had already been recorded. */
export async function emit(input: NotificationInput): Promise<Notification | undefined> {
  let n: Notification | undefined;
  try {
    n = await db.addNotification(input);
    if (n) bus.publish({ kind: "notification", notification: n });
  } catch (e) {
    db.logUnlessDown("orca: notification write failed")(e);
    return undefined;
  }
  // The same event as a durable, keyed envelope (server/integrations/, phase 0), with the same key, so
  // subscriptions decide who else hears it. Only for a NEW row: a repeat (the PR list re-answering)
  // costs no queries. Never breaks the notification.
  const envelope = n && notificationEnvelope(input, n.createdAt);
  if (envelope) await router.publish(envelope).catch((e) => console.error("orca: integration event write failed", e));
  return n;
}

/** The workstream's title, as the card shows it — the toast is headed with it. */
async function titleOf(repo: string, branch: string): Promise<string | undefined> {
  try {
    const t = (await db.enrichment(repo))[branch]?.title;
    return typeof t === "string" && t.trim() ? t.trim() : undefined;
  } catch { return undefined; }
}

/** A run ended (wired to agent.onRunFinished in index.ts, beside the orchestrator's own hook). The
 *  decisions are pure (shared/notifications.ts); this only supplies the title and writes. */
export async function onRunFinished(run: RunFinished): Promise<void> {
  const { repo, branch } = run.options;
  if (!repo || !branch || run.status === "running") return; // a repo-level run (Slack) belongs to no workstream
  const orchestrator = repo === ORCHESTRATOR_REPO;
  const title = orchestrator ? "Orchestrator" : await titleOf(repo, branch);
  const common = { repo, branch, runId: run.runId, title };
  const own = runNotification({
    ...common, status: run.status, response: run.result, outcome: run.structured, orchestrator, continued: run.continued,
    compact: run.options.action === "compact", error: run.status === "error" ? run.result : undefined,
  });
  const check = orchestrator ? undefined : checkNotification({ ...common, check: run.check });
  for (const n of [check, own]) if (n) await emit(n);
}

/** You pressed Stop on a run (the /api/agent/stop route). Not from the run-finished hook: a stopped
 *  run is superseded in agent.ts and never reaches it, and a discard (which also kills the run) is
 *  not something to be told about. */
export async function stopped(runId: string): Promise<void> {
  const owner = await db.turnOwner(runId).catch(() => undefined);
  if (!owner || owner.repo === ORCHESTRATOR_REPO) return;
  const n = runNotification({ ...owner, runId, title: await titleOf(owner.repo, owner.branch), status: "stopped" });
  if (n) await emit(n);
}

/** An open PR's CI failed or it conflicts — once per PR per set of failing checks. Called with the
 *  answer to /api/prs by the instance that answered it; keyed, so two answering is still one row. */
export async function prs(repo: string, list: Parameters<typeof prNotifications>[1]): Promise<void> {
  for (const n of prNotifications(repo, list)) await emit(n);
}

// How often a starting preview is looked at, and for how long before it is called failed. Mutable so
// a test needn't wait: the boot timeout is three minutes for a cold worktree.
export const previewWatch = { everyMs: 2_000, timeoutMs: preview.BOOT_TIMEOUT_MS + 10_000 };
const watching = new Map<string, number>(); // key → generation, so a re-spin cancels the previous watch

/** Watch a preview just started until every service answers (→ preview_ready, with the URL of the
 *  service you'd open) or one dies / the boot timeout passes (→ preview_failed). A preview stopped
 *  meanwhile is simply forgotten — you stopped it. Fire-and-forget: the start route has returned. */
export function watchPreview(p: { key: string; repo: string; branch?: string; title: string; host: string }): Promise<void> {
  const gen = (watching.get(p.key) ?? 0) + 1;
  watching.set(p.key, gen);
  const startedAt = Date.now();
  return (async () => {
    try {
      while (watching.get(p.key) === gen) {
        const svcs = await preview.status(p.key, p.host);
        if (!svcs.length) return; // stopped before it came up
        const dead = svcs.find((s) => !s.running);
        const done = dead ? { ready: false, error: `${dead.name}: ${(dead.error ?? "exited").split("\n").filter(Boolean).at(-1) ?? "exited"}` }
          : svcs.every((s) => s.ready) ? { ready: true, url: (svcs.find((s) => s.open) ?? svcs[0])?.url }
          : Date.now() - startedAt > previewWatch.timeoutMs ? { ready: false, error: "did not become ready in time" }
          : undefined;
        if (done) {
          if (watching.get(p.key) !== gen) return;
          watching.delete(p.key);
          await emit(previewNotification({ repo: p.repo, branch: p.branch, title: p.title, key: p.key, startedAt: svcs[0]?.startedAt ?? startedAt, ...done }));
          return;
        }
        await new Promise((r) => setTimeout(r, previewWatch.everyMs));
      }
    } catch (e) {
      db.logUnlessDown("orca: preview watch failed")(e);
    }
  })();
}

/** Stop watching a key (its preview was stopped). */
export const forgetPreview = (key: string): void => { watching.delete(key); };
