import { tmpdir } from "os";
import {
  API_PORT, configDocument, featuresOf, invalidateConfig, loadConfig, parseConfigDocument,
  providerAllowed, providersFor, repoOf, runsHere, saveConfigDocument, type RepoConfig,
} from "./config";
import * as git from "./git";
import * as gh from "./gh";
import * as agent from "./agent";
import * as preview from "./preview";
import { portFree, reclaimBridgePort, waitForPortFree } from "./net";
import { usage } from "./usage";
import * as ledger from "./ledger";
import * as db from "./db";
import * as transcript from "./transcript";
import * as lease from "./lease";
import { writeHandoffFile } from "./state";
import { metrics, countAgentPoll } from "./metrics";
import { renderText, summarize } from "./diagnostics";
import { postMessage as slackPost } from "./slack-api";
import { mergeSafe, prDescriptionPrompt, slugifyBranch, titleFromPrompt, validPrDescription } from "../web/src/workstream";
import { AGENT_PROVIDERS, attachCommand, isAgentProvider, providerBinary, type AgentOutcome } from "../shared/agent";

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
if (!(await portFree(API_PORT)) && reclaimBridgePort(API_PORT)) {
  console.log(`orca: reclaimed :${API_PORT} from a stale bridge`);
  await waitForPortFree(API_PORT);
}
await preview.reattach(); // re-adopt dev servers that outlived a crashed/hard-killed prior bridge
// Turns whose run died with a previous bridge would otherwise render "working…" forever. Leases are
// the authority on what's genuinely still running (they deliberately survive shutdown).
const orphaned = await db.reconcileRunning(lease.liveRunIds());
if (orphaned) console.log(`orca: closed ${orphaned} turn(s) left running by a previous bridge`);
const DIST = new URL("../web/dist/", import.meta.url).pathname;

