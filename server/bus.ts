// In-process pub/sub, so the chat's SSE stream is a real push rather than the server polling itself.
// The one publisher that matters is transcript.append (a step landed) plus the turn lifecycle
// (started/finished, so a client knows to refetch the durable turn). Deliberately tiny: no topics,
// no buffering, no replay — a subscriber that misses an event refetches /api/turns, which is the
// source of truth. Nothing here is durable; the transcript file and the DB already are.
import type { AgentStep } from "../shared/agent";

export type BusEvent =
  | { kind: "step"; runId: string; steps: AgentStep[] }
  | { kind: "turn"; runId: string };

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
