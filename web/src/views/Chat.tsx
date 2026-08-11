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
import { followUp, refresh, type Row } from "../store";
import { agentLabel, groupSteps } from "../../../shared/agent";
import { ChatComposer } from "@/components/ChatComposer";

// How close to the bottom still counts as "following". A few pixels of slack absorbs sub-pixel
// rounding and the composer resizing, so following doesn't switch off on its own.
const FOLLOW_SLACK = 48;

// How often the in-flight turn is tailed. Fast enough to read as live; an idle modal makes no
// request at all, because there is nothing running to ask about.
const TAIL_MS = 1_000;

/** One recorded step of the agent's run. Text reads as the agent talking; thinking is dimmed and
 *  italic; a tool call is a collapsed `⏵ Running: bun test` that expands to its full input and
 *  output. Collapsed-by-default is what keeps a 200-step run readable — the CLI does the same. */
function Step({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  if (step.kind === "text") return <p className="whitespace-pre-wrap break-words text-neutral-300">{step.text}</p>;
  if (step.kind === "thinking") return <p className="whitespace-pre-wrap break-words italic text-neutral-500">{step.text}</p>;
  // A tool call carries its own result (see groupSteps), so EVERYTHING it produced is behind this
  // one toggle — input and output. Nothing spills into the log unopened; the narration above is the
  // readable thread, and a tool's detail is there when you want it.
  const body = [step.detail, step.output].filter(Boolean).join("\n\n");
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

/** The agent's recorded steps for a turn. Shown in FULL by default, live or finished — the whole
 *  point is reading the conversation the way you would in the terminal, so hiding it behind a toggle
 *  (as this first did) defeats it. The toggle stays, to fold a long run away once you're done with
 *  it. */
function Steps({ steps: raw, live }: { steps: AgentStep[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  const steps = groupSteps(raw); // fold each tool result into its call — one toggle per tool use
  if (!steps.length) return null;
  const body = <div className="space-y-1">{steps.map((s, i) => <Step key={i} step={s} />)}</div>;
  if (live) return body;
  return (
    <div className="mb-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[10px] tracking-widest text-neutral-500 uppercase hover:text-neutral-300">
        {open ? "⏷" : "⏵"} {steps.length} step{steps.length === 1 ? "" : "s"}
      </button>
      {open && <div className="mt-1 border-l border-neutral-800 pl-2">{body}</div>}
    </div>
  );
}

/** A completed turn's agent output. Structured outcomes render as labelled sections; anything else is
 *  the raw final message as monospace text. Terminal palette, so it reads on the dark window. */
function Output({ turn }: { turn: AgentTurn }) {
  if (turn.failed) return <pre className="whitespace-pre-wrap break-words text-red-400">{turn.response || "exited without output"}</pre>;
  // Stopped is amber, not red: you interrupted it, the work so far stands, and the session is still
  // resumable — replying in the composer redirects it rather than starting over.
  if (turn.stopped) return <pre className="whitespace-pre-wrap break-words text-amber-400">{turn.response || "Stopped."}</pre>;
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
          {agentLabel(turn.provider)}{turn.failed ? " · failed" : turn.stopped ? " · stopped by you" : ""}
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
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true); // at the bottom → keep following; scrolled up → leave the reader be
  const turnsRef = useRef<AgentTurn[] | null>(null); // read by the tail without re-arming it
  const cursors = useRef(new Map<string, number>()); // per-run high-water mark of steps we hold
  const running = row.agentStatus === "running";

  // The conversation loads once, then the in-flight turn is TAILED: one small request a second for
  // whatever steps have been recorded since the cursor we hold. (History: this was Server-Sent
  // Events over an in-process bus. That was a true push, but only for a run executing on this
  // instance — a run on another machine had to be tailed from the database and forwarded, so there
  // were two delivery paths and the remote one was a poll in a stream's clothing. One path that
  // behaves identically wherever the agent runs is worth the second of latency.)
  useEffect(() => {
    let live = true;
    const load = () => api.turns(row.repo, row.branch).then((t) => { if (live) setTurns(t); }).catch(() => {});
    void load();
    const timer = setInterval(async () => {
      if (!live) return;
      const pending = turnsRef.current?.find((t) => !t.finishedAt);
      if (!pending) return; // nothing running — the poll costs nothing until something is
      try {
        const cursor = cursors.current.get(pending.id) ?? pending.stepSeq ?? 0;
        const { steps, seq, finished } = await api.turnSteps(row.repo, row.branch, pending.id, cursor);
        if (!live) return;
        if (steps.length) {
          cursors.current.set(pending.id, seq);
          setTurns((prev) => prev?.map((t) => (t.id === pending.id ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
        }
        if (finished) await load(); // the outcome landed — swap "working…" for it
      } catch { /* a blip; the next tick retries */ }
    }, TAIL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [row.repo, row.branch]);

  useEffect(() => { turnsRef.current = turns; }, [turns]);

  // Follow the tail as output arrives, the way a terminal does — but only while the reader is AT the
  // bottom. Scrolling up to read something is an intent to stay there (a stream of steps yanking you
  // back down mid-read is the worst version of this), and returning to the bottom resumes following.
  // Keyed on `turns` itself, not its length, so appended steps scroll too.
  useEffect(() => {
    if (follow.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns]);
  const [stopping, setStopping] = useState(false);
  // Stop, not Discard: kills the process but keeps the worktree, its commits, and the provider
  // session, so the next message resumes the same conversation and steers it somewhere else.
  const onStop = async () => {
    if (!row.worktreePath) return;
    setStopping(true);
    try {
      await api.stopAgent(row.worktreePath);
      await refresh(); // the card's running state drives this button and the composer's placeholder
    } finally {
      setStopping(false);
    }
  };
  const onScroll = () => {
    const el = scroller.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs leading-relaxed text-neutral-200"
      >
        {running && (
          <div className="sticky top-0 z-10 -mt-1 mb-2 flex justify-end">
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="rounded border border-amber-800 bg-neutral-950/90 px-2 py-0.5 text-[11px] text-amber-400 hover:border-amber-600 hover:text-amber-300 disabled:opacity-50"
              title="Interrupt this run. The worktree, its commits, and the session are kept — reply below to redirect it."
            >
              {stopping ? "stopping…" : "■ stop"}
            </button>
          </div>
        )}
        {turns === null ? <p className="text-neutral-500">Loading conversation…</p>
          : turns.length === 0 ? <p className="text-neutral-500">No history yet for <span className="text-neutral-300">{row.branch}</span>. Send a message below to start.</p>
          : turns.map((turn) => <Turn key={turn.id} turn={turn} />)}
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
