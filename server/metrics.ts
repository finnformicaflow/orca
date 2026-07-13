// Process-lifetime counters that feed /api/diagnostics. Deliberately not persisted — they measure
// *this* bridge run (how chatty polling is against GitHub), and resetting on restart is the right
// behaviour. In-memory and monotonic; the diagnostics endpoint reads them alongside the ledger.
const counters = { ghCalls: 0, agentPolls: 0, startedAt: Date.now() };

/** One shell-out to the `gh` CLI (every gh adapter call funnels through here). */
export const countGhCall = () => { counters.ghCalls++; };
/** One `/api/agents` poll served (the store's most frequent GitHub-backed refresh). */
export const countAgentPoll = () => { counters.agentPolls++; };

export const metrics = () => ({ ...counters, uptimeMs: Date.now() - counters.startedAt });
