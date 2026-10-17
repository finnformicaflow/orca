// Where inbound events land in Orca (docs/research/integrations.md §3.5 targets `orchestrator` and
// `workstream`). One function per target wraps today's entry points, so the orchestrator's queue,
// batching, wake guards and the workers' follow-up path stay exactly as they are.
import * as db from "../db";
import * as orchestrator from "../orchestrator";
import * as verbs from "../verbs";
import type { OrcaConfig } from "../config";
import { fenceExternal, replyToOf, type Envelope, type SendResult } from "../../shared/integrations";

/** The text an event becomes for an agent: an outside sender's fenced as data, Orca's own as is. */
export const agentText = (e: Envelope): string => (e.grant ? fenceExternal(e) : e.title ? `${e.title}: ${e.text}` : e.text);

/** `inbox.toOrchestrator` (§3.5). An outside sender's message goes in as a message with its grant
 *  (a separate wake from any other grant, verbs checked server-side); a person resets the wake count,
 *  a script does not. Orca's own event (a subscription of `orca.*` to the orchestrator) is a worker
 *  report: management by exception, batched like the rest. */
export async function toOrchestrator(cfg: OrcaConfig, e: Envelope): Promise<SendResult> {
  if (e.grant) {
    if (e.grant.level === "notify") return { ok: false, retryable: false, error: "notify links send nothing inbound" };
    const replyTo = replyToOf(e);
    await orchestrator.message(cfg, agentText(e), e.attachments ?? [], { grant: e.grant, person: Boolean(e.actor), ...(replyTo ? { replyTo } : {}) });
  } else {
    await orchestrator.deliverReport(cfg, agentText(e));
  }
  return { ok: true };
}

/** A follow-up on the workstream a thread is linked to, on the instance that holds its worktree. */
export async function toWorkstream(cfg: OrcaConfig, repoName: string, branch: string, e: Envelope): Promise<SendResult> {
  const repo = cfg.repos.find((r) => r.name === repoName);
  if (!repo) return { ok: false, retryable: false, error: `no repo named ${repoName}` };
  const instruction = agentText(e);
  const home = await verbs.placement(repo, { branch });
  if (home !== db.instanceName()) await orchestrator.viaInstance(cfg, home, "/api/workstreams/followup", { repo: repo.name, branch, instruction });
  else await verbs.followUp(cfg, repo, branch, { instruction });
  return { ok: true };
}
