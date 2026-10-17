// Automatic PR upkeep: keep an orchestrated workstream's open PR mergeable without anyone pressing
// Address PR. Each minute (beside the merge queue's tick, index.ts) every open, non-draft PR of an
// orchestrated workstream whose worktree is on THIS instance is looked at, and the existing Address PR
// verb (`verbs.addressPr`, the same one `orca address` and the button use) is launched when it
// conflicts with its base, a required check failed on its head, or it has actionable review threads
// no agent has been handed yet.
//
// The decision is pure (workstream.ts `upkeepDecision`); this is its IO. The last attempt is the
// branch's enrichment (`upkeep`), written BEFORE the launch, so a restart never re-fires one: one
// automatic address per (head, reason), at most two per head, four in a row across heads, then it
// gives up and tells the user. Never while the agent runs or has messages queued, never for a
// workstream the orchestrator marked waiting on the user, never for a repo with `autoUpkeep: false`
// (or a branch with `upkeepOff`), and at most `autoUpkeepConcurrency` (2) of its runs at once here —
// each is a full agent run, and the box's memory is shared.
import * as agent from "./agent";
import * as db from "./db";
import * as primary from "./primary";
import * as gh from "./gh";
import * as git from "./git";
import * as notify from "./notify";
import type { OrcaConfig, RepoConfig } from "./config";
import { addressPr, repoHere } from "./verbs";
import {
  UPKEEP_DEFAULT_CONCURRENCY, unhandedActionable, upkeepDecision, upkeepReasonText, waitingOnUser,
  type OrchStatus, type UpkeepDecision, type UpkeepRecord,
} from "../web/src/workstream";

export const UPKEEP_POLL_MS = 60_000;
const RECORD = "upkeep";

const recordOf = (e: db.Fields | undefined): UpkeepRecord | undefined => {
  const r = e?.[RECORD] as UpkeepRecord | undefined;
  return r && typeof r === "object" && typeof r.sha === "string" ? r : undefined;
};

type Candidate = {
  repo: RepoConfig; pr: gh.PrSummary; e: db.Fields; worktreePath: string;
  activity: { running: boolean; queued: number };
};

let ticking = false;
/** One pass over every open PR of an orchestrated workstream held here. Returns each PR's decision
 *  (for the tests and the log). */
export async function tick(cfg: OrcaConfig, now = Date.now()): Promise<Array<{ repo: string; branch: string; decision: UpkeepDecision }>> {
  if (!primary.held()) return []; // a secondary or a branch preview's bridge addresses nothing
  if (ticking) return []; // a slow gh pass must not overlap the next
  ticking = true;
  try {
    const candidates: Candidate[] = [];
    for (const repo of cfg.repos.filter((r) => repoHere(r) && r.autoUpkeep !== false)) {
      const enrichment = await db.enrichment(repo.name);
      if (!Object.values(enrichment).some((e) => e?.orchestrated)) continue; // no gh call for a repo with nothing to keep
      const [prs, worktrees] = await Promise.all([gh.listPrs(repo.repoPath).catch(() => []), git.listWorktrees(repo.repoPath, repo.worktreeRoot)]);
      for (const pr of prs) {
        const e = enrichment[pr.branch];
        const wt = worktrees.find((w) => w.branch === pr.branch);
        if (!e?.orchestrated || !wt) continue; // its worktree is on another instance: that one keeps it
        const queued = (await db.queuedMessages(repo.name, pr.branch)).length;
        candidates.push({ repo, pr, e, worktreePath: wt.worktreePath, activity: { running: agent.isRunning(wt.worktreePath), queued } });
      }
    }
    const cap = cfg.autoUpkeepConcurrency ?? UPKEEP_DEFAULT_CONCURRENCY;
    // Our runs still going: the last thing done on the branch was an automatic address, and it is busy.
    let active = candidates.filter((c) => (c.activity.running || c.activity.queued > 0) && recordOf(c.e)?.reasons?.length && !recordOf(c.e)?.gaveUp).length;
    const out: Array<{ repo: string; branch: string; decision: UpkeepDecision }> = [];
    for (const c of candidates) {
      const decision = await look(cfg, c, active, cap, now).catch((err) => {
        db.logUnlessDown(`orca: upkeep ${c.repo.name}#${c.pr.number} failed`)(err);
        return { action: "skip", why: String(err) } as UpkeepDecision;
      });
      if (decision.action === "address") active++;
      out.push({ repo: c.repo.name, branch: c.pr.branch, decision });
    }
    return out;
  } finally {
    ticking = false;
  }
}

async function look(cfg: OrcaConfig, c: Candidate, active: number, cap: number, now: number): Promise<UpkeepDecision> {
  const { repo, pr, e } = c;
  const last = recordOf(e);
  const waitingOn = (e.orchStatus as OrchStatus | undefined)?.waitingOn;
  const base = {
    pr: { state: pr.state, isDraft: pr.isDraft, mergeable: pr.mergeable, ciStatus: pr.ciStatus, head: pr.head },
    orchestrated: Boolean(e.orchestrated), optedOut: e.upkeepOff === true, waitingOn,
    activity: c.activity, last, active, cap,
  };
  // The review signal is a GraphQL call per PR: only fetched once the cheap guards let the PR through.
  const guarded = pr.isDraft || base.optedOut || waitingOnUser(waitingOn) || c.activity.running || c.activity.queued > 0 || (last?.gaveUp && last.sha === pr.head);
  const unresolved = guarded ? undefined : await gh.reviewSignal(repo.repoPath, pr.number)
    .then((s) => unhandedActionable(s, (e.handedReviewThreadIds as string[] | undefined) ?? []))
    .catch(() => undefined);
  const decision = upkeepDecision({ ...base, unresolved }, now);
  const title = (typeof e.title === "string" && e.title) || pr.title;
  switch (decision.action) {
    case "skip": return decision;
    case "healthy":
      if (last) await db.patchEnrichment(repo.name, pr.branch, { [RECORD]: null }); // a clean look ends the streak
      return decision;
    case "give_up":
      await db.patchEnrichment(repo.name, pr.branch, { [RECORD]: decision.record });
      await notify.emit({
        repo: repo.name, branch: pr.branch, kind: "upkeep_gave_up", title, link: { pr: pr.number },
        key: `upkeep-gave-up:${repo.name}#${pr.number}:${pr.head}`,
        body: `Stopped auto-addressing PR #${pr.number}: ${decision.why}. Over to you.`,
      });
      return decision;
    case "address": {
      // Recorded first: a restart mid-launch must not fire it again.
      await db.patchEnrichment(repo.name, pr.branch, { [RECORD]: decision.record });
      const reasons = upkeepReasonText(decision.reasons);
      await notify.emit({
        repo: repo.name, branch: pr.branch, kind: "auto_address", title, link: { pr: pr.number },
        key: `upkeep:${repo.name}#${pr.number}:${pr.head}:${decision.reasons.join("+")}`,
        body: `Auto-addressing PR #${pr.number}: ${reasons}.`,
      });
      console.log(`[upkeep] ${repo.name}#${pr.number} (${pr.branch}): auto-addressing ${reasons}`);
      await addressPr(cfg, repo, pr.branch);
      return decision;
    }
  }
}
