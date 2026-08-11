// In-process pub/sub, so the chat's stream is a real push rather than the server polling itself.
// Publishers: the step recorder (a step landed) and the turn lifecycle (started/finished, so a client
// knows to refetch the durable turn).
//
// It is per-process ON PURPOSE, and that is not a limitation to engineer around: a stream is always
// served by the instance that OWNS the repo (a request for someone else's repo is proxied there), so
// the bus and the run are always in the same process. The one case that would have needed
// cross-instance delivery — a client on the cloud box watching a laptop run — cannot arise, because
// laptop sessions are only visible where they are actionable.
//
// Deliberately tiny: no topics, no buffering, no replay. A subscriber that misses an event resumes
// from its cursor via /api/turns/steps; Postgres holds the durable copy either way.
import type { AgentStep } from "../shared/agent";

// Events carry the branch they belong to, so a chat stream can filter without a database read on
// what is the hottest path in the system (one event per recorded step).
export type BusEvent =
  | { kind: "step"; runId: string; repo: string; branch: string; steps: AgentStep[] }
  | { kind: "turn"; runId: string; repo: string; branch: string };

type Listener = (event: BusEvent) => void;
const listeners = new Set<Listener>();

/** Notify every subscriber. A throwing subscriber (a dead SSE socket) must never break the run that
 *  published the event, so failures are swallowed — same advisory contract as the ledger. */
export function publish(event: BusEvent): void {
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* a closed stream — the unsubscribe is on its way */ }
  }
}

/** Subscribe; call the returned function to stop. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Open subscriber count — used by tests, and by /api/diagnostics to spot leaked streams. */
export const subscriberCount = (): number => listeners.size;
