import { tmpdir } from "os";
import { API_PORT, loadConfig, repoOf } from "./config";
import * as git from "./git";
import * as gh from "./gh";
import * as agent from "./agent";
import * as tmux from "./tmux";
import { terminalWs, type TerminalData } from "./terminal";
import { sessionName } from "../shared/tmux";
import * as preview from "./preview";
import { portFree, reclaimBridgePort, waitForPortFree } from "./net";
import { usage } from "./usage";
import * as ledger from "./ledger";
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

const cfg = await loadConfig();
// Take the API port from a stale bridge (a prior dev run, or another checkout's instance) before
// binding — otherwise a fresh bridge with newer routes silently loses the bind and the UI proxies
// `/api` to the old code, 404ing on anything new (this is what made "Test master" report "not found").
if (!(await portFree(API_PORT)) && reclaimBridgePort(API_PORT)) {
  console.log(`orca: reclaimed :${API_PORT} from a stale bridge`);
  await waitForPortFree(API_PORT);
}
await preview.reattach(); // re-adopt dev servers that outlived a crashed/hard-killed prior bridge
const DIST = new URL("../web/dist/", import.meta.url).pathname;

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  // Pasted/dropped images: save each to a temp dir and hand back absolute paths the agent can Read.
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
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
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
  if (req.method === "GET" && p === "/api/config") {
    const repos = await Promise.all(cfg.repos.map(async (r) => ({
      name: r.name, baseBranch: r.baseBranch, slackChannel: r.slackChannel, prLabels: r.prLabels,
      hasRemote: await git.hasRemote(r.repoPath),
    })));
    const agentProviders = AGENT_PROVIDERS.filter((provider) => Boolean(Bun.which(providerBinary(provider))));
    // apiPort lets the browser open the terminal WebSocket straight at the bridge — the Vite dev proxy
    // (Bun runtime) can't forward a WS upgrade. In the built app this equals the page's own port.
    return json({ repos, staleHours: cfg.staleHours, agentProviders, apiPort: API_PORT });
  }
  if (req.method === "POST" && p === "/api/workstreams") {
    // The selected provider summarises the prompt into a short title (falls back locally); jitter suffix
    // (à la Claude Code branch names) keeps names collision-resistant.
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    const title = (await agent.summarize(provider, body.prompt)) ?? titleFromPrompt(body.prompt);
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
    // No body from the UI → resume the implementation agent to fill the repo template (or Orca's
    // default) from its full task context and the final diff. Invalid output blocks PR creation.
    const base = await git.resolveBase(repo.repoPath, repo.baseBranch);
    const [, prBody] = await Promise.all([
      git.pushBranch(body.worktreePath, body.branch), // the branch must exist on origin for `gh pr create`
      resolvePrDescription(provider, body.worktreePath, base, {
        provided: body.body, outcome: body.outcome, sessionId: body.sessionId, task: body.task,
      }),
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
    return json(await gh.listMerged(repo.repoPath));
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
    if (body.worktreePath) await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/prs/close") {
    await gh.closePr(repo.repoPath, body.pr); // abandon without merging
    if (body.branch) await tmux.killSession(sessionName(repo.name, body.branch)); // end the interactive terminal too
    if (body.worktreePath) {
      agent.stop(body.worktreePath);
      if (body.branch) await agent.killByBranch(body.branch);
      preview.stop(body.worktreePath, true); // teardown: drop this preview's DB
      await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    }
    if (body.branch) await git.deleteBranch(repo.repoPath, body.branch);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/preview") {
    await preview.start(body.key, body.worktree, repo.previewServices, cfg.portRange);
    return json(await preview.status(body.key));
  }
  if (req.method === "POST" && p === "/api/preview/master") {
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
    if (!repo.slackChannel) return json({ error: "no Slack channel configured for this repo" }, 400);
    const r = await slackPost(repo.slackChannel, String(body.text ?? ""));
    if (!r.ok) return json({ error: `Slack post failed: ${r.error ?? "unknown error"}` }, 502);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/handoff") {
    // Write the portable-transcript seed for an interactive cross-provider handoff; Copy CLI `cat`s it.
    return json({ path: writeHandoffFile(repo.name, String(body.branch), String(body.content ?? "")) });
  }
  if (req.method === "POST" && p === "/api/terminal/ensure") {
    // Open (or re-open) the hand-driven tmux terminal for a worktree. Idempotent: an existing session
    // is left as-is and the WS just re-attaches. The launch command reuses attachCommand — the exact
    // native-resume / seeded-handoff logic Copy CLI uses — so the interactive lane and Copy CLI agree.
    if (!tmux.available()) return json({ error: "tmux is not installed on this host" }, 501);
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (!body.branch || !body.worktreePath) return json({ error: "branch and worktreePath required" }, 400);
    const name = sessionName(repo.name, body.branch);
    const command = attachCommand({ worktreePath: body.worktreePath, provider, sessionId: body.sessionId, fresh: body.fresh, seedFile: body.seedFile });
    await tmux.ensureSession(name, body.worktreePath, command);
    return json({ name });
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
    if (body.branch) await tmux.killSession(sessionName(repo.name, body.branch)); // and the interactive terminal
    preview.stop(body.worktreePath);
    await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    if (body.deleteBranch && body.branch) await git.deleteBranch(repo.repoPath, body.branch); // never for a PR branch
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/agents") {
    // source of truth for the Draft lane: live worktrees + run status + local mergeability
    countAgentPoll();
    let wts = await git.listWorktrees(repo.repoPath, repo.worktreeRoot);
    // Reap worktrees whose PR has merged (incl. manual GitHub merges) so stale locals don't linger.
    const merged = await gh.mergedBranches(repo.repoPath).catch(() => new Set<string>()); // empty for local-only repos
    for (const w of wts.filter((w) => merged.has(w.branch))) {
      agent.stop(w.worktreePath);
      await agent.killByBranch(w.branch);
      await tmux.killSession(sessionName(repo.name, w.branch));
      preview.stop(w.worktreePath, true); // merged branch reaped → drop its preview DB too
      await git.removeWorktree(repo.repoPath, w.worktreePath).catch(() => {});
      await git.deleteBranch(repo.repoPath, w.branch);
    }
    wts = wts.filter((w) => !merged.has(w.branch));
    const live = await agent.detectRunning(wts.map((w) => w.branch)); // recover status lost on restart
    // Interactive tmux sessions outlive the bridge, so discover them each poll (not from memory) —
    // this is how the board re-surfaces a live terminal after a restart. Empty when tmux is absent.
    const tmuxSessions = new Set(await tmux.listSessions());
    const base = await git.resolveBase(repo.repoPath, repo.baseBranch); // origin/<base>, not stale local
    return json(await Promise.all(wts.map(async (w) => {
      const run = agent.status(w.worktreePath);
      const agentStatus = run.status !== "idle" ? run.status : live.has(w.branch) ? "running" : "idle";
      return {
        ...w,
        tmux: tmuxSessions.has(sessionName(repo.name, w.branch)),
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
    })));
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
    if (body.worktreePath) await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/agents/run") {
    const provider = body.provider ?? "claude";
    if (!isAgentProvider(provider)) return json({ error: `unsupported agent provider: ${provider}` }, 400);
    if (agent.isRunning(body.worktreePath)) return json({ error: "an agent is already running for this worktree" }, 409);
    const receipt = agent.runAgent(body.worktreePath, body.prompt, {
      provider, resume: body.resume, history: body.history, handoffFrom: body.handoffFrom, branch: body.branch,
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
    if (agent.isRunning(body.key)) return json({ error: "an agent is already running for this worktree" }, 409);
    const receipt = agent.launch(body.key, body.worktree || repo.repoPath, body.prompt, {
      provider, resume: body.resume, history: body.history, handoffFrom: body.handoffFrom, branch: body.branch,
      action: body.action, evidenceChars: body.evidenceChars,
      timeoutMs: cfg.agentTimeoutMinutes ? cfg.agentTimeoutMinutes * 60_000 : undefined,
    });
    return json(receipt);
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

Bun.serve<TerminalData>({
  port: API_PORT,
  // The interactive terminal streams a raw shell over this WS. Bind to localhost ONLY so it (and the
  // rest of the bridge — a single-user local tool) is never exposed on the network. `send-keys` into
  // a session would otherwise be remotely reachable.
  hostname: "127.0.0.1",
  // gh calls (esp. list with per-PR detail) can run past Bun's 10s default; give them room so a
  // slow response completes instead of timing out to a confusing empty/errored page.
  idleTimeout: 60,
  async fetch(req, server) {
    const url = new URL(req.url);
    // Interactive terminal WebSocket, scoped to repo+branch. The listen socket is localhost-only, so
    // this endpoint is unreachable off the machine by construction.
    if (url.pathname === "/api/terminal/ws") {
      const repoName = url.searchParams.get("repo") ?? undefined;
      const branch = url.searchParams.get("branch");
      if (!branch) return json({ error: "branch required" }, 400);
      const name = sessionName(repoOf(cfg, repoName).name, branch);
      if (server.upgrade(req, { data: { name } })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    try {
      return url.pathname.startsWith("/api/") ? await api(req, url) : await serveStatic(url);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
  websocket: terminalWs,
});

// Preview servers hold ports, so free them on shutdown. Agents are left running so a restart
// doesn't lose in-progress work — they're re-surfaced via ps (agent.detectRunning) and killed
// explicitly on discard (agent.killByBranch).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { preview.killAll(); process.exit(0); });
}

console.log(`orca bridge → http://localhost:${API_PORT}`);
