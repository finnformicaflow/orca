import { useEffect, useRef, useState } from "react";
import { Bot, X } from "lucide-react";
import { ChatPanel } from "@/views/Chat";
import { api } from "../api";
import type { Row } from "../store";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../workstream";
import { Button } from "@/components/ui/button";

// The card's terminal: a modal you open in place (no navigating to the detail page) showing the
// branch's conversation as a terminal-style log — the durable turns Orca records — with the follow-up
// composer to send the next message. It is NOT a live shell; it renders GET /api/turns, so nothing
// tmux is involved. The native <dialog> gives the backdrop, ESC-close and focus trap for free, and
// ChatPanel mounts ONLY while open so its poll/composer aren't running behind a closed dialog.
export function TerminalDialog({ row, open, onClose, title, send }: {
  row: Row; open: boolean; onClose: () => void;
  title?: string; // replaces "Terminal · <card title>"
  send?: (text: string, images: File[]) => Promise<void>; // see ChatPanel
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }} // click the backdrop → close
      // No `display` utility (flex/grid/…) on the <dialog> itself: an author display rule beats the
      // UA `dialog:not([open]) { display: none }` (UA origin loses to author regardless of
      // specificity), so a closed dialog would render inline in the swimlane. Layout goes on the
      // inner wrapper instead; the dialog stays hidden until showModal().
      className="bg-card text-foreground m-auto h-[80vh] w-[90vw] max-w-4xl rounded-lg border p-0 shadow-lg backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="truncate text-sm font-medium">{title ?? `Terminal · ${row.title}`}</div>
          <Button size="icon" variant="ghost" className="size-7 shrink-0" title="Close" aria-label="Close terminal" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 p-3">{open && <ChatPanel row={row} send={send} />}</div>
      </div>
    </dialog>
  );
}

// The orchestrator: the one conversation you talk to, which starts and steers workstreams itself.
// The same modal and the same panel as a card's terminal — its turns are recorded like any other
// conversation, under a reserved repo/branch — with the composer pointed at its own route. Polled
// only while open: whether it is running drives Stop and the composer's placeholder.
export function OrchestratorButton() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ key: string; running: boolean; paused: boolean } | null>(null);
  const load = () => api.orchestrator().then(setState).catch(() => {});
  useEffect(() => {
    if (!open) return;
    void load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [open]);
  const row: Row = {
    repo: ORCHESTRATOR_REPO, hasRemote: false, branch: ORCHESTRATOR_BRANCH, title: "Orchestrator", prompt: "", lane: "LOCAL",
    worktreePath: state?.key, agentStatus: state?.running ? "running" : "idle",
  };
  return (
    <>
      <Button size="sm" variant="outline" title="Talk to the orchestrator: it starts and steers workstreams for you" onClick={() => setOpen(true)}>
        <Bot className="size-4" /> Orchestrator
      </Button>
      <TerminalDialog
        row={row} open={open} onClose={() => setOpen(false)}
        // Paused = it has woken itself as many times as it may without hearing from you.
        title={state?.paused ? "Orchestrator · paused until you reply" : "Orchestrator"}
        send={async (text, images) => {
          await api.orchestratorMessage(text, images.length ? await api.uploadAttachments(images) : []);
          await load();
        }}
      />
    </>
  );
}
