// Thin wrappers over the real `tmux` binary — the interactive lane's adapter (see CLAUDE.md). tmux
// OUTLIVES the bridge by design: a session started here keeps running across a restart (and across
// closing the browser tab), which is the whole point of the interactive terminal. So the bridge
// never owns these sessions the way it owns headless runs — it discovers them (listSessions) and
// only kills them on an explicit Discard. Everything shells out to `tmux`; nothing is reimplemented,
// and there is no node-pty / native module (Bun-only rule). All pure logic is in shared/tmux.ts.
import { run } from "./run";
import { isOrcaSession } from "../shared/tmux";

// `=name` forces an EXACT session match (a bare name also allows a prefix/fnmatch fallback). tmux
// accepts it for SESSION targets (has-session/kill-session) — use it there so existence checks can't
// be fooled by a longer session that shares a prefix. But it is NOT valid for a PANE target
// (send-keys/capture-pane/…), which errors "can't find pane"; those resolve the session name exactly
// FIRST anyway, so a bare name targeting an existing session is unambiguous.
const exact = (name: string) => `=${name}`;

const tmux = (args: string[]) => run(["tmux", ...args]);

/** tmux present on this host? The interactive lane degrades (endpoints 500, board shows no session)
 *  rather than crashing when it isn't — mirroring the advisory-state rule. */
export const available = (): boolean => Boolean(Bun.which("tmux"));

export async function sessionExists(name: string): Promise<boolean> {
  try { await tmux(["has-session", "-t", exact(name)]); return true; } catch { return false; }
}

/** Create the session if absent, running `command` (the attachCommand string) in `worktree`.
 *  Idempotent: if it already exists this is a no-op, so re-opening the terminal just re-attaches.
 *  `window-size manual` + an explicit initial size let a DETACHED session (no tmux client attached —
 *  the browser drives it via send-keys/capture-pane) still be resized to the browser's dimensions. */
export async function ensureSession(name: string, worktree: string, command: string, size = { cols: 200, rows: 50 }): Promise<void> {
  if (await sessionExists(name)) return;
  const args = ["new-session", "-d", "-s", name, "-c", worktree, "-x", String(size.cols), "-y", String(size.rows)];
  if (command) args.push(command); // omitted → tmux starts the default shell (used by tests)
  try {
    await tmux(args);
  } catch (e) {
    // A concurrent ensure (e.g. React strict-mode double-mounting the terminal, or the menu action
    // and the tab both firing) can create the session between our check and this create, so tmux
    // errors "duplicate session". That IS the desired end state — stay idempotent, don't surface it.
    if (!String(e).includes("duplicate session")) throw e;
    return;
  }
  await tmux(["set-option", "-t", name, "window-size", "manual"]).catch(() => {});
}

/** Type into the session. `-l` sends the string LITERALLY (no key-name lookup), so xterm's raw
 *  bytes — printable chars, Enter (\r), Ctrl-C (\x03), arrow escapes (\x1b[A) — all pass through. */
export async function sendKeys(name: string, data: string): Promise<void> {
  await tmux(["send-keys", "-t", name, "-l", data]);
}

/** The current screen, with `-e` preserving ANSI escapes so colours/styling survive the round-trip. */
export async function capturePane(name: string): Promise<string> {
  return tmux(["capture-pane", "-p", "-e", "-t", name]);
}

export async function resize(name: string, cols: number, rows: number): Promise<void> {
  await tmux(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]).catch(() => {});
}

export async function killSession(name: string): Promise<void> {
  try { await tmux(["kill-session", "-t", exact(name)]); } catch { /* already gone */ }
}

/** Tee raw pane output into `sink` (a FIFO the endpoint reads) so the browser gets a live stream.
 *  pipe-pane keeps ONE pipe per pane, so a fresh connection replaces the previous one — fine for a
 *  single-user hand-driven terminal. */
export async function pipeStart(name: string, sink: string): Promise<void> {
  await tmux(["pipe-pane", "-t", name, "-o", `cat > '${sink.replace(/'/g, "'\\''")}'`]);
}

/** Stop teeing output (no command → toggles the pipe off). */
export async function pipeStop(name: string): Promise<void> {
  await tmux(["pipe-pane", "-t", name]).catch(() => {});
}

/** Orca-owned sessions currently alive — tmux outlives the bridge, so this is how a restart
 *  rediscovers live interactive terminals (dovetails with lease.ts's headless-run recovery). Empty
 *  when tmux is absent or its server isn't running. */
export async function listSessions(): Promise<string[]> {
  if (!available()) return [];
  try {
    const out = await tmux(["list-sessions", "-F", "#{session_name}"]);
    return out.split("\n").map((s) => s.trim()).filter(isOrcaSession);
  } catch { return []; } // "no server running" → no sessions
}
