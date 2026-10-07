import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiPort } from "../store";

// A real terminal in the browser: xterm.js wired to one of the bridge's tmux sessions over a
// WebSocket. All assets are bundled (no CDN). On open the server sends the current screen, then
// streams raw pane output as binary frames; keystrokes and resizes go back as small JSON control
// messages. Reconnects on its own if the socket drops; the tmux session outlives both the socket
// and the bridge, so nothing is lost when a tab closes.
//
// Fidelity: tmux `pipe-pane` + xterm (the Bun-only path — no node-pty). Fine for Claude Code's TUI;
// a heavy full-screen redraw can occasionally tear, and a resize redraws it.
export function LiveTerminal({ session }: { session: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let term: XTerm;
    const fit = new FitAddon();
    try {
      term = new XTerm({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, cursorBlink: true, scrollback: 10000, theme: { background: "#0a0a0a" } });
      term.loadAddon(fit);
      term.open(el);
      try { fit.fit(); } catch { /* not laid out yet */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); // no canvas (a test DOM): say so rather than crash the window
      return;
    }

    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const sendResize = () => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // Straight to the bridge port, NOT location.host — in dev that's Vite, whose Bun runtime can't
      // proxy a WS upgrade. In the built app apiPort() is the page's own port, so this is same-origin.
      try {
        ws = new WebSocket(`${proto}://${location.hostname || "localhost"}:${apiPort()}/api/terminal/ws?session=${encodeURIComponent(session)}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e)); // an invalid URL (no hostname): nothing to retry
        return;
      }
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
  }, [session]);
  if (error) return <p className="text-destructive p-3 text-xs" data-slot="live-terminal">The terminal could not start here: {error}</p>;
  return <div ref={ref} data-slot="live-terminal" className="h-full w-full overflow-hidden bg-neutral-950 p-1" />;
}
