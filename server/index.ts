import { API_PORT, loadConfig } from "./config";
import * as git from "./git";
import * as gh from "./gh";
import * as agent from "./agent";
import * as preview from "./preview";
import { canMerge, slugifyBranch } from "../web/src/workstream";

const cfg = await loadConfig();
const DIST = new URL("../web/dist/", import.meta.url).pathname;

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (req.method === "GET" && p === "/api/config") {
    return json({ portRange: cfg.portRange, baseBranch: cfg.baseBranch, staleHours: cfg.staleHours, slackChannel: cfg.slackChannel });
  }
  if (req.method === "POST" && p === "/api/workstreams") {
    const branch = slugifyBranch(body.title);
    const worktreePath = await git.createWorktree(cfg.repoPath, cfg.worktreeRoot, branch, cfg.baseBranch);
    return json({ branch, worktreePath });
  }
  if (req.method === "GET" && p === "/api/summary") {
    const wt = url.searchParams.get("worktree");
    if (!wt) return json({ error: "worktree required" }, 400);
    return json(await git.changeSummary(wt, cfg.baseBranch));
  }
  if (req.method === "POST" && p === "/api/promote") {
    return json(await gh.createPr(body.worktreePath, {
      title: body.title, body: body.body ?? "", base: cfg.baseBranch, head: body.branch,
    }));
  }
  if (req.method === "GET" && p === "/api/prs") {
    return json(await gh.listPrs(cfg.repoPath)); // source of truth for the kanban
  }
  const detailMatch = p.match(/^\/api\/prs\/(\d+)$/);
  if (req.method === "GET" && detailMatch) {
    return json(await gh.prDetail(cfg.repoPath, Number(detailMatch[1])));
  }
  const diffMatch = p.match(/^\/api\/prs\/(\d+)\/diff$/);
  if (req.method === "GET" && diffMatch) {
    return json({ diff: await gh.prDiff(cfg.repoPath, Number(diffMatch[1])) });
  }
  if (req.method === "POST" && p === "/api/merge") {
    const status = await gh.prStatus(cfg.repoPath, body.pr);
    if (!canMerge(status)) return json({ error: "not mergeable/green", status }, 409);
    await gh.mergePr(cfg.repoPath, body.pr);
    if (body.worktreePath) await git.removeWorktree(cfg.repoPath, body.worktreePath).catch(() => {});
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/preview") {
    return json(preview.start(body.key, body.worktree, cfg));
  }
  if (req.method === "GET" && p === "/api/preview") {
    const key = url.searchParams.get("key");
    return json(key ? preview.status(key) : []);
  }
  if (req.method === "POST" && p === "/api/preview/stop") {
    preview.stop(body.key);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/api/worktrees/remove") {
    await git.removeWorktree(cfg.repoPath, body.worktreePath).catch(() => {});
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/agents") {
    // source of truth for the agents view: live worktrees + their run status
    const wts = await git.listWorktrees(cfg.repoPath, cfg.worktreeRoot);
    return json(wts.map((w) => {
      const run = agent.status(w.worktreePath);
      return { ...w, agentStatus: run.status, agentError: run.error };
    }));
  }
  if (req.method === "POST" && p === "/api/agents/run") {
    agent.runAgent(body.worktreePath, body.prompt);
    return json({ status: "running" });
  }
  if (req.method === "POST" && p === "/api/claude") {
    // generic action: run Claude with a prompt in a worktree (or the repo for repo-level actions)
    agent.launch(body.key, body.worktree || cfg.repoPath, body.prompt);
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
  async fetch(req) {
    const url = new URL(req.url);
    try {
      return url.pathname.startsWith("/api/") ? await api(req, url) : await serveStatic(url);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
});

console.log(`orca bridge → http://localhost:${API_PORT}`);
