import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
  const [state, setState] = useState<{ key: string; running: boolean; paused: boolean; model: string; contextPct?: number; lastWakeUsd?: number; hint?: string } | null>(null);
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
  // Where and how big the window is: dragged by its header, resized from any edge or corner,
  // remembered per browser. Until it is moved it sits above the launcher, anchored bottom-right, so
  // it stays put as the viewport changes. During a drag or resize the element's style is written
  // DIRECTLY — a React state update per pointer move re-rendered the whole chat and lagged; state
  // (and storage) is updated once, when the pointer lets go.
  const [frame, setFrame] = useState<Frame>(() => loadFrame());
  const panelRef = useRef<HTMLDivElement>(null);
  /** Pin the panel where it currently is (left/top instead of right/bottom), so edges can move. */
  const pin = (el: HTMLDivElement): Frame => {
    const r = el.getBoundingClientRect();
    const f = { x: r.left, y: r.top, w: r.width || frame.w, h: r.height || frame.h };
    el.style.left = `${f.x}px`; el.style.top = `${f.y}px`; el.style.right = "auto"; el.style.bottom = "auto"; el.style.position = "fixed";
    return f;
  };
  const track = (e: ReactPointerEvent, onMove: (dx: number, dy: number, start: Frame, el: HTMLDivElement) => Frame) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const start = pin(el);
    const x0 = e.clientX, y0 = e.clientY;
    let last = start;
    const move = (ev: PointerEvent) => {
      last = onMove(ev.clientX - x0, ev.clientY - y0, start, el);
      el.style.left = `${last.x}px`; el.style.top = `${last.y}px`; el.style.width = `${last.w}px`; el.style.height = `${last.h}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setFrame(last); saveFrame(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  const onDragStart = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    track(e, (dx, dy, s) => ({ ...s, x: Math.max(0, Math.min(window.innerWidth - 80, s.x! + dx)), y: Math.max(0, Math.min(window.innerHeight - 40, s.y! + dy)) }));
  };
  /** An edge or corner handle: `h` ∈ n/s/e/w and their corners. Left/top edges move the origin too. */
  const onResizeStart = (h: string) => (e: ReactPointerEvent) => track(e, (dx, dy, s) => {
    let { x = 0, y = 0, w, h: hh } = s;
    if (h.includes("e")) w = Math.max(MIN_W, s.w + dx);
    if (h.includes("s")) hh = Math.max(MIN_H, s.h + dy);
    if (h.includes("w")) { const nw = Math.max(MIN_W, s.w - dx); x = s.x! + (s.w - nw); w = nw; }
    if (h.includes("n")) { const nh = Math.max(MIN_H, s.h - dy); y = s.y! + (s.h - nh); hh = nh; }
    return { x, y, w, h: hh };
  });
  const placed = frame.x !== undefined && frame.y !== undefined;
  return (
    // z-40: above the board, below menus and popovers (z-50), which must still open over it.
    <div className="fixed right-4 bottom-4 z-40 flex flex-col items-end gap-3" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      {open && (
        <div
          ref={panelRef}
          role="dialog" aria-label="Orchestrator" data-slot="orchestrator-panel"
          // Smaller than a card's terminal, scoped to this panel via descendant selectors so
          // ChatPanel/ChatComposer stay untouched for everyone else. The agent's replies are
          // markdown in a `prose-sm` block that sets ITS OWN font-size (0.875rem), so shrinking the
          // log's `text-xs` alone left the replies large — the prose block is scaled too, and its
          // children follow (typography sizes them in em).
          className={`dark bg-neutral-950 text-foreground relative flex flex-col overflow-hidden rounded-lg border shadow-xl [&_.text-xs]:text-[10px] [&_.prose]:text-[10.5px] [&_.prose]:leading-snug [&_textarea]:text-[11px] ${placed ? "fixed" : ""}`}
          style={{
            width: frame.w, height: frame.h, maxWidth: "calc(100vw - 2rem)", maxHeight: "calc(100vh - 2rem)", minWidth: MIN_W, minHeight: MIN_H,
            ...(placed ? { left: frame.x, top: frame.y } : {}),
          }}
        >
          {/* Resize handles on every edge and corner (the browser's own `resize` is bottom-right only). */}
          {RESIZE_HANDLES.map(([h, cls]) => (
            <div key={h} data-slot="orchestrator-resize" data-handle={h} onPointerDown={onResizeStart(h)} className={`absolute z-10 ${cls}`} />
          ))}
          <div className="flex cursor-move items-center justify-between gap-2 border-b px-3 py-2 select-none" onPointerDown={onDragStart} data-slot="orchestrator-handle" title="Drag to move">
            {/* Paused = it has woken itself as many times as it may without hearing from you. */}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{state?.paused ? "Orchestrator · paused until you reply" : "Orchestrator"}</div>
              {/* What the last wake cost; amber once the session is big enough that a fresh one would be much cheaper. */}
              {state?.lastWakeUsd !== undefined && (
                <div className={`truncate text-[10px] ${state.hint ? "text-amber-400" : "text-neutral-500"}`} title={state.hint} data-slot="orchestrator-spend">
                  last wake ${state.lastWakeUsd.toFixed(2)}{state.hint ? ` · ${state.hint}` : ""}
                </div>
              )}
            </div>
            <Button size="icon" variant="ghost" className="size-7 shrink-0" title="Close" aria-label="Close orchestrator" onClick={() => setOpen(false)}>
              <X className="size-4" />
            </Button>
          </div>
          {/* No padding: the terminal log fills the window edge to edge. */}
          <div className="min-h-0 flex-1">
            {state && <ChatPanel
              row={row} flush
              // The same toolbar a card's terminal has, fed the orchestrator's own values. Claude
              // only; changing the model keeps the session.
              controls={{
                model: state.model, only: "claude", contextPct: state.contextPct,
                onModel: (model) => { setState({ ...state, model }); void api.orchestratorModel(model).then(load); },
              }}
              send={async (text, images) => {
                await api.orchestratorMessage(text, images.length ? await api.uploadAttachments(images) : []);
                await load();
              }}
            />}
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

// The window's frame, remembered per browser (UI state only, like the theme).
type Frame = { x?: number; y?: number; w: number; h: number };
const MIN_W = 320, MIN_H = 240;
// Edge strips and corner squares, with the cursor each shows. Order puts corners last so they win.
const RESIZE_HANDLES: [string, string][] = [
  ["n", "top-0 left-2 right-2 h-1.5 cursor-ns-resize"], ["s", "bottom-0 left-2 right-2 h-1.5 cursor-ns-resize"],
  ["w", "left-0 top-2 bottom-2 w-1.5 cursor-ew-resize"], ["e", "right-0 top-2 bottom-2 w-1.5 cursor-ew-resize"],
  ["nw", "top-0 left-0 size-3 cursor-nwse-resize"], ["se", "bottom-0 right-0 size-3 cursor-nwse-resize"],
  ["ne", "top-0 right-0 size-3 cursor-nesw-resize"], ["sw", "bottom-0 left-0 size-3 cursor-nesw-resize"],
];
const FRAME_KEY = "orca.orchestrator.frame";
const DEFAULT_FRAME: Frame = { w: Math.min(440, (typeof window === "undefined" ? 440 : window.innerWidth) - 32), h: Math.min(640, (typeof window === "undefined" ? 640 : window.innerHeight) - 96) };
function loadFrame(): Frame {
  try {
    const raw = localStorage.getItem(FRAME_KEY);
    const f = raw ? (JSON.parse(raw) as Partial<Frame>) : {};
    const w = typeof f.w === "number" ? f.w : DEFAULT_FRAME.w, h = typeof f.h === "number" ? f.h : DEFAULT_FRAME.h;
    // A remembered spot off the current screen (a smaller window) snaps back to the corner.
    const onScreen = typeof f.x === "number" && typeof f.y === "number" && f.x < window.innerWidth - 80 && f.y < window.innerHeight - 40;
    return onScreen ? { x: f.x, y: f.y, w, h } : { w, h };
  } catch { return DEFAULT_FRAME; }
}
function saveFrame(f: Frame): void {
  try { localStorage.setItem(FRAME_KEY, JSON.stringify(f)); } catch { /* private window */ }
}
