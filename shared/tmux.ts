// Pure tmux-session naming — no I/O, so the adapter, the route and the tests agree on the one name.
// Namespaced under `orca/` so Orca's sessions can never collide with (or get killed alongside) the
// user's own tmux sessions. tmux forbids `.` and `:` in session names; `/` is allowed.

/** The orchestrator's live terminal: ONE session, Claude Code's TUI in its working directory. */
export const ORCHESTRATOR_SESSION = "orca/orchestrator";

/** An Orca-owned session name (what listSessions surfaces) — never a user's own session. */
export const isOrcaSession = (name: string): boolean => name.startsWith("orca/");
