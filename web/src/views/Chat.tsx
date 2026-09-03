// The conversation with a branch's agent, rendered as a terminal-style log: the durable turns from
// the bridge's store (GET /api/turns) shown in a dark monospace window, with the follow-up composer
// below to send the next message. It is NOT a live shell — it renders the turns Orca already records,
// styled like a terminal. Opened from the card's terminal button (see TerminalDialog); the old
// detail-page Chat tab is gone.
//
// Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every board
// action uses.
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentStep, AgentTurn } from "../../../shared/agent";
import { api, type QueuedMessage } from "../api";
import { followUp, refresh, type Row } from "../store";
import { promptInstruction } from "../workstream";
import { toolDetail, toolLabel } from "../steps";
import { agentLabel, groupSteps, withoutFinalEcho } from "../../../shared/agent";
import { ChatComposer } from "@/components/ChatComposer";

// How close to the bottom still counts as "following". A few pixels of slack absorbs sub-pixel
// rounding and the composer resizing, so following doesn't switch off on its own.
const FOLLOW_SLACK = 48;

/** Markdown inside the terminal-styled log: prose spacing and readable lists, but sized and coloured
 *  to sit in the dark window rather than looking like a pasted document. */
const ChatMarkdown = ({ children }: { children: string }) => (
  <div className="prose prose-invert prose-sm max-w-none text-neutral-300
    prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-neutral-200
    prose-li:my-0.5 prose-ul:my-1 prose-ol:my-1
    prose-code:text-sky-300 prose-code:before:content-none prose-code:after:content-none
    prose-pre:bg-neutral-900 prose-pre:text-[11px] prose-a:text-sky-400">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);

/** One recorded step of the agent's run. Text reads as the agent talking; thinking is dimmed and
 *  italic; a tool call is a collapsed `⏵ Running: bun test` that expands to its full input and
 *  output. Collapsed-by-default is what keeps a 200-step run readable — the CLI does the same. The
 *  one exception is a call still in flight on a live run: it's open while its input is what there is
 *  to watch, and folds itself the moment its result lands. A click overrides either way. */
function Step({ step, live }: { step: AgentStep; live: boolean }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (live && !step.done);
  // The agent's narration is prose — headings, lists, the occasional table — and reading a scoping
  // report in a monospace block is miserable. Tool output below stays monospace, because that one
  // genuinely is terminal output.
  if (step.kind === "text") return <ChatMarkdown>{step.text ?? ""}</ChatMarkdown>;
  if (step.kind === "thinking") return <div className="italic opacity-70"><ChatMarkdown>{step.text ?? ""}</ChatMarkdown></div>;
  // A tool call carries its own result (see groupSteps), so EVERYTHING it produced is behind this
  // one toggle — input and output. Nothing spills into the log unopened; the narration above is the
  // readable thread, and a tool's detail is there when you want it.
  const body = [toolDetail(step), step.output].filter(Boolean).join("\n\n");
  return (
    <div>
      <button
        type="button"
        onClick={() => setToggled(!open)}
        disabled={!body}
        className={`flex w-full gap-1.5 text-left ${step.isError ? "text-red-400" : "text-sky-400"} ${body ? "hover:text-sky-300" : "cursor-default"}`}
      >
        <span className="shrink-0 select-none">{body ? (open ? "⏷" : "⏵") : "·"}</span>
        <span className="min-w-0 break-words">{toolLabel(step)}{live && !step.done ? "…" : ""}</span>
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
  const body = <div className="space-y-1">{steps.map((s, i) => <Step key={i} step={s} live={live} />)}</div>;
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
  if (!s) return <ChatMarkdown>{turn.response || "_(no output)_"}</ChatMarkdown>;
  return (
    <div className="space-y-1.5 text-neutral-300">
      {s.outcome && <ChatMarkdown>{s.outcome}</ChatMarkdown>}
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

/** An instruction typed while the agent was working. It hasn't been sent yet — shown so it's visibly
 *  waiting rather than silently in limbo, and cancellable while it still is. */
function Queued({ message, onCancel }: { message: QueuedMessage; onCancel: () => void }) {
  return (
    <div className="mb-3 opacity-60">
      <div className="flex gap-2 text-emerald-400">
        <span className="shrink-0 select-none">❯</span>
        <span className="min-w-0 whitespace-pre-wrap break-words">{message.instruction}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-4 text-[10px] tracking-widest text-neutral-500 uppercase">
        <span>queued — sends when the current run finishes</span>
        <button type="button" onClick={onCancel} className="tracking-normal text-neutral-400 normal-case hover:text-red-400">cancel</button>
      </div>
    </div>
  );
}

/** One exchange: the instruction shown as a shell command (`❯ …`), the agent's output below it. */
function Turn({ turn }: { turn: AgentTurn }) {
  const pending = !turn.finishedAt;
  return (
    <div className="mb-3">
      <div className="flex gap-2 text-emerald-400">
        <span className="shrink-0 select-none">❯</span>
        {/* What you typed, recorded with the turn. Turns from before that was stored fall back to
            trimming the scaffolding off the prompt by its known marker lines. */}
        <span className="min-w-0 whitespace-pre-wrap break-words">{turn.instruction ?? promptInstruction(turn.prompt)}</span>
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
            {/* The final message is the turn's response, rendered by Output — not twice. */}
            <Steps steps={withoutFinalEcho(turn.steps ?? [], turn.response)} live={false} />
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
  const cursors = useRef(new Map<string, number>()); // per-run high-water mark, for reconnect catch-up
  const opened = useRef(false); // first `ready` is this stream opening, not a reconnect
  const running = row.agentStatus === "running";

  // The conversation loads once, then steps are PUSHED as the agent records them — that's the
  // terminal-like feel. The stream is served by the instance that owns the repo (the bridge proxies
  // there if it isn't this one), so there is one delivery path whether the agent runs on this
  // machine or in the cloud. A dropped connection resumes from the cursor rather than refetching the
  // whole conversation.
  useEffect(() => {
    let live = true;
    const load = () => api.turns(row.repo, row.branch).then((t) => { if (live) setTurns(t); }).catch(() => {});
    void load();
    void loadQueued();

    const source = new EventSource(api.turnsStreamUrl(row.repo, row.branch));
    // A `turn` event means a run started or finished — either way the queue may have moved.
    source.addEventListener("turn", () => { void load(); void loadQueued(); });
    source.addEventListener("step", (e) => {
      const { runId, steps } = JSON.parse((e as MessageEvent).data) as { runId: string; steps: AgentStep[] };
      setTurns((prev) => prev?.map((t) => (t.id === runId ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
    });
    // `ready` fires on open AND on every automatic reconnect. The first is this stream opening; a
    // later one means we were disconnected, so catch up from the cursor — anything recorded while we
    // were away would otherwise be silently missing.
    source.addEventListener("ready", () => {
      if (!opened.current) { opened.current = true; return; }
      void (async () => {
        const pending = turnsRef.current?.find((t) => !t.finishedAt);
        if (!pending) return void load();
        try {
          const cursor = cursors.current.get(pending.id) ?? pending.stepSeq ?? 0;
          const { steps, seq, finished } = await api.turnSteps(row.repo, row.branch, pending.id, cursor);
          if (!live) return;
          if (steps.length) {
            cursors.current.set(pending.id, seq);
            setTurns((prev) => prev?.map((t) => (t.id === pending.id ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
          }
          if (finished) await load();
        } catch { void load(); }
      })();
    });
    return () => { live = false; source.close(); };
  }, [row.repo, row.branch]);

  useEffect(() => { turnsRef.current = turns; }, [turns]);

  // Follow the tail as output arrives, the way a terminal does — but only while the reader is AT the
  // bottom. Scrolling up to read something is an intent to stay there (a stream of steps yanking you
  // back down mid-read is the worst version of this), and returning to the bottom resumes following.
  // Keyed on `turns` itself, not its length, so appended steps scroll too.
  useEffect(() => {
    if (follow.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns]);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const loadQueued = () => api.queued(row.repo, row.branch).then(setQueued).catch(() => {});
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
        {queued.map((m) => (
          <Queued
            key={m.id}
            message={m}
            onCancel={() => void api.cancelQueued(row.repo, m.id).then(loadQueued)}
          />
        ))}
      </div>
      <ChatComposer
        persistKey={`orca.chat.${row.repo}::${row.branch}`}
        placeholder={running ? "The agent is working — queue the next instruction…" : `Reply to ${agentLabel(row.agentProvider ?? "claude")}…`}
        history={row.followUps}
        onSubmit={async (text, images) => {
          await followUp(row, text, images);
          setTurns(await api.turns(row.repo, row.branch).catch(() => turns ?? []));
          await loadQueued(); // it may have been held rather than launched
        }}
      />
    </div>
  );
}
