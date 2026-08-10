// The conversation with a branch's agent, rendered as a terminal-style log: the durable turns from
// the bridge's store (GET /api/turns) shown in a dark monospace window, with the follow-up composer
// below to send the next message. It is NOT a live shell — it renders the turns Orca already records,
// styled like a terminal. Opened from the card's terminal button (see TerminalDialog); the old
// detail-page Chat tab is gone.
//
// Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every board
// action uses.
import { useEffect, useRef, useState } from "react";
import type { AgentStep, AgentTurn } from "../../../shared/agent";
import { api } from "../api";
import { followUp, type Row } from "../store";
import { agentLabel } from "../../../shared/agent";
import { ChatComposer } from "@/components/ChatComposer";

/** One recorded step of the agent's run. Text reads as the agent talking; thinking is dimmed and
 *  italic; a tool call is a collapsed `⏵ Running: bun test` that expands to its full input and
 *  output. Collapsed-by-default is what keeps a 200-step run readable — the CLI does the same. */
function Step({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  if (step.kind === "text") return <p className="whitespace-pre-wrap break-words text-neutral-300">{step.text}</p>;
  if (step.kind === "thinking") return <p className="whitespace-pre-wrap break-words italic text-neutral-500">{step.text}</p>;
  // A bare result (no summary line) belongs to the tool call above it, so it renders as that call's
  // output rather than its own row.
  const body = [step.detail, step.output].filter(Boolean).join("\n\n");
  if (!step.text) {
    if (!step.output) return null;
    return (
      <pre className={`ml-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border-l-2 pl-2 text-[11px] ${step.isError ? "border-red-800 text-red-400" : "border-neutral-800 text-neutral-500"}`}>{step.output}</pre>
    );
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!body}
        className={`flex w-full gap-1.5 text-left ${step.isError ? "text-red-400" : "text-sky-400"} ${body ? "hover:text-sky-300" : "cursor-default"}`}
      >
        <span className="shrink-0 select-none">{body ? (open ? "⏷" : "⏵") : "·"}</span>
        <span className="min-w-0 break-words">{step.text}</span>
      </button>
      {open && body && (
        <pre className="ml-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border-l-2 border-neutral-800 pl-2 text-[11px] text-neutral-500">{body}</pre>
      )}
    </div>
  );
}

/** The agent's recorded steps for a turn, collapsed behind a toggle once the turn is done — a
 *  finished exchange leads with its outcome, and the reasoning is one click away. While the run is
 *  in flight the steps are always shown: that IS the live view. */
function Steps({ steps, live }: { steps: AgentStep[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  if (live) return <div className="space-y-1">{steps.map((s, i) => <Step key={i} step={s} />)}</div>;
  return (
    <div className="mb-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[10px] tracking-widest text-neutral-500 uppercase hover:text-neutral-300">
        {open ? "⏷" : "⏵"} {steps.length} step{steps.length === 1 ? "" : "s"}
      </button>
      {open && <div className="mt-1 space-y-1 border-l border-neutral-800 pl-2">{steps.map((s, i) => <Step key={i} step={s} />)}</div>}
    </div>
  );
}

/** A completed turn's agent output. Structured outcomes render as labelled sections; anything else is
 *  the raw final message as monospace text. Terminal palette, so it reads on the dark window. */
function Output({ turn }: { turn: AgentTurn }) {
  if (turn.failed) return <pre className="whitespace-pre-wrap break-words text-red-400">{turn.response || "exited without output"}</pre>;
  const s = turn.structured;
  if (!s) return <pre className="whitespace-pre-wrap break-words text-neutral-300">{turn.response || "(no output)"}</pre>;
  return (
    <div className="space-y-1.5 text-neutral-300">
      {s.outcome && <p className="whitespace-pre-wrap break-words">{s.outcome}</p>}
      {s.remaining.length > 0 && <Facet title="Remaining" items={s.remaining} tone="text-amber-400" />}
      {s.decisions.length > 0 && <Facet title="Decisions" items={s.decisions} tone="text-neutral-400" />}
      {s.verification.length > 0 && <Facet title="Verification" items={s.verification} tone="text-neutral-400" />}
      {s.commits.length > 0 && <Facet title="Commits" items={s.commits} tone="text-sky-400" />}
    </div>
  );
}

const Facet = ({ title, items, tone }: { title: string; items: string[]; tone: string }) => (
  <div>
    <div className={`text-[10px] tracking-widest uppercase ${tone}`}>{title}</div>
    <ul className="space-y-0.5">
      {items.map((v, i) => <li key={i} className="break-words">· {v}</li>)}
    </ul>
  </div>
);

/** One exchange: the instruction shown as a shell command (`❯ …`), the agent's output below it. */
function Turn({ turn }: { turn: AgentTurn }) {
  const pending = !turn.finishedAt;
  return (
    <div className="mb-3">
      <div className="flex gap-2 text-emerald-400">
        <span className="shrink-0 select-none">❯</span>
        <span className="min-w-0 whitespace-pre-wrap break-words">{turn.prompt}</span>
      </div>
      <div className="mt-1 pl-4">
        <div className="text-[10px] tracking-widest text-neutral-500 uppercase">
          {agentLabel(turn.provider)}{turn.failed ? " · failed" : ""}
        </div>
        {/* A turn is written at launch, so an interrupted run (bridge restart, kill) stays visible as
            an unfinished exchange rather than vanishing. */}
        {pending ? (
          <div className="space-y-1 text-neutral-500">
            {/* The run's steps as they land — this is the live view. A turn with none yet (a
                non-claude provider, or the first seconds) still shows the cursor. */}
            <Steps steps={turn.steps ?? []} live />
            <span>▋ working…</span>
          </div>
        ) : (
          <>
            <Steps steps={turn.steps ?? []} live={false} />
            <Output turn={turn} />
          </>
        )}
      </div>
    </div>
  );
}

export function ChatPanel({ row }: { row: Row }) {
  const [turns, setTurns] = useState<AgentTurn[] | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const running = row.agentStatus === "running";

  // Refetch while a run is in flight so its turn flips from "working…" to its output in place.
  useEffect(() => {
    let live = true;
    const load = () => void api.turns(row.repo, row.branch).then((t) => { if (live) setTurns(t); }).catch(() => {});
    load();
    if (!running) return () => { live = false; };
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [row.repo, row.branch, running]);

  // Follow the tail as turns arrive, the way a terminal scrolls.
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [turns?.length, running]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs leading-relaxed text-neutral-200">
        {turns === null ? <p className="text-neutral-500">Loading conversation…</p>
          : turns.length === 0 ? <p className="text-neutral-500">No history yet for <span className="text-neutral-300">{row.branch}</span>. Send a message below to start.</p>
          : turns.map((turn) => <Turn key={turn.id} turn={turn} />)}
        <div ref={bottom} />
      </div>
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
