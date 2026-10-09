import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Bot, PictureInPicture2, PanelBottomClose, X } from "lucide-react";
import { ChatPanel } from "@/views/Chat";
import { api } from "../api";
import type { Row } from "../store";
import { FRAME_MIN_H as MIN_H, FRAME_MIN_W as MIN_W, ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO, clampFrame, resizeFrame, type Frame } from "../workstream";
import { PortalContainer } from "@/lib/utils";
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
  // Popped out: the chat lives in an always-on-top Document Picture-in-Picture window (Chrome/Edge
  // 116+), rendered there by a PORTAL — the same React tree, so its state, composer draft, SSE and
  // popovers carry over rather than being copied. Browsers without the API get no Pop out button.
  const [pip, setPip] = useState<Window | null>(null);
  // The poll runs on the PiP window's timers while popped out: that window is the visible one, and
  // a hidden tab's timers get throttled (to once a minute after a while).
  useEffect(() => {
    if (!open) return;
    void load();
    const host = pip ?? window;
    const timer = host.setInterval(load, 2000);
    return () => host.clearInterval(timer);
  }, [open, pip]);
  useEffect(() => { if (!open) pip?.close(); }, [open]);
  useEffect(() => {
    if (!pip) return;
    // The page's theme is a class on <html> (lib/theme.ts): mirror <html>'s class and inline style
    // (CSS variables), so a theme toggle in the tab reaches the PiP too.
    const sync = () => {
      const from = document.documentElement, to = pip.document.documentElement;
      to.className = from.className;
      to.style.cssText = from.style.cssText;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true });
    return () => { observer.disconnect(); pip.close(); };
  }, [pip]);
  const popOut = async () => {
    const w = await pipApi()!.requestWindow(loadPipSize(frame)).catch(() => null);
    if (!w) return;
    copyStyles(document, w.document);
    // Closing it (its own ✕, Return to tab, or the launcher) brings the chat back into the tab.
    w.addEventListener("pagehide", () => { savePipSize(w); setPip(null); }, { once: true });
    setPip(w);
  };
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
  const pin = (el: HTMLDivElement): Required<Frame> => {
    const r = el.getBoundingClientRect();
    const f = { x: r.left, y: r.top, w: r.width || frame.w, h: r.height || frame.h };
    el.style.left = `${f.x}px`; el.style.top = `${f.y}px`; el.style.right = "auto"; el.style.bottom = "auto"; el.style.position = "fixed";
    return f;
  };
  const track = (e: ReactPointerEvent, onMove: (dx: number, dy: number, start: Required<Frame>) => Frame) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const start = pin(el);
    const x0 = e.clientX, y0 = e.clientY;
    let last: Frame = start;
    const move = (ev: PointerEvent) => {
      // Every move is clamped: no part of the window can leave the viewport.
      last = clampFrame(onMove(ev.clientX - x0, ev.clientY - y0, start), window.innerWidth, window.innerHeight);
      el.style.left = `${last.x}px`; el.style.top = `${last.y}px`; el.style.width = `${last.w}px`; el.style.height = `${last.h}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setFrame(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  const onDragStart = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    track(e, (dx, dy, s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
  };
  /** An edge or corner handle: `h` ∈ n/s/e/w and their corners. Left/top edges move the origin too. */
  const onResizeStart = (h: string) => (e: ReactPointerEvent) => track(e, (dx, dy, s) => resizeFrame(s, h, dx, dy, window.innerWidth, window.innerHeight));
  // A smaller browser window pulls a placed window back inside it; the clamped frame is saved, so a
  // spot remembered from a bigger screen is fixed for good.
  useEffect(() => {
    const fit = () => setFrame((f) => clampFrame(f, window.innerWidth, window.innerHeight));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  useEffect(() => saveFrame(frame), [frame]);
  const placed = frame.x !== undefined && frame.y !== undefined;
  const header = (
    <div
      className={`flex items-center justify-between gap-2 border-b px-3 py-2 select-none ${pip ? "" : "cursor-move"}`}
      onPointerDown={pip ? undefined : onDragStart} data-slot="orchestrator-handle" title={pip ? undefined : "Drag to move"}
    >
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
      <div className="flex shrink-0 items-center">
        {pip ? (
          <Button size="icon" variant="ghost" className="size-7" title="Return to tab" aria-label="Return to tab" onClick={() => pip.close()}>
            <PanelBottomClose className="size-4" />
          </Button>
        ) : pipApi() && (
          <Button size="icon" variant="ghost" className="size-7" title="Pop out: keep it on top of every window" aria-label="Pop out" onClick={() => void popOut()}>
            <PictureInPicture2 className="size-4" />
          </Button>
        )}
        <Button size="icon" variant="ghost" className="size-7" title="Close" aria-label="Close orchestrator" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
  // No padding: the terminal log fills the window edge to edge.
  const chat = (
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
  );
  // Smaller than a card's terminal, scoped to this panel via descendant selectors so
  // ChatPanel/ChatComposer stay untouched for everyone else. The agent's replies are
  // markdown in a `prose-sm` block that sets ITS OWN font-size (0.875rem), so shrinking the
  // log's `text-xs` alone left the replies large — the prose block is scaled too, and its
  // children follow (typography sizes them in em).
  const panelClass = "dark bg-neutral-950 text-foreground flex flex-col overflow-hidden [&_.text-xs]:text-[10px] [&_.prose]:text-[10.5px] [&_.prose]:leading-snug [&_textarea]:text-[11px]";
  return (
    // z-40: above the board, below menus and popovers (z-50), which must still open over it.
    <div className="fixed right-4 bottom-4 z-40 flex flex-col items-end gap-3" onKeyDown={(e) => { if (e.key === "Escape" && !pip) setOpen(false); }}>
      {open && pip && createPortal(
        // Popovers and menus opened in here must portal into the PiP document, not the tab's.
        <PortalContainer.Provider value={pip.document.body}>
          <div role="dialog" aria-label="Orchestrator" data-slot="orchestrator-panel" data-pip="" className={`${panelClass} h-screen w-screen`}>{header}{chat}</div>
        </PortalContainer.Provider>,
        pip.document.body,
      )}
      {open && !pip && (
        <div
          ref={panelRef}
          role="dialog" aria-label="Orchestrator" data-slot="orchestrator-panel"
          // `relative` (for the absolute handles) ONLY while unplaced: with both `relative` and
          // `fixed` on the element, `relative` won the cascade and the saved left/top became an
          // offset from the corner — the window sat off-screen, invisible. Placed = fixed, period.
          className={`${panelClass} rounded-lg border shadow-xl ${placed ? "fixed" : "relative"}`}
          style={{
            // Unplaced, it stacks above the launcher (3rem + gaps), so its max height leaves room for it.
            width: frame.w, height: frame.h, maxWidth: "calc(100vw - 2rem)", maxHeight: placed ? "100vh" : "calc(100vh - 6rem)", minWidth: MIN_W, minHeight: MIN_H,
            ...(placed ? { left: frame.x, top: frame.y } : {}),
          }}
        >
          {/* Resize handles on every edge and corner (the browser's own `resize` is bottom-right only). */}
          {RESIZE_HANDLES.map(([h, cls]) => (
            <div key={h} data-slot="orchestrator-resize" data-handle={h} onPointerDown={onResizeStart(h)} className={`absolute z-10 ${cls}`} />
          ))}
          {header}
          {chat}
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
    // A remembered spot partly off the current screen (a smaller window) is pulled back inside it.
    const placed = typeof f.x === "number" && typeof f.y === "number";
    return clampFrame(placed ? { x: f.x, y: f.y, w, h } : { w, h }, window.innerWidth, window.innerHeight);
  } catch { return DEFAULT_FRAME; }
}
function saveFrame(f: Frame): void {
  try { localStorage.setItem(FRAME_KEY, JSON.stringify(f)); } catch { /* private window */ }
}

type DocumentPip = { requestWindow(size: { width: number; height: number }): Promise<Window> };
const pipApi = () => (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
// The PiP window's size, remembered like the frame (the browser lets you resize it, not place it).
const PIP_KEY = "orca.orchestrator.pip";
function loadPipSize(f: Frame): { width: number; height: number } {
  try {
    const s = JSON.parse(localStorage.getItem(PIP_KEY) ?? "null") as { width?: unknown; height?: unknown } | null;
    if (typeof s?.width === "number" && typeof s.height === "number") return { width: s.width, height: s.height };
  } catch { /* fall through */ }
  return { width: f.w, height: f.h };
}
function savePipSize(w: Window): void {
  try { localStorage.setItem(PIP_KEY, JSON.stringify({ width: w.innerWidth, height: w.innerHeight })); } catch { /* private window */ }
}
/** A PiP document starts empty: give it the page's stylesheets (Tailwind, the theme's CSS variables). */
function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join("\n");
      to.head.append(style);
    } catch {
      // A cross-origin sheet can't be read; link it instead.
      if (!sheet.href) continue;
      const link = to.createElement("link");
      link.rel = "stylesheet"; link.href = sheet.href;
      to.head.append(link);
    }
  }
}
