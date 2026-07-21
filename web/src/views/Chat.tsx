// The conversation with a branch's agent, read from the bridge's durable store (GET /api/turns).
//
// Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every board
// action uses, and tmux remains the interactive lane. What this adds is the missing half: until now
// the turns were recorded and never rendered anywhere, so the detail view showed only the LATEST
// run's prompt and final blob, and every earlier exchange was invisible.
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AgentTurn } from "../../../shared/agent";
import { api } from "../api";
import { followUp, type Row } from "../store";
import { agentLabel } from "../../../shared/agent";
import { ChatComposer } from "@/components/ChatComposer";
import { Markdown } from "./PrDetail";

/** A completed turn's response is the raw final message. When the agent honoured the outcome
 *  contract we already have it parsed, so show the sections instead of re-rendering the markdown
 *  blob — it's the same information without the headings the contract asked for. */
function Outcome({ turn }: { turn: AgentTurn }) {
  const s = turn.structured;
  if (!s) return <Markdown>{turn.response || "_No final response._"}</Markdown>;
  return (
    <div className="space-y-2">
      {s.outcome && <Markdown>{s.outcome}</Markdown>}
      {s.remaining.length > 0 && <Facet title="Remaining" items={s.remaining} tone="text-amber-600 dark:text-amber-400" />}
      {s.decisions.length > 0 && <Facet title="Decisions" items={s.decisions} />}
      {s.verification.length > 0 && <Facet title="Verification" items={s.verification} />}
      {s.commits.length > 0 && <Facet title="Commits" items={s.commits} mono />}
    </div>
  );
}

const Facet = ({ title, items, tone, mono }: { title: string; items: string[]; tone?: string; mono?: boolean }) => (
  <div>
    <h4 className={`text-[10px] font-semibold tracking-widest uppercase ${tone ?? "text-muted-foreground"}`}>{title}</h4>
    <ul className={`mt-0.5 space-y-0.5 text-sm ${mono ? "font-mono text-xs" : ""}`}>
      {items.map((v, i) => <li key={i} className="flex gap-1.5"><span className="text-muted-foreground">·</span><span className="min-w-0 break-words">{v}</span></li>)}
    </ul>
  </div>
);

export function ChatPanel({ row }: { row: Row }) {
  const [turns, setTurns] = useState<AgentTurn[] | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const running = row.agentStatus === "running";

  // Refetch while a run is in flight so its turn flips from in-progress to its outcome in place.
  useEffect(() => {
    let live = true;
    const load = () => void api.turns(row.repo, row.branch).then((t) => { if (live) setTurns(t); }).catch(() => {});
    load();
    if (!running) return () => { live = false; };
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [row.repo, row.branch, running]);

  // Follow the tail as turns arrive, the way a chat log should.
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [turns?.length, running]);

  return (
    <div className="space-y-4">
      {turns === null ? <p className="text-muted-foreground text-sm">Loading conversation…</p>
        : turns.length === 0 ? <p className="text-muted-foreground text-sm">No turns yet for <code>{row.branch}</code>.</p>
        : (
          <ol className="space-y-5">
            {turns.map((turn) => <Turn key={turn.id} turn={turn} />)}
          </ol>
        )}
      <div ref={bottom} />
      <ChatComposer
        persistKey={`orca.chat.${row.repo}::${row.branch}`}
        placeholder={running ? "The agent is working — queue the next instruction…" : `Reply to ${agentLabel(row.agentProvider ?? "claude")}…`}
        history={row.followUps}
        onSubmit={async (text, images) => {
          await followUp(row, text, images);
          setTurns(await api.turns(row.repo, row.branch).catch(() => turns ?? []));
        }}
      />
    </div>
  );
}

function Turn({ turn }: { turn: AgentTurn }) {
  const pending = !turn.finishedAt;
  return (
    <li className="space-y-2">
      <div className="bg-muted/60 ml-auto w-fit max-w-[85%] rounded-md px-3 py-2">
        <p className="text-sm whitespace-pre-wrap">{turn.prompt}</p>
      </div>
      <div className="space-y-1">
        <div className="text-muted-foreground flex items-center gap-2 text-[10px] font-semibold tracking-widest uppercase">
          {agentLabel(turn.provider)}
          {turn.failed && <span className="text-destructive">failed</span>}
          {pending && <Loader2 className="size-3 animate-spin" />}
        </div>
        {pending
          // A turn is written at launch, so an interrupted run (bridge restart, kill) stays visible
          // as an unfinished exchange rather than vanishing the way it used to.
          ? <p className="text-muted-foreground text-sm italic">Working…</p>
          : <div className={turn.failed ? "text-destructive text-sm whitespace-pre-wrap" : ""}>
              {turn.failed ? turn.response : <Outcome turn={turn} />}
            </div>}
      </div>
    </li>
  );
}
