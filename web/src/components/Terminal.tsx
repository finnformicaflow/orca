import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "../store";
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
