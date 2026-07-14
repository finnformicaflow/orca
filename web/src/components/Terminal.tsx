import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { openTerminal, type Row } from "../store";

// The browser terminal: an xterm.js view wired to the bridge's per-worktree tmux session over a
// WebSocket. All assets are bundled (no CDN) so a strict CSP has nothing external to allow. On open
// the server sends the current screen, then streams raw pane output as binary frames; keystrokes and
// resizes go back as small JSON control messages. Reconnects automatically if the socket drops.
//
// Fidelity: this is tmux `pipe-pane` + xterm (the Bun-only path — no node-pty). It's effectively
// perfect for the line-based agent chat this drives; a heavy full-screen TUI redraw can occasionally
// tear. Copy CLI remains the escape hatch to a native terminal when that matters.
export function Terminal({ repo, branch }: { repo: string; branch: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new XTerm({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, cursorBlink: true, scrollback: 10000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch { /* not laid out yet */ }

    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const sendResize = () => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/terminal/ws?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => sendResize();
      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 1000); };
      ws.onerror = () => ws?.close();
    };
    connect();

    const onData = term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "input", data: d })));
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } sendResize(); });
    ro.observe(el);

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      onData.dispose();
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [repo, branch]);

  return <div ref={ref} className="h-[70vh] w-full overflow-hidden rounded-md border bg-black p-2" />;
}

// The detail view's Terminal tab: ensure the session exists (adopting a worktree if needed — so it
// works for a PR/worktree that never had one), then mount the live terminal. Idempotent, so revisiting
// the tab re-attaches to the running session.
export function TerminalPanel({ row }: { row: Row }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setReady(false); setError(null);
    openTerminal(row).then(() => { if (live) setReady(true); }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.repo, row.branch]);
  if (error) return <p className="text-destructive text-sm">Couldn't open a terminal: {error}</p>;
  if (!ready) return <p className="text-muted-foreground text-sm">Starting session…</p>;
  return <Terminal repo={row.repo} branch={row.branch} />;
}
