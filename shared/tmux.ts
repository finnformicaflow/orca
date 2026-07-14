// Pure tmux-session naming — no I/O, so the adapter, the server route, and the tests all agree on
// the ONE name a repo+branch maps to. Namespaced under `orca/` so Orca's interactive sessions can
// never collide with (or get killed alongside) the user's own tmux sessions. tmux forbids `.` and
// `:` in session names (they're its window/pane separators); `/` is allowed, so the namespace reads
// as a path. The launch-vs-attach *command* decision lives in attachCommand (shared/agent.ts) —
// reused verbatim so a terminal session resumes exactly like Copy CLI does.

/** Keep only tmux-safe characters; collapse the rest to `-`. */
const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";

/** The one tmux session name for a worktree: `orca/<repo>/<branch-slug>`. */
export function sessionName(repo: string, branch: string): string {
  return `orca/${slug(repo)}/${slug(branch)}`;
}

/** An Orca-owned session name (what listSessions surfaces) — never a user's own session. */
export const isOrcaSession = (name: string): boolean => name.startsWith("orca/");
