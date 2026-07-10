import { tmpdir } from "os";
import { API_PORT, loadConfig, repoOf } from "./config";
import * as git from "./git";
import * as gh from "./gh";
import * as agent from "./agent";
import * as preview from "./preview";
import { portFree, reclaimBridgePort, waitForPortFree } from "./net";
import { usage } from "./usage";
import { mergeSafe, slugifyBranch, titleFromPrompt } from "../web/src/workstream";

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
    return json(await usage()); // Claude subscription limits (5h + weekly); not repo-scoped
  }
  if (req.method === "GET" && p === "/api/config") {
    const repos = await Promise.all(cfg.repos.map(async (r) => ({
      name: r.name, baseBranch: r.baseBranch, slackChannel: r.slackChannel,
      hasRemote: await git.hasRemote(r.repoPath),
    })));
    return json({ repos, staleHours: cfg.staleHours });
  }
  if (req.method === "POST" && p === "/api/workstreams") {
    // Haiku summarises the prompt into a short title (falls back to the first line); jitter suffix
    // (à la Claude Code branch names) keeps names collision-resistant.
    const title = (await agent.summarize(body.prompt)) ?? titleFromPrompt(body.prompt);
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
    await git.pushBranch(body.worktreePath, body.branch); // the branch must exist on origin for `gh pr create`
    // No body from the UI → fill it from the repo's PR template (its guidelines) or a commit summary,
    // so the PR never opens blank.
    const prBody = await git.resolvePrBody(body.worktreePath, await git.resolveBase(repo.repoPath, repo.baseBranch), body.body);
    const pr = await gh.createPr(body.worktreePath, {
      title: body.title, body: prBody, base: repo.baseBranch, head: body.branch, draft: body.draft,
    });
    if (body.addPreviewLabel) await gh.addLabel(repo.repoPath, pr.number, repo.previewLabel ?? "preview").catch(() => {});
    return json(pr);
  }
  if (req.method === "GET" && p === "/api/prs") {
    return json(await gh.listPrs(repo.repoPath)); // source of truth for the PR lanes
  }
  if (req.method === "GET" && p === "/api/prs/merged") {
    return json(await gh.listMerged(repo.repoPath));
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
    if (body.worktreePath) {
      agent.stop(body.worktreePath);
      if (body.branch) await agent.killByBranch(body.branch);
      preview.stop(body.worktreePath);
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
    preview.stop(body.key);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/worktrees/adopt") {
    const wt = await git.adoptWorktree(repo.repoPath, repo.worktreeRoot, body.branch);
    await git.copyToWorktree(repo.repoPath, wt.worktreePath, repo.copyToWorktree);
    await git.linkToWorktree(repo.repoPath, wt.worktreePath, repo.linkToWorktree);
    return json(wt);
  }
  if (req.method === "POST" && p === "/api/worktrees/remove") {
    agent.stop(body.worktreePath); // kill any running agent before removing its worktree
    if (body.branch) await agent.killByBranch(body.branch); // also catch ones orphaned by a restart
    preview.stop(body.worktreePath);
    await git.removeWorktree(repo.repoPath, body.worktreePath).catch(() => {});
    if (body.deleteBranch && body.branch) await git.deleteBranch(repo.repoPath, body.branch); // never for a PR branch
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/agents") {
    // source of truth for the Draft lane: live worktrees + run status + local mergeability
    let wts = await git.listWorktrees(repo.repoPath, repo.worktreeRoot);
    // Reap worktrees whose PR has merged (incl. manual GitHub merges) so stale locals don't linger.
    const merged = await gh.mergedBranches(repo.repoPath).catch(() => new Set<string>()); // empty for local-only repos
    for (const w of wts.filter((w) => merged.has(w.branch))) {
      agent.stop(w.worktreePath);
      await agent.killByBranch(w.branch);
      preview.stop(w.worktreePath);
      await git.removeWorktree(repo.repoPath, w.worktreePath).catch(() => {});
      await git.deleteBranch(repo.repoPath, w.branch);
    }
    wts = wts.filter((w) => !merged.has(w.branch));
    const live = await agent.detectRunning(wts.map((w) => w.branch)); // recover status lost on restart
    const base = await git.resolveBase(repo.repoPath, repo.baseBranch); // origin/<base>, not stale local
    return json(await Promise.all(wts.map(async (w) => {
      const run = agent.status(w.worktreePath);
      const agentStatus = run.status !== "idle" ? run.status : live.has(w.branch) ? "running" : "idle";
      return {
        ...w,
        agentStatus,
        agentError: run.error,
        agentResult: run.result,
        agentMeta: run.meta,
        agentStartedAt: run.startedAt,
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
    agent.runAgent(body.worktreePath, body.prompt);
    return json({ status: "running" });
  }
  if (req.method === "POST" && p === "/api/claude") {
    // generic action: run Claude with a prompt in a worktree (or the repo for repo-level actions)
    agent.launch(body.key, body.worktree || repo.repoPath, body.prompt, body.resume);
    return json({ status: "running" });
  }
  if (req.method === "GET" && p === "/api/claude/status") {
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
