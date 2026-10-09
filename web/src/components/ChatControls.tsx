import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/ModelPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AgentProvider } from "../../../shared/agent";
import { CONTEXT_RESET_PCT } from "../workstream";

/** What a conversation's composer carries in its toolbar: the model the next message runs on, and
 *  how full the session is. ONE component for every conversation — a card's terminal and the
 *  orchestrator's window differ only in the values they hand it. */
export type ChatControlsProps = {
  model: string; onModel: (id: string) => void;
  only?: AgentProvider; // offer just this provider's models
  ran?: string; // the last run's reported model, for the picker's tooltip
  contextPct?: number; // absent until a run has reported it (Codex and Cursor never do)
};

/** The ring card's Compact button: `/compact` in the session. Set by the chat panel, which knows the
 *  conversation; absent where there is no Claude session to compact. */
export type CompactControl = {
  onCompact: () => Promise<void>;
  pending: boolean; // a compaction is running; ends when its turn finishes
  busy: boolean; // a run is mid-turn: the session takes no command until it finishes
  error?: string;
};

export function ChatControls({ model, onModel, only, ran, contextPct, compact }: ChatControlsProps & { compact?: CompactControl }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ModelPicker label="Model" value={model} ran={ran} only={only} onChange={onModel} className="min-w-0" />
      <ContextRing pct={contextPct} compact={compact} />
    </div>
  );
}

/** How full the session is: an icon button holding a small ring, with the number in a popover on
 *  hover (and on click or focus, for touch and keyboard). It turns amber at the point the handover
 *  ladder stops resuming the session and starts a fresh one. */
function ContextRing({ pct, compact }: { pct?: number; compact?: CompactControl }) {
  const [open, setOpen] = useState(false);
  // Closing waits a moment so the pointer can cross from the ring to the card (and its button).
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hover = (on: boolean) => {
    clearTimeout(closing.current);
    if (on) setOpen(true);
    else closing.current = setTimeout(() => setOpen(false), 150);
  };
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
          onPointerEnter={() => hover(true)} onPointerLeave={() => hover(false)}
        >
          <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} />
          </svg>
        </Button>
      </PopoverTrigger>
      {/* Not focus-stealing: hovering the ring must not pull the caret out of the message box. */}
      <PopoverContent side="top" align="start" className="w-56 p-2 text-xs" data-slot="context-ring-card" onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={() => hover(true)} onPointerLeave={() => hover(false)}>
        {pct === undefined ? <div className="font-medium">Context not measured yet</div> : <div className="font-medium">Context {value}% full</div>}
        <div className="text-muted-foreground mt-0.5">
          {pct === undefined ? "It is reported when a Claude run finishes."
            : full ? "The next message starts a fresh session, carrying a summary of this one."
            : `A fresh session starts at ${CONTEXT_RESET_PCT}%.`}
        </div>
        {compact && (
          // Disabled mid-turn rather than queued: a queued message is a prompt for the model, and
          // `/compact` only works as the whole prompt of its own run. The span carries the tooltip,
          // since a disabled button gets no pointer events.
          <span className="mt-2 block" title={compact.busy && !compact.pending ? "The agent is mid-turn — compact once it finishes." : "Summarise this session to free context, as /compact does."}>
            <Button
              type="button" size="sm" variant="outline" className="h-7 w-full" data-slot="context-compact"
              disabled={compact.pending || compact.busy} onClick={() => void compact.onCompact()}
            >
              {compact.pending ? <><Loader2 className="size-3.5 animate-spin" />Compacting…</> : "Compact"}
            </Button>
          </span>
        )}
        {compact?.error && <div className="mt-1 text-destructive" role="alert" data-slot="context-compact-error">{compact.error}</div>}
      </PopoverContent>
    </Popover>
  );
}
