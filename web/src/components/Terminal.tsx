import { useEffect, useRef, useState } from "react";
import { Bot, X } from "lucide-react";
import { ChatPanel } from "@/views/Chat";
import { api } from "../api";
import type { Row } from "../store";
import { CONTEXT_RESET_PCT, ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "../workstream";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/ModelPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// The card's terminal: a modal you open in place (no navigating to the detail page) showing the
// branch's conversation as a terminal-style log — the durable turns Orca records — with the follow-up
// composer to send the next message. It is NOT a live shell; it renders GET /api/turns, so nothing
// tmux is involved. The native <dialog> gives the backdrop, ESC-close and focus trap for free, and
// ChatPanel mounts ONLY while open so its poll/composer aren't running behind a closed dialog.
export function TerminalDialog({ row, open, onClose }: { row: Row; open: boolean; onClose: () => void }) {
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
          <div className="truncate text-sm font-medium">Terminal · {row.title}</div>
          <Button size="icon" variant="ghost" className="size-7 shrink-0" title="Close" aria-label="Close terminal" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 p-3">{open && <ChatPanel row={row} />}</div>
      </div>
    </dialog>
  );
}

// The orchestrator: the one conversation you talk to, which starts and steers workstreams itself.
// A floating launcher in the bottom-right corner that pops out a chat window above it, the way a
// website's chat widget does — NOT a modal: the board behind it stays visible and usable, because
// the point of talking to it is to watch the cards it moves. The window is the same ChatPanel a
// card's terminal uses (its turns are recorded like any other conversation, under a reserved
// repo/branch) with the composer pointed at its own route. Polled only while open: whether it is
// running drives Stop and the composer's placeholder.
export function OrchestratorButton() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ key: string; running: boolean; paused: boolean; model: string; contextPct?: number } | null>(null);
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
    // z-40: above the board, below menus and popovers (z-50), which must still open over it.
    <div className="fixed right-4 bottom-4 z-40 flex flex-col items-end gap-3" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      {open && (
        <div
          role="dialog" aria-label="Orchestrator" data-slot="orchestrator-panel"
          className="bg-card text-foreground flex h-[min(640px,calc(100vh-6rem))] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border shadow-xl"
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            {/* Paused = it has woken itself as many times as it may without hearing from you. */}
            <div className="truncate text-sm font-medium">{state?.paused ? "Orchestrator · paused until you reply" : "Orchestrator"}</div>
            <Button size="icon" variant="ghost" className="size-7 shrink-0" title="Close" aria-label="Close orchestrator" onClick={() => setOpen(false)}>
              <X className="size-4" />
            </Button>
          </div>
          {/* No padding: the terminal log fills the window edge to edge. */}
          <div className="min-h-0 flex-1">
            <ChatPanel
              row={row} flush
              // Its model, changed where you type. Claude only; the session carries over.
              leading={state && (
                <div className="flex min-w-0 items-center gap-1">
                  <ModelPicker
                    only="claude" label="Orchestrator model" value={state.model} className="min-w-0"
                    onChange={(model) => { setState({ ...state, model }); void api.orchestratorModel(model).then(load); }}
                  />
                  <ContextRing pct={state.contextPct} />
                </div>
              )}
              send={async (text, images) => {
                await api.orchestratorMessage(text, images.length ? await api.uploadAttachments(images) : []);
                await load();
              }}
            />
          </div>
        </div>
      )}
      {/* Inverted against the page — foreground as the fill — so it stands off the board in either theme. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close orchestrator" : "Open orchestrator"} aria-expanded={open}
        title="Talk to the orchestrator: it starts and steers workstreams for you"
        className="bg-foreground text-background focus-visible:ring-ring flex size-12 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        {open ? <X className="size-5" /> : <Bot className="size-5" />}
      </button>
    </div>
  );
}

/** How full the orchestrator's session is: an icon button holding a small ring, with the number in
 *  a popover on hover (and on click or focus, for touch and keyboard). It turns amber at the point
 *  the next wake resets the session onto its notes instead of resuming it. */
function ContextRing({ pct }: { pct?: number }) {
  const [open, setOpen] = useState(false);
  const value = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  const full = value >= CONTEXT_RESET_PCT;
  const r = 6, c = 2 * Math.PI * r;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button" size="icon" variant="ghost" data-slot="context-ring"
          aria-label={pct === undefined ? "Context: not measured yet" : `Context ${value}% full`}
          className={`size-8 shrink-0 cursor-pointer ${full ? "text-amber-400 hover:text-amber-300" : "text-muted-foreground"}`}
          onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}
        >
          <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} />
          </svg>
        </Button>
      </PopoverTrigger>
      {/* Not focus-stealing: hovering the ring must not pull the caret out of the message box. */}
      <PopoverContent side="top" align="start" className="w-56 p-2 text-xs" data-slot="context-ring-card" onOpenAutoFocus={(e) => e.preventDefault()}>
        {pct === undefined ? <div className="font-medium">Context not measured yet</div> : <div className="font-medium">Context {value}% full</div>}
        <div className="text-muted-foreground mt-0.5">
          {pct === undefined ? "It is reported when a run finishes."
            : full ? "The next message starts a fresh session from its notes."
            : `Resets onto its notes at ${CONTEXT_RESET_PCT}%.`}
        </div>
      </PopoverContent>
    </Popover>
  );
}