const json = (data: unknown, status = 200) => Response.json(data, { status });

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

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  // Read per request, not once at startup: the configuration lives in the database now, so adding a
  // repo or changing a setting takes effect on the next call rather than the next deploy. Cached in
  // config.ts and invalidated on write, so this is a map lookup in the common case.
  const cfg = await loadConfig();
  // Pasted/dropped files (any type): save each to a temp dir, hand back absolute paths the agent Reads.
  // Handled before the JSON body parse below — this is the one multipart route.
  if (req.method === "POST" && p === "/api/attachments") {
    const dir = `${tmpdir()}/orca-attachments`;
    const paths: string[] = [];
    for (const f of (await req.formData()).getAll("files")) {
      if (typeof f === "string") continue;
      const ext = f.name.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? "";
      const file = `${dir}/${crypto.randomUUID()}${ext}`;
      await Bun.write(file, f); // Bun.write creates the parent dir
      paths.push(file);
    }
    return json({ paths });
  }
  // PUT carries a body too (the pasted config document) — parsing only POST silently handed the
  // handler an empty object, which then failed validation as "repos must be a non-empty array".
  const body: any = req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => ({})) : {};
  // Every repo-scoped call names its repo (query for GET, body for POST); defaults to the first.
  const repo = repoOf(cfg, url.searchParams.get("repo") ?? body.repo);

  if (req.method === "GET" && p === "/api/usage") {
    // Claude (OAuth usage endpoint) + Codex (local app-server) both expose read-only rate-limit
    // windows from the CLI's login. The Cursor CLI exposes no such endpoint — `about`/`status` report
    // only auth + subscription tier, no utilization — so there is deliberately no Cursor usage here.
    return json(await usage());
  }
  if (req.method === "GET" && p === "/api/diagnostics") {
    // Efficiency report over the run ledger + process metrics. `?format=text` for the terminal.
    const report = summarize(ledger.all(), metrics());
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
  if (req.method === "GET" && p === "/api/config") {
    const available = AGENT_PROVIDERS.filter((provider) => Boolean(Bun.which(providerBinary(provider))));
    const repos = await Promise.all(cfg.repos.map(async (r) => ({
      name: r.name, baseBranch: r.baseBranch, slackChannel: r.slackChannel, prLabels: r.prLabels,
      hasRemote: await git.hasRemote(r.repoPath),
      // Opt-ins travel to the client so it can hide what the bridge would refuse — the bridge still
      // enforces, because a tab open since before a change would otherwise offer the old actions.
      features: featuresOf(r),
      providers: providersFor(r, available),
    })));
    const agentProviders = available;
    // apiPort lets the browser open the terminal WebSocket straight at the bridge — the Vite dev proxy
    // (Bun runtime) can't forward a WS upgrade. In the built app this equals the page's own port.
    return json({ repos, staleHours: cfg.staleHours, agentProviders, apiPort: API_PORT });
  }
  if (req.method === "POST" && p === "/api/workstreams") {
    // The selected provider summarises the prompt into a short title (falls back locally); jitter suffix
    // (à la Claude Code branch names) keeps names collision-resistant.
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (!providerAllowed(repo, provider)) return notEnabled(repo, `The ${provider} agent`);
    const title = (featuresOf(repo).aiTitles ? await agent.summarize(provider, body.prompt) : undefined)
      ?? titleFromPrompt(body.prompt);
    const branch = `${slugifyBranch(title)}-${crypto.randomUUID().slice(0, 6)}`;
    const wt = await git.createWorktree(repo.repoPath, repo.worktreeRoot, branch, repo.baseBranch);
    await git.copyToWorktree(repo.repoPath, wt.worktreePath, repo.copyToWorktree);
    await git.linkToWorktree(repo.repoPath, wt.worktreePath, repo.linkToWorktree);
    return json({ ...wt, title });
  }
  if (req.method === "GET" && p === "/api/summary") {
    const wt = url.searchParams.get("worktree");
    if (!wt) return json({ error: "worktree required" }, 400);
    return json(await git.changeSummary(wt, await git.resolveBase(repo.repoPath, repo.baseBranch)));
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
    return json(await gh.listPrs(repo.repoPath)); // source of truth for the PR lanes
  }
  if (req.method === "GET" && p === "/api/prs/merged") {
    // `since` is the client's local midnight in ms — see gh.listMerged.
    const since = Number(url.searchParams.get("since"));
    return json(await gh.listMerged(repo.repoPath, Number.isFinite(since) && since > 0 ? since : undefined));
  }
  const reviewEvidenceMatch = p.match(/^\/api\/prs\/(\d+)\/review-evidence$/);
  if (req.method === "GET" && reviewEvidenceMatch) {
    return json(await gh.reviewEvidence(repo.repoPath, Number(reviewEvidenceMatch[1])));
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
      if (body.branch) await agent.killByBranch(body.branch);
      preview.stop(body.worktreePath, true); // teardown: drop this preview's DB
      await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    }
    if (body.branch) await git.deleteBranch(repo.repoPath, body.branch);
    if (body.branch) await db.archive(repo.name, body.branch);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/preview") {
    if (!featuresOf(repo).previews) return notEnabled(repo, "Previews");
    // Gitignored config (backend/.env) is only copied at worktree create/adopt, so a worktree made
    // before the config listed it boots without one and the preview dies on "Error: .env not found".
    // Re-copy what's missing here, leaving any worktree-local edit intact.
    await git.copyToWorktree(repo.repoPath, body.worktree, repo.copyToWorktree, { keepExisting: true });
    await preview.start(body.key, body.worktree, repo.previewServices, cfg.portRange);
    return json(await preview.status(body.key));
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
    return json({ worktreePath, svcs: await preview.status(worktreePath) });
  }
  if (req.method === "GET" && p === "/api/previews") {
    return json(await preview.list()); // all running previews across repos (not repo-scoped)
  }
  if (req.method === "GET" && p === "/api/preview") {
    const key = url.searchParams.get("key");
    return json(key ? await preview.status(key) : []);
  }
  if (req.method === "POST" && p === "/api/preview/stop") {
    preview.stop(body.key, true); // teardown: drop this preview's DB
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
    agent.stop(body.worktreePath); // kill any running agent before removing its worktree
    if (body.branch) await agent.killByBranch(body.branch); // also catch ones orphaned by a restart
    preview.stop(body.worktreePath);
    await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    if (body.deleteBranch && body.branch) await git.deleteBranch(repo.repoPath, body.branch); // never for a PR branch
    if (body.deleteBranch && body.branch) await db.archive(repo.name, body.branch);
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/agents") {
    // Source of truth for the Draft lane: live worktrees + run status + local mergeability.
    //
    // An instance only inspects the repos IT runs — it cannot stat another machine's disk — and
    // publishes what it found. The response is the union across instances, read back from Postgres,
    // so a board on either machine shows both and an instance that is asleep leaves its rows stale
    // rather than making the whole board slow or empty.
    countAgentPoll();
    const instance = db.instanceName();
    if (!runsHere(repo, instance)) return json(await foreignInventory(repo.name));
    let wts = await git.listWorktrees(repo.repoPath, repo.worktreeRoot);
    // Reap worktrees whose PR has merged (incl. manual GitHub merges) so stale locals don't linger.
    const merged = await gh.mergedBranches(repo.repoPath).catch(() => new Set<string>()); // empty for local-only repos
    for (const w of wts.filter((w) => merged.has(w.branch))) {
      agent.stop(w.worktreePath);
      await agent.killByBranch(w.branch);
      preview.stop(w.worktreePath, true); // merged branch reaped → drop its preview DB too
      await git.removeWorktree(repo.repoPath, w.worktreePath).catch(() => {});
      await git.deleteBranch(repo.repoPath, w.branch);
      await db.archive(repo.name, w.branch); // reaped from disk; its conversation is kept
    }
    wts = wts.filter((w) => !merged.has(w.branch));
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
    return json([...mine, ...(await foreignInventory(repo.name, instance))]);
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
    if (agent.isRunning(body.worktreePath)) return json({ error: "an agent is already running for this worktree" }, 409);
    const receipt = await agent.runAgent(body.worktreePath, body.prompt, {
      provider, resume: body.resume, history: body.history, handoffFrom: body.handoffFrom, repo: repo.name, branch: body.branch,
      model: repo.agentModel,
      permissionMode: repo.agentPermissionMode ?? "ask",
      action: body.action, evidenceChars: body.evidenceChars,
      timeoutMs: cfg.agentTimeoutMinutes ? cfg.agentTimeoutMinutes * 60_000 : undefined,
    });
    return json(receipt);
  }
  if (req.method === "POST" && (p === "/api/agent" || p === "/api/claude")) {
    // Generic action in a worktree (or the repo for repo-level actions). Keep /api/claude as a
    // compatibility alias for older clients; it always selects Claude unless provider is explicit.
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (!providerAllowed(repo, provider)) return notEnabled(repo, `The ${provider} agent`);
    if (agent.isRunning(body.key)) return json({ error: "an agent is already running for this worktree" }, 409);
    const receipt = await agent.launch(body.key, body.worktree || repo.repoPath, body.prompt, {
      provider, resume: body.resume, history: body.history, handoffFrom: body.handoffFrom, repo: repo.name, branch: body.branch,
      model: repo.agentModel,
      permissionMode: repo.agentPermissionMode ?? "ask",
      action: body.action, evidenceChars: body.evidenceChars,
      timeoutMs: cfg.agentTimeoutMinutes ? cfg.agentTimeoutMinutes * 60_000 : undefined,
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
    const turns = await db.turns(repo.name, branch);
    // Decorate every turn with its recorded steps (the agent's thought process), read from the run's
    // transcript — so it's there for finished turns too, and survives a bridge restart. The WHOLE
    // transcript is sent: a tail was the point of "I can't see the depth of the conversation", and
    // the steps are already bounded per field and per file when they're recorded. `?steps=N` still
    // asks for just the last N.
    const tail = Number(url.searchParams.get("steps")) || undefined;
    for (const t of turns) {
      const numbered = await transcript.numbered(t.id, { tail });
      if (numbered.length) {
        t.steps = numbered.map((n) => n.step);
        t.stepSeq = numbered[numbered.length - 1]!.seq; // where the live tail resumes from
      }
    }
    return json(turns);
  }
  if (req.method === "GET" && p === "/api/turns/steps") {
    // The chat's live tail: steps recorded since the cursor the client already holds.
    //
    // A poll, deliberately. This was Server-Sent Events pushed from an in-process bus, which is
    // genuinely faster — but only for a run executing on THIS instance. A run on another machine had
    // to be tailed from Postgres and forwarded, so there were two delivery paths and the remote one
    // was a poll wearing a stream's costume. One indexed query a second behaves identically wherever
    // the agent runs, and costs a bus, a ReadableStream, keep-alives, reconnect handling and a
    // subscriber registry less.
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
    return json({ ok: true, runId });
  }
  if (req.method === "GET" && (p === "/api/agent/status" || p === "/api/claude/status")) {
    const key = url.searchParams.get("key");
    if (!key) return json({ error: "key required" }, 400);
    return json(agent.status(key));
  }
  return json({ error: "not found" }, 404);
}

async function serveStatic(url: URL): Promise<Response> {
  const file = Bun.file(DIST + (url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
  if (await file.exists()) return new Response(file);
  const index = Bun.file(DIST + "index.html");
  if (await index.exists()) return new Response(index); // SPA fallback
  return new Response("Orca bridge up. Build the UI with `bun run build`, or use `bun run dev`.");
}

Bun.serve({
  port: API_PORT,
  // Bind to localhost ONLY. (The keystrokes-into-a-shell WebSocket that made this critical is gone,
  // but the bridge still runs agents with repo-granted authority, so it stays off the network until
  // there is a deliberate reason — and an ACL — to expose it.)
  // Loopback by default. ORCA_BIND exists for the deployed instance, which is reached over a tailnet
  // — bind the tailnet interface there, never 0.0.0.0, or the same process is also served to whatever
  // café wifi the machine is on.
  hostname: process.env.ORCA_BIND || "127.0.0.1",
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

// Preview servers hold ports, so free them on shutdown. Agents are left running so a restart
// doesn't lose in-progress work — they're re-surfaced via ps (agent.detectRunning) and killed
// explicitly on discard (agent.killByBranch).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { preview.killAll(); process.exit(0); });
}

console.log(`orca bridge → http://localhost:${API_PORT}`);
