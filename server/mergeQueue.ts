// The merge queue: merge-when-green without anyone watching CI. A PR is MARKED (`orca merge
// --when-green`, or the PR menu) — the mark lives on its branch's enrichment (`mergeWhenGreen`), so it
// is in the shared database and survives a restart — and this polls `gh pr view` for every marked PR:
// squash-merge once every check passed and GitHub says it merges clean, never on red.
//
// The policy is the repo's config (`mergePolicy`, workstream.ts `mergeVerdict`): which PRs may be
// marked at all, and paths never merged on their own. A refusal drops the mark; red CI or a conflict
// keeps it (fixed and green, it merges) and is reported once per head commit — a notification, and a
// problem report that wakes the orchestrator when the PR is its work. A merge is a notification and a
// clean report (batched like a worker finishing).
import * as db from "./db";
import * as gh from "./gh";
import * as notify from "./notify";
import { runsHere, type OrcaConfig, type RepoConfig } from "./config";
import { repoHere } from "./verbs";
import { mergeQueueReport, mergeRefusal, mergeVerdict, type MergeMark, type MergeVerdict } from "../web/src/workstream";

/** How often marked PRs are looked at. A check run takes minutes; a minute's lag on a merge is fine. */
export const MERGE_POLL_MS = 60_000;
const MARK = "mergeWhenGreen";

// Wired in index.ts: a report for the orchestrator (forwarded to its instance when it lives elsewhere).
// A hook, not an import, because the orchestrator imports this module for its `merge` verb.
let reportHook: ((text: string) => Promise<void>) | undefined;
export function onReport(fn: ((text: string) => Promise<void>) | undefined): void { reportHook = fn; }

const markOf = (e: db.Fields | undefined): MergeMark | undefined => {
  const m = e?.[MARK] as MergeMark | undefined;
  return m && typeof m === "object" ? m : undefined;
};

/** The repos whose queue THIS instance drives: checked out here, and not assigned to another
 *  instance — so two instances sharing the database don't both merge. */
const queueRepos = (cfg: OrcaConfig): RepoConfig[] => cfg.repos.filter((r) => repoHere(r) && runsHere(r, db.instanceName()));

/** Mark a PR (or a branch whose PR doesn't exist yet) merge-when-green. Refused up front when the
 *  repo's policy would never merge it, so the caller hears why now rather than never. Then looked at
 *  once immediately — an already-green PR merges on the spot. */
export async function request(cfg: OrcaConfig, repo: RepoConfig, target: { pr?: number; branch?: string }, opts: { small?: boolean; by: "orchestrator" | "user" }): Promise<string> {
  const policy = repo.mergePolicy;
  const early = mergeRefusal(policy, opts);
  if (early) throw new Error(`Not queued: ${early}.`);
  let pr = target.pr;
  let branch = target.branch;
  if (pr) branch = (await gh.prMergeGate(repo.repoPath, pr)).branch;
  else if (branch) pr = (await gh.listPrs(repo.repoPath).catch(() => [])).find((p) => p.branch === branch)?.number;
  if (!branch) throw new Error("merge needs --pr <number> or --branch <branch>");
  const mark: MergeMark = { pr, small: opts.small || undefined, by: opts.by, at: Date.now() };
  await db.patchEnrichment(repo.name, branch, { [MARK]: mark });
  if (!pr) return `Marked ${repo.name}/${branch} merge-when-green; it has no PR yet, and is merged once one is open, green and clean.`;
  const verdict = await look(cfg, repo, branch, mark);
  switch (verdict.action) {
    case "merge": return `Merged ${repo.name} PR #${pr}: it was already green and clean.`;
    case "wait": return `Queued ${repo.name} PR #${pr} to merge when green (${verdict.why}). Orca polls it and squash-merges it; you hear back when it merges or goes red. Nothing to watch.`;
    case "red": return `Queued ${repo.name} PR #${pr}, but it is red now (${verdict.why}). It merges itself once that is fixed and green.`;
    default: return `Not queued: ${verdict.why}.`;
  }
}

/** Unmark. */
export async function cancel(repo: RepoConfig, branch: string): Promise<void> {
  await db.patchEnrichment(repo.name, branch, { [MARK]: null });
}

let ticking = false;
/** One pass over every marked PR this instance drives (the minute timer in index.ts). */
export async function tick(cfg: OrcaConfig): Promise<void> {
  if (ticking) return; // a slow gh pass must not overlap the next
  ticking = true;
  try {
    for (const repo of queueRepos(cfg)) {
      const marked = Object.entries(await db.enrichment(repo.name)).filter(([, e]) => markOf(e));
      if (!marked.length) continue;
      // A branch marked before its PR existed picks the PR up here.
      const open = marked.some(([, e]) => !markOf(e)!.pr) ? await gh.listPrs(repo.repoPath).catch(() => []) : [];
      for (const [branch, e] of marked) {
        let mark = markOf(e)!;
        if (!mark.pr) {
          const pr = open.find((p) => p.branch === branch)?.number;
          if (!pr) continue;
          mark = { ...mark, pr };
          await db.patchEnrichment(repo.name, branch, { [MARK]: mark });
        }
        await look(cfg, repo, branch, mark).catch((err) => console.error(`orca: merge queue ${repo.name}#${mark.pr} failed`, err));
      }
    }
  } finally {
    ticking = false;
  }
}

/** Look at one marked PR and act on the verdict. */
async function look(cfg: OrcaConfig, repo: RepoConfig, branch: string, mark: MergeMark): Promise<MergeVerdict> {
  const pr = mark.pr!;
  const gate = await gh.prMergeGate(repo.repoPath, pr);
  const verdict = mergeVerdict(repo.mergePolicy, mark, gate);
  const e = (await db.enrichment(repo.name))[branch] ?? {};
  const title = (typeof e.title === "string" && e.title) || gate.title;
  const theirs = mark.by === "orchestrator" || Boolean(e.orchestrated); // whose problem a red PR is
  const report = (v: MergeVerdict) => mergeQueueReport({ repo: repo.name, branch, title, pr, verdict: v, url: gate.url });
  switch (verdict.action) {
    case "wait": return verdict;
    case "gone": await cancel(repo, branch); return verdict;
    case "red": {
      if (mark.reportedSha === gate.headSha) return verdict; // already said, for this push
      await db.patchEnrichment(repo.name, branch, { [MARK]: { ...mark, reportedSha: gate.headSha } });
      // The same notification (and key) the PR list raises, so the bell shows one row, not two.
      await notify.prs(repo.name, [{ ...gate, branch, title }]);
      if (theirs) await reportHook?.(report(verdict));
      return verdict;
    }
    case "refuse": {
      await cancel(repo, branch);
      await notify.emit({ repo: repo.name, branch, kind: "merge_refused", title, link: { pr }, key: `merge-refused:${repo.name}#${pr}:${gate.headSha}`, body: `Not merged on green: ${verdict.why}.` });
      if (theirs) await reportHook?.(report(verdict));
      return verdict;
    }
    case "merge": {
      if (gate.isDraft) await gh.markReady(repo.repoPath, pr);
      await gh.mergePr(repo.repoPath, pr);
      await cancel(repo, branch);
      await notify.emit({ repo: repo.name, branch, kind: "merged", title, link: { pr }, key: `merged:${repo.name}#${pr}`, body: `Squash-merged PR #${pr} on green.` });
      if (theirs) await reportHook?.(report(verdict));
      return verdict;
    }
  }
}
