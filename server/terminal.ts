// The browser terminal's WebSocket glue (adapter side). On connect it sends the current screen, then
// streams raw pane output live; client keystrokes/resizes flow back to the session. tmux does all the
// real work (server/tmux.ts) — this only bridges a WS to a session:
//   pane output → `tmux pipe-pane` → FIFO → `cat` → ws  (binary frames, raw ANSI)
//   ws input    → `tmux send-keys -l`                    (raw bytes)
// A FIFO (not a growing temp file) keeps memory/disk bounded for a long session, and `cat` reuses a
// binary rather than us hand-rolling FIFO reads. Bound to localhost by the server (see index.ts).
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ServerWebSocket } from "bun";
import * as tmux from "./tmux";
import { run } from "./run";

export type TerminalData = { name: string; dir?: string; reader?: Bun.Subprocess };

export const terminalWs = {
  async open(ws: ServerWebSocket<TerminalData>) {
    const { name } = ws.data;
    try { ws.send(await tmux.capturePane(name)); } catch { /* session may have just died */ }
    // FIFO in a private temp dir; `cat` blocks on it until tmux's pipe-pane opens the write end.
    const dir = mkdtempSync(join(tmpdir(), "orca-term-"));
    const fifo = join(dir, "pane");
    await run(["mkfifo", fifo]);
    const reader = Bun.spawn(["cat", fifo], { stdout: "pipe", stderr: "ignore" });
    ws.data.dir = dir;
    ws.data.reader = reader;
    await tmux.pipeStart(name, fifo);
    void (async () => {
      const r = reader.stdout.getReader();
      try {
        while (true) {
          const { value, done } = await r.read();
          if (done) break;
          if (ws.readyState !== 1) break; // client gone
          ws.send(value); // Uint8Array → binary frame; xterm.write handles the UTF-8/ANSI decode
        }
      } catch { /* reader killed on close */ }
    })();
  },
  async message(ws: ServerWebSocket<TerminalData>, raw: string | Buffer) {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
    if (msg.type === "input" && typeof msg.data === "string") await tmux.sendKeys(ws.data.name, msg.data).catch(() => {});
    else if (msg.type === "resize" && msg.cols && msg.rows) await tmux.resize(ws.data.name, msg.cols, msg.rows);
  },
  close(ws: ServerWebSocket<TerminalData>) {
    void tmux.pipeStop(ws.data.name); // stop teeing; the SESSION keeps running (persistence is the point)
    try { ws.data.reader?.kill(); } catch { /* already gone */ }
    if (ws.data.dir) try { rmSync(ws.data.dir, { recursive: true, force: true }); } catch { /* already gone */ }
  },
};
