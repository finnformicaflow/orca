// The conversation with a branch's agent, rendered as a terminal-style log: the durable turns from
// the bridge's store (GET /api/turns) shown in a dark monospace window, with the follow-up composer
// below to send the next message. It is NOT a live shell — it renders the turns Orca already records,
// styled like a terminal. Opened from the card's terminal button (see TerminalDialog); the old
// detail-page Chat tab is gone.
//
// Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every board
// action uses.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Bot, ChevronRight, Cog, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentStep, AgentTurn } from "../../../shared/agent";
import { api, type QueuedMessage } from "../api";
import { followUp, modelFor, refresh, setCardModel, type Row } from "../store";
import { modelLabel } from "../../../shared/models";
import { RECENT_FULL, TAIL_WINDOW, TURN_PAGE_SIZE, WORKER_EVENT_MARKER, agentsMarker, attachmentRefs, isImageName, withoutAttachmentList, type AttachmentRef, anchoredScrollTop, capWindow, chatItems, longMessage, splitMessages, longReply, revealAbove, revealBelow, windowRange, type TurnWindow, asTurnPage, atBottom, dayLabel, isWorkerEvent, mergeLatestPage, prependOlderPage, promptInstruction, sameDay } from "../workstream";
import { toolDetail, toolLabel } from "../steps";
import { agentLabel, groupSteps, withoutFinalEcho } from "../../../shared/agent";
import { ChatComposer } from "@/components/ChatComposer";
import { subscribeTurns } from "@/lib/events";
import { ChatControls, type ChatControlsProps } from "@/components/ChatControls";
import type { OrchestratorPrefill } from "@/lib/atoms";

// How close to the bottom still counts as "following". A few pixels of slack absorbs sub-pixel
// rounding and the composer resizing, so following doesn't switch off on its own.
const FOLLOW_SLACK = 48;
// How close to the top (px) fetches the next older page.
const OLDER_THRESHOLD = 160;

/** Placeholder lines sized like a turn, while a page is in flight — nothing shifts when it lands. */
const ChatSkeleton = ({ rows }: { rows: number }) => (
  <div className="w-full animate-pulse space-y-3" data-slot="chat-skeleton" aria-hidden="true">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="space-y-1.5">
        <div className="h-3 w-2/5 rounded bg-neutral-800" />
        <div className="h-3 w-4/5 rounded bg-neutral-800/70" />
        <div className="h-3 w-3/5 rounded bg-neutral-800/50" />
      </div>
    ))}
  </div>
);

/** Markdown inside the terminal-styled log: prose spacing and readable lists, but sized and coloured
 *  to sit in the dark window rather than looking like a pasted document. */
const ChatMarkdown = ({ children }: { children: string }) => (
  // wrap-anywhere: the agent's prose is full of unbreakable tokens (`branch/names-with-hashes`,
  // paths, run ids) that are wider than a narrow window, and one of them made the whole log scroll
  // sideways. Code BLOCKS are exempt — they keep their lines and scroll inside themselves.
  <div className="prose prose-invert prose-sm max-w-none wrap-anywhere text-neutral-300 prose-pre:wrap-normal
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
        <pre className="ml-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border-l border-neutral-800 pl-2 text-[11px] text-neutral-500">{body}</pre>
      )}
    </div>
  );
}

/** The agent's recorded steps for a turn. Shown in FULL while the run is live — that's the terminal
 *  feel, watching it work — and folded to a `⏵ 127 steps` line once it has answered: the answer is
 *  what a finished turn is about, and a long run's trail belongs behind a toggle until you go looking
 *  for how it got there. (It was open by default once; with a hundred-step run above every answer,
 *  the conversation was unreadable.) */
function Steps({ steps: raw, live, load }: { steps: AgentStep[]; live: boolean; load?: () => Promise<AgentStep[]> }) {
  const [open, setOpen] = useState(false);
  // An older turn arrives without its steps (the bridge sends them for the newest turns only);
  // they are fetched the first time it is unfolded.
  const [fetched, setFetched] = useState<AgentStep[] | null>(null);
  const steps = groupSteps(fetched ?? raw); // fold each tool result into its call — one toggle per tool use
  if (!steps.length && !load) return null;
  if (!steps.length && load && !fetched) {
    return (
      <div className="mb-1.5">
        <button type="button" onClick={() => { void load().then((s) => { setFetched(s); setOpen(true); }); }} className="text-[10px] tracking-widest text-neutral-500 uppercase hover:text-neutral-300">⏵ steps</button>
      </div>
    );
  }
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

/** The files a message carried: a thumbnail for an image, a named chip for anything else. Each opens
 *  the stored file from the bridge (`/api/attachments/<id>`, read from Postgres), so it works from
 *  any instance, whichever one took the upload. */
export function Attachments({ files, className = "" }: { files: AttachmentRef[]; className?: string }) {
  if (!files.length) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`} data-slot="message-attachments">
      {files.map((f) => {
        const href = `/api/attachments/${f.id}`;
        return isImageName(f.name) ? (
          <a key={f.id} href={href} target="_blank" rel="noreferrer" title={f.name} data-slot="attachment-image">
            <img src={href} alt={f.name} loading="lazy" className="max-h-32 max-w-48 rounded-md border object-cover" />
          </a>
        ) : (
          <a key={f.id} href={href} target="_blank" rel="noreferrer" title={f.name} data-slot="attachment-file"
            className="bg-muted text-foreground hover:bg-accent inline-flex max-w-56 items-center gap-1 rounded-md border px-2 py-1 text-[11px]">
            <Paperclip className="size-3 shrink-0" /><span className="truncate">{f.name}</span>
          </a>
        );
      })}
    </div>
  );
}

/** An instruction typed while the agent was working. It hasn't been sent yet — shown so it's visibly
 *  waiting rather than silently in limbo, and cancellable while it still is. */
function Queued({ message, onCancel }: { message: QueuedMessage; onCancel: () => void }) {
  // A worker report waiting for the batch (or your next message) is a system line, like a delivered one.
  if (isWorkerEvent(message.instruction)) {
    return (
      <div className="mb-1 text-neutral-500" data-slot="worker-report-held">
        ⚙ {message.instruction.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim()}
        <span className="ml-2 text-[10px] tracking-widest uppercase">held for the batch</span>
      </div>
    );
  }
  return (
    <div className="mb-3 opacity-60">
      <div className="flex gap-2 text-emerald-400">
        <span className="shrink-0 select-none">❯</span>
        <span className="min-w-0 whitespace-pre-wrap break-words">{withoutAttachmentList(message.instruction)}</span>
      </div>
      <Attachments files={attachmentRefs((message.attachments ?? []).join("\n"))} className="mt-1 pl-4" />
      <div className="mt-1 flex items-center gap-2 pl-4 text-[10px] tracking-widest text-neutral-500 uppercase">
        <span>queued — sends when the current run finishes</span>
        <button type="button" onClick={onCancel} className="tracking-normal text-neutral-400 normal-case hover:text-red-400">cancel</button>
      </div>
    </div>
  );
}

/** The orchestrator's wake messages that were worker reports, not something you typed: each shown
 *  as one muted system line (what finished, how), with the full report behind a toggle. Only when
 *  EVERY part of the instruction is a report — a wake that also carried your message stays a prompt. */
function WorkerReports({ parts }: { parts: string[] }) {
  return (
    <div data-slot="worker-reports" className="space-y-0.5 text-neutral-500">
      {parts.map((part, i) => (
        <details key={i}>
          <summary className="cursor-pointer select-none">⚙ {part.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim()}</summary>
          <pre className="mt-1 ml-4 whitespace-pre-wrap break-words text-neutral-600">{part.split("\n").slice(1).join("\n")}</pre>
        </details>
      ))}
    </div>
  );
}

/** One exchange: the instruction shown as a shell command (`❯ …`), the agent's output below it. */
const stampOf = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

/** Orca's verification of the commit — deterministic evidence, shown apart from the agent's own
 *  Verification section. Output folds like a tool result. */
const CheckVerdict = ({ check }: { check: NonNullable<AgentTurn["check"]> }) => (
  <details className={`mt-1 ${check.ok ? "text-emerald-400" : "text-red-400"}`} data-slot="turn-check">
    <summary className="cursor-pointer select-none">
      {check.ok ? "✓" : "✗"} {check.command} {check.ok ? "passed" : `failed (exit ${check.exitCode})`}
    </summary>
    <pre className="mt-1 whitespace-pre-wrap break-words text-neutral-400">{check.output || "(no output)"}</pre>
  </details>
);

/** Each running turn's streamed reply text, by run id (ChatPanel's `drafts`) — a context, so it reaches
 *  the reply under either styling without threading through every turn component. */
const DraftContext = createContext<Record<string, string>>({});
const omit = (d: Record<string, string>, ...ids: string[]) => {
  const next = { ...d };
  for (const id of ids) delete next[id];
  return next;
};

/** The agent's side of a turn — live steps and the cursor while it runs; folded steps, the output and
 *  Orca's check once it has answered. Shared by both stylings. */
function Reply({ turn, loadSteps, compact }: { turn: AgentTurn; loadSteps?: () => Promise<AgentStep[]>; compact?: boolean }) {
  const draft = useContext(DraftContext)[turn.id];
  // A turn is written at launch, so an interrupted run (bridge restart, kill) stays visible as an
  // unfinished exchange rather than vanishing.
  if (!turn.finishedAt) {
    return (
      <div className="space-y-1 text-neutral-500">
        {/* The run's steps as they land — this is the live view. A turn with none yet (a non-claude
            provider, or the first seconds) still shows the cursor. */}
        <Steps steps={turn.steps ?? []} live />
        {/* The message being written, as it streams — replaced by its step once it is whole. */}
        {draft && <div className="text-neutral-200 whitespace-pre-wrap break-words" data-slot="turn-draft">{draft}</div>}
        <span>▋ {draft ? "" : "working…"}</span>
      </div>
    );
  }
  return (
    <>
      {/* The final message is the turn's response, rendered by Output — not twice. */}
      <Steps steps={withoutFinalEcho(turn.steps ?? [], turn.response)} live={false} load={turn.steps ? undefined : loadSteps} />
      {/* An old turn (compact) shows its answer's first lines; the steps toggle above stays outside. */}
      <Clamp on={Boolean(compact && longReply(turn))}><Output turn={turn} /></Clamp>
      {turn.check && <CheckVerdict check={turn.check} />}
    </>
  );
}

const clockOf = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");

/** The "chat" styling (the orchestrator's panel): a modern assistant chat rather than a terminal log.
 *  What you said is a tinted bubble on the right; the orchestrator answers on the left under its
 *  name, in readable prose; its tool steps and worker reports stay folded; the time shows on hover
 *  (and days are grouped by the divider ChatPanel draws). Colours are the theme's tokens, so it
 *  follows light and dark like the rest of the console. */
function ChatTurn({ turn, loadSteps, compact }: { turn: AgentTurn; loadSteps?: () => Promise<AgentStep[]>; compact?: boolean }) {
  const parts = splitMessages(turn.instruction ?? promptInstruction(turn.prompt));
  // A wake that carried your messages AND worker reports: your words in bubbles — one per message you
  // sent, however many one wake drained — and the reports folded.
  const reports = parts.filter(isWorkerEvent), said = parts.filter((p) => !isWorkerEvent(p));
  // Each message's files: an orchestrator wake carries their references in the instruction (one set
  // per message); an agent chat's instruction is the typed text alone, its files read off the prompt.
  const inline = attachmentRefs(turn.instruction ?? "").length > 0;
  const filesOf = (text: string, i: number) => inline ? attachmentRefs(text) : i === said.length - 1 ? turn.attachments ?? [] : [];
  const time = clockOf(turn.startedAt);
  return (
    <div className="mb-4" data-slot="chat-turn" data-failed={turn.failed || undefined} data-style="chat">
      {/* Worker reports that woke it, split out of what you said: a collapsed block of their own. */}
      {reports.length > 0 && (
        <WorkerBlock slot="turn-reports" className="mb-2"
          label={reports.length === 1 ? `Worker report · ${reportTitle(reports[0]!)}` : `${reports.length} worker reports`}>
          <WorkerReports parts={reports} />
        </WorkerBlock>
      )}
      {said.map((text, i) => (
        <div key={i} className="group mb-2 flex justify-end" data-slot="chat-user">
          <div className="max-w-[85%]">
            {withoutAttachmentList(text) && <div className="bg-accent text-foreground rounded-lg px-3 py-2 whitespace-pre-wrap break-words">
              {/* A long message is cut to its first lines, like an old reply. */}
              <Clamp on={longMessage(withoutAttachmentList(text))} cut="max-h-[9rem]">{withoutAttachmentList(text)}</Clamp>
            </div>}
            <Attachments files={filesOf(text, i)} className="mt-1 justify-end" />
            {i === said.length - 1 && <div className="text-muted-foreground mt-0.5 text-right text-[10px] opacity-0 transition-opacity group-hover:opacity-100" data-slot="turn-time">{time}</div>}
          </div>
        </div>
      ))}
      <div className="group flex gap-2" data-slot="chat-reply">
        <span className="bg-accent text-foreground mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full" aria-hidden="true"><Bot className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground mb-0.5 flex items-baseline gap-2 text-[11px]">
            <span className="text-foreground font-medium">Orchestrator</span>
            {turn.failed ? <span className="text-red-400">failed</span> : turn.stopped ? <span className="text-amber-400">stopped by you</span> : null}
            <span className="opacity-0 transition-opacity group-hover:opacity-100" data-slot="turn-time">{clockOf(turn.finishedAt) || time}</span>
          </div>
          <Reply turn={turn} loadSteps={loadSteps} compact={compact} />
        </div>
      </div>
    </div>
  );
}

/** An old turn's reply, cut to its first lines with a Show more — the history reads as a list of
 *  exchanges, not a wall of past answers. The newest RECENT_FULL turns always render in full. */
function Clamp({ on, children, cut = "max-h-[4.5rem]" }: { on: boolean; children: React.ReactNode; cut?: string }) {
  const [open, setOpen] = useState(false);
  if (!on) return <>{children}</>;
  return (
    <div data-slot="turn-clamp" data-open={open || undefined}>
      <div className={open ? "" : cn(cut, "overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]")}>{children}</div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-muted-foreground hover:text-foreground mt-0.5 text-[11px]">
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

const reportTitle = (report: string) => report.split("\n")[0]!.slice(WORKER_EVENT_MARKER.length).trim();

/** Worker traffic in the orchestrator's chat, split out of your conversation: its own tinted card,
 *  collapsed to one ⚙ line by default, opening in place. */
function WorkerBlock({ label, slot, className, children }: { label: string; slot: string; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-slot={slot} data-open={open || undefined} className={cn("border-geist-blue/20 bg-geist-blue/5 rounded-md border text-[12px]", className)}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Cog className="text-geist-blue size-3.5 shrink-0" />
        <span className="min-w-0 truncate" data-slot="worker-block-label">{label}</span>
      </button>
      {open && <div className="border-geist-blue/20 border-t px-2.5 pt-2">{children}</div>}
    </div>
  );
}

/** A run of worker-driven turns (reports in, its replies out, nothing you said) as ONE collapsed
 *  block — "3 worker reports · 2 replies" — that opens to the turns, so you know they happened
 *  without the bulk. */
function AgentsMarker({ turns, render }: { turns: AgentTurn[]; render: (t: AgentTurn) => React.ReactNode }) {
  const span = [clockOf(turns[0]!.startedAt), clockOf(turns[turns.length - 1]!.finishedAt)].filter(Boolean).join("–");
  return (
    <WorkerBlock slot="agents-marker" className="mb-4" label={`${agentsMarker(turns)}${span ? ` · ${span}` : ""}`}>
      {turns.map(render)}
    </WorkerBlock>
  );
}

/** `stamped`: the Agent page's log mode — a time gutter, and failed / warned turns tinted the way
 *  Vercel tints error and warning lines in Build Logs. */
function Turn({ turn, loadSteps, stamped }: { turn: AgentTurn; loadSteps?: () => Promise<AgentStep[]>; stamped?: boolean }) {
  const instruction = turn.instruction ?? promptInstruction(turn.prompt);
  // The reference list is shown as chips (below), not as text.
  const parts = splitMessages(instruction).map(withoutAttachmentList);
  const tint = !stamped ? "" : turn.failed ? "bg-red-500/10 -mx-3 px-3" : turn.stopped || (turn.check && !turn.check.ok) ? "bg-amber-500/10 -mx-3 px-3" : "";
  const body = (
    <div className={`mb-3 ${tint}`} data-slot="chat-turn" data-failed={turn.failed || undefined}>
      {parts.every(isWorkerEvent) ? <WorkerReports parts={parts} /> : (
        // What you typed, recorded with the turn — one ❯ line per message a wake carried. Turns from
        // before that was stored fall back to trimming the scaffolding off the prompt by its marker lines.
        <>{parts.map((text, i) => (
          <div key={i} className="flex gap-2 text-emerald-400" data-slot="turn-instruction">
            <span className="shrink-0 select-none">❯</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
          </div>
        ))}</>
      )}
      <Attachments files={turn.attachments ?? []} className="mt-1 pl-4" />
      <div className="mt-1 pl-4">
        <div className="text-[10px] tracking-widest text-neutral-500 uppercase">
          {agentLabel(turn.provider)}{turn.failed ? " · failed" : turn.stopped ? " · stopped by you" : ""}
        </div>
        <Reply turn={turn} loadSteps={loadSteps} />
      </div>
    </div>
  );
  if (!stamped) return body;
  return (
    <div className="flex gap-3">
      {/* Sticky within THIS turn's own row (its flex parent is the containing block a sticky element
       *  can't escape): pinned near the top of the visible area while the turn's own content scrolls
       *  past, then pushed out once the row ends and the next turn's timestamp takes over — the same
       *  idiom as a sticky first column in a tall table row. `top-7` clears the running/stop banner's
       *  own sticky bar above (`top-0`), so the two are never stuck in the same place at once;
       *  `self-start` + a background keep the stuck box to one line, never a tall strip that could
       *  sit over the reply text beside it. */}
      <span className="sticky top-7 z-[1] w-16 shrink-0 self-start bg-neutral-950 pt-px text-neutral-500 tabular-nums select-none" data-slot="turn-time">{stampOf(turn.startedAt)}</span>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}

/** The Agent page's Chat tab reads smaller than the modal's terminal: your messages at 11px mono and
 *  the agent's replies (prose, which is 14px at prose-sm) at 12px. */
const LOG_TEXT = "font-mono text-[11px] [&_.prose]:text-[12px]";

/** `send` replaces the follow-up launch for a conversation that isn't a branch's agent — the
 *  orchestrator's, which goes to its own route. `flush` is for a host that IS the window (the
 *  orchestrator's popout): the log runs edge to edge with no frame of its own, and the composer sits
 *  on the SAME terminal background, so the window reads as one surface rather than a log with a
 *  differently coloured strip under it. The composer's toolbar always carries the model picker and
 *  the context ring (ChatControls); `controls` supplies their values when they don't come from the
 *  row's card. Everything else about the panel is the same. */
export function ChatPanel({ row, send, flush, controls, logBar, prefill, variant = "terminal" }: {
  row: Row; send?: (text: string, images: File[]) => Promise<void>; flush?: boolean; controls?: ChatControlsProps;
  /** "terminal" (default): the dark monospace log. "chat": the orchestrator panel's assistant-chat
   *  styling — bubbles, prose, day dividers, hover timestamps — in the page's theme (see ChatTurn). */
  variant?: "terminal" | "chat";
  /** Text for the composer from outside it (the orchestrator's entry) — see ChatComposer. */
  prefill?: OrchestratorPrefill | null;
  /** The Agent page's Chat tab: a slim toolbar (working indicator, error / warning counters, Find
   *  in chat) instead of a card header, and timestamped, tinted turns. */
  logBar?: boolean;
}) {
  const deliver = send ?? ((text: string, images: File[]) => followUp(row, text, images));
  // Messages on their way to the bridge. Sending one launches an agent — an upload, a worktree
  // lookup, the board snapshot the orchestrator is handed — which takes seconds, and a log that
  // shows nothing until then reads as "it didn't go". So the message is drawn at once and replaced
  // by the real turn (or queued entry) when the bridge answers; on failure it is withdrawn and the
  // composer puts the text back.
  const [sending, setSending] = useState<{ id: number; text: string }[]>([]);
  const sendSeq = useRef(0);
  const submit = async (text: string, images: File[]) => {
    const id = ++sendSeq.current;
    follow.current = true; // you just spoke: jump to it, wherever you had scrolled
    setSending((s) => [...s, { id, text }]);
    try {
      await deliver(text, images);
      await loadLatest();
      await loadQueued(); // it may have been held rather than launched
    } finally {
      setSending((s) => s.filter((m) => m.id !== id));
    }
  };
  // The conversation is PAGED: the newest TURN_PAGE_SIZE turns on open, and one more page each time
  // you reach the top (`older` is the cursor for it, null once the first turn is loaded). The
  // orchestrator's conversation is hundreds of turns and used to load whole — megabytes over the
  // tailnet and a long first render — to show the last few.
  const [turns, setTurns] = useState<AgentTurn[] | null>(null);
  const [older, setOlder] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true); // at the bottom → keep following; scrolled up → leave the reader be
  const [atTail, setAtTail] = useState(true); // `follow`, as state, for the jump-to-latest button
  const [unseen, setUnseen] = useState(false); // something arrived below while you were scrolled up
  const turnsRef = useRef<AgentTurn[] | null>(null); // read by the tail without re-arming it
  const olderRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const anchor = useRef<{ top: number; height: number } | null>(null); // scroll position to restore after a prepend
  // The MOUNTED window over the loaded turns (workstream.ts: CHAT_WINDOW, capWindow). Paging bounds
  // what is fetched; this bounds the DOM, so a conversation scrolled far back stays light.
  const [win, setWin] = useState<TurnWindow>(TAIL_WINDOW);
  const winRef = useRef(win);
  winRef.current = win;
  const toTail = useRef(false); // jump-to-latest: scroll down once the window is back at the tail
  const cursors = useRef(new Map<string, number>()); // per-run high-water mark, for reconnect catch-up
  const latestAsked = useRef(0), latestApplied = useRef(0); // loadLatest's request order (see there)
  // Reply text streaming in for a running turn (claude's partial messages), by run id — shown under
  // its steps until the whole message lands as a step, or the turn finishes.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const running = row.agentStatus === "running";
  /** (Re)fetch the newest page. What was already loaded above it stays; a turn the page re-delivers
   *  (now finished) takes its fresh form. The first fetch also sets where the older pages start. */
  const loadLatest = async () => {
    // The newest REQUEST wins, not the last answer: a page fetched while a run was still running can
    // answer after the one its finish triggered, and applying it put the turn back to `working…` with
    // nothing left to fetch again — the reply "only appeared once I sent another message".
    const ticket = ++latestAsked.current;
    // asTurnPage again at the render boundary: whatever answered (an older bridge sends an array),
    // nothing undefined reaches `turns`, which must be null (loading) or a list.
    const page = await api.turnPage(row.repo, row.branch, { limit: TURN_PAGE_SIZE }).then(asTurnPage<AgentTurn>).catch(() => null);
    if (!page || ticket < latestApplied.current) return;
    latestApplied.current = ticket;
    const had = turnsRef.current;
    if (!had || !had.length) { olderRef.current = page.older; setOlder(page.older); }
    // A page turn without steps (past the newest few the bridge ships them for) keeps the ones
    // already pushed or caught up, rather than folding them away.
    setTurns((prev) => {
      if (!prev) return page.turns;
      const had = new Map(prev.map((t) => [t.id, t.steps]));
      return mergeLatestPage(prev, page.turns.map((t) => (t.steps || !had.get(t.id) ? t : { ...t, steps: had.get(t.id) })));
    });
  };
  /** The page before the oldest loaded turn, put in front of it with the scroll position anchored on
   *  what you were reading (useLayoutEffect below). */
  const loadOlder = async () => {
    const before = olderRef.current;
    if (!before || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = asTurnPage<AgentTurn>(await api.turnPage(row.repo, row.branch, { limit: TURN_PAGE_SIZE, before }));
      const el = scroller.current;
      if (el) anchor.current = { top: el.scrollTop, height: el.scrollHeight };
      olderRef.current = page.older;
      setOlder(page.older);
      setTurns((prev) => prependOlderPage(page.turns, prev ?? []));
      setWin((w) => ({ ...w, first: null, dir: "up" })); // mount the page that arrived; the cap trims below
    } catch { /* the affordance stays; a scroll or click tries again */ } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };
  // Content was added ABOVE the viewport: move the scroller by the same amount, so the turn you were
  // reading doesn't jump. Layout effect: before the browser paints the shifted content.
  // The same for content REMOVED above (the window trimming its top), which moves it the other way.
  useLayoutEffect(() => {
    const a = anchor.current, el = scroller.current;
    if (a && el) {
      anchor.current = null;
      el.scrollTop = anchoredScrollTop(a.top, a.height, el.scrollHeight);
    }
    // Then hold the window to its cap — trimming one side per commit, so the anchor above stays exact:
    // the far side below needs no anchor; the top does, and is restored on the commit this causes.
    const capped = turns ? capWindow(turns, win) : null;
    if (capped) {
      if (capped.first !== win.first && el) anchor.current = { top: el.scrollTop, height: el.scrollHeight };
      setWin(capped);
    } else if (toTail.current && win.last === null && el) {
      toTail.current = false;
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [turns, win]);

  // The conversation loads once, then steps are PUSHED as the agent records them — that's the
  // terminal-like feel. They arrive on the tab's one shared stream (lib/events.ts), which carries
  // every instance's events, so there is one delivery path whether the agent runs on this machine or
  // in the cloud. An interrupted feed resumes from the cursor rather than refetching the whole
  // conversation.
  useEffect(() => {
    let live = true;
    const load = async () => { if (live) await loadLatest(); };
    void load();
    void loadQueued();

    const unsubscribe = subscribeTurns(row.repo, row.branch, {
      // A `turn` event means a run started or finished — either way the queue may have moved.
      turn: () => { void load(); void loadQueued(); },
      step: (runId, steps) => {
        // A whole message supersedes the text that streamed ahead of it.
        if (steps.some((st) => st.kind === "text")) setDrafts((d) => (runId in d ? omit(d, runId) : d));
        setTurns((prev) => prev?.map((t) => (t.id === runId ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
      },
      delta: (runId, text) => setDrafts((d) => ({ ...d, [runId]: (d[runId] ?? "") + text })),
      // We were disconnected (or the tab was hidden), so catch up from the cursor — anything
      // recorded while we were away would otherwise be silently missing.
      // The newest page is ALWAYS re-read: a turn that started or finished while we were away (or an
      // older interrupted turn sitting unfinished above it) is only visible that way.
      resync: () => void (async () => {
        const pending = turnsRef.current?.findLast((t) => !t.finishedAt);
        if (pending) {
          try {
            const cursor = cursors.current.get(pending.id) ?? pending.stepSeq ?? 0;
            const { steps, seq } = await api.turnSteps(row.repo, row.branch, pending.id, cursor);
            if (!live) return;
            if (steps.length) {
              cursors.current.set(pending.id, seq);
              setTurns((prev) => prev?.map((t) => (t.id === pending.id ? { ...t, steps: [...(t.steps ?? []), ...steps] } : t)) ?? prev);
            }
          } catch { /* the page below carries the turn's steps anyway */ }
        }
        await load();
      })(),
    });
    return () => { live = false; unsubscribe(); };
  }, [row.repo, row.branch]);

  useEffect(() => {
    turnsRef.current = turns;
    setDrafts((d) => {
      const done = Object.keys(d).filter((id) => turns?.find((t) => t.id === id)?.finishedAt);
      return done.length ? omit(d, ...done) : d;
    });
  }, [turns]);

  // Follow the tail as output arrives, the way a terminal does — but only while the reader is AT the
  // bottom. Scrolling up to read something is an intent to stay there (a stream of steps yanking you
  // back down mid-read is the worst version of this), and returning to the bottom resumes following.
  // Keyed on `turns` itself, not its length, so appended steps scroll too.
  // Not following (you scrolled up to read): nothing moves, and a jump-to-latest button appears once
  // something new has arrived below. An older page landing above is not "new".
  useEffect(() => {
    if (follow.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    else if (!anchor.current && !loadingOlderRef.current) setUnseen(true);
  }, [turns, sending]);
  const jumpToLatest = () => {
    follow.current = true;
    setAtTail(true);
    setUnseen(false);
    if (winRef.current.last !== null) { toTail.current = true; setWin(TAIL_WINDOW); return; } // remount the tail, then go there
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const loadQueued = () => api.queued(row.repo, row.branch).then(setQueued).catch(() => {});
  // The context ring's Compact button. `compacting` is the compact run's id ("" while the request is
  // in flight): pending until that turn arrives finished over the stream, then the ring is re-read.
  const [compacting, setCompacting] = useState<string | null>(null);
  const [compactError, setCompactError] = useState<string>();
  const onCompact = async () => {
    setCompactError(undefined);
    setCompacting("");
    try {
      setCompacting((await api.compact(row.repo, row.branch)).runId);
      await refresh();
    } catch (e) {
      setCompacting(null);
      setCompactError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    const done = compacting ? turns?.find((t) => t.id === compacting && t.finishedAt) : undefined;
    if (!done) return;
    setCompacting(null);
    if (done.failed) setCompactError(done.response || "Compaction failed.");
    void refresh(); // the card's ring reads the run's meta; the orchestrator's window polls its own
  }, [turns, compacting]);
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
  // Has the bridge already recorded this message — as the turn now running, or a queued entry?
  // (startsWith: attachments are appended to the instruction after the text.)
  const landed = (text: string) =>
    Boolean(turns?.some((t) => !t.finishedAt && t.instruction?.startsWith(text))) || queued.some((m) => m.instruction.startsWith(text));
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const loaded = turnsRef.current ?? [];
    const range = windowRange(loaded, winRef.current);
    const below = loaded.length - range.end; // loaded, but unmounted below the window
    // At the bottom of the WINDOW is not the tail while newer turns are unmounted below it.
    const bottom = atBottom(el.scrollTop, el.scrollHeight, el.clientHeight, FOLLOW_SLACK);
    const tail = bottom && below === 0;
    follow.current = tail;
    if (tail !== atTail) setAtTail(tail);
    if (tail) setUnseen(false);
    if (el.scrollTop < OLDER_THRESHOLD) {
      // Near the top: remount the turns above the window if they are loaded, else fetch the next page.
      if (range.start > 0) { anchor.current = { top: el.scrollTop, height: el.scrollHeight }; setWin(revealAbove(loaded, winRef.current)); }
      else if (olderRef.current) void loadOlder();
    } else if (below > 0 && atBottom(el.scrollTop, el.scrollHeight, el.clientHeight, OLDER_THRESHOLD)) {
      setWin(revealBelow(loaded, winRef.current)); // added below the viewport: nothing to anchor
    }
  };
  const showAbove = () => {
    const el = scroller.current;
    if (el) anchor.current = { top: el.scrollTop, height: el.scrollHeight };
    setWin(revealAbove(turns ?? [], win));
  };

  // Compact is offered once the ring has a reading: only a Claude session reports one, and only a
  // Claude session can be compacted.
  const ctl = controls ?? {
    model: modelFor(row), onModel: (m: string) => setCardModel(row, m), ran: row.agentMeta?.model, contextPct: row.agentMeta?.contextPct,
  };
  // Only the mounted window renders.
  const range = windowRange(turns ?? [], win);
  const hiddenAbove = range.start, hiddenBelow = (turns?.length ?? 0) - range.end;
  const shownTurns = turns?.slice(range.start, range.end) ?? null;
  // Older turns render compact (chat styling): the newest RECENT_FULL in full, the rest cut to their
  // first lines; runs of automated wakes fold into one line.
  const position = new Map((turns ?? []).map((t, i) => [t.id, i]));
  const compactBefore = (turns?.length ?? 0) - RECENT_FULL;
  const chatStyle = variant === "chat";
  const stepsOf = (turn: AgentTurn) => () => api.turnSteps(row.repo, row.branch, turn.id, 0).then((r) => withoutFinalEcho(r.steps, turn.response));
  const chatTurn = (turn: AgentTurn) => <ChatTurn key={turn.id} turn={turn} loadSteps={stepsOf(turn)} compact={(position.get(turn.id) ?? 0) < compactBefore} />;
  const renderTurns = (list: AgentTurn[]) => {
    if (!chatStyle) return list.map((turn) => <Turn key={turn.id} turn={turn} stamped={logBar} loadSteps={stepsOf(turn)} />);
    const items = chatItems(list);
    let prev: number | undefined;
    return items.map((item) => {
      const first = item.kind === "turn" ? item.turn : item.turns[0]!;
      const divider = first.startedAt && (prev === undefined || !sameDay(prev, first.startedAt));
      prev = (item.kind === "turn" ? item.turn : item.turns[item.turns.length - 1]!).startedAt ?? prev;
      return (
        <div key={first.id}>
          {divider && (
            <div className="text-muted-foreground my-3 flex items-center gap-3 text-[10px] tracking-widest uppercase" data-slot="chat-day">
              <span className="h-px flex-1 bg-border" /><span>{dayLabel(first.startedAt!)}</span><span className="h-px flex-1 bg-border" />
            </div>
          )}
          {item.kind === "turn" ? chatTurn(item.turn) : <AgentsMarker turns={item.turns} render={chatTurn} />}
        </div>
      );
    });
  };
  return (
    <div className={`flex h-full flex-col ${flush || logBar ? "" : "gap-3"} ${logBar || chatStyle ? "log-themed" : ""}`} data-variant={variant}>
      <div
        ref={scroller}
        onScroll={onScroll}
        // overscroll-contain: hitting the chat's top or bottom must not hand the gesture to the page —
        // it did, and the page then kept scrolling when you turned back to scroll the chat up.
        className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-neutral-950 leading-relaxed ${logBar ? "px-4 py-3 md:px-6" : "p-3"} text-neutral-200 ${chatStyle ? "font-sans text-[13px] [&_.prose]:text-[13px]" : logBar ? LOG_TEXT : "font-mono text-xs"} ${flush || logBar ? "" : "rounded-md border border-neutral-800"}`}
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
        {/* Earlier pages: fetched as you near the top, or on a click (a page shorter than the window
            can't be scrolled). A skeleton while the page is in flight. */}
        {turns !== null && (older || hiddenAbove > 0) && (
          <div className="mb-3 flex justify-center" data-slot="chat-older">
            {loadingOlder ? <ChatSkeleton rows={2} /> : (
              <button type="button" onClick={() => (hiddenAbove > 0 ? showAbove() : void loadOlder())} className="rounded-md border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200">
                ↑ earlier turns
              </button>
            )}
          </div>
        )}
        {turns === null ? <ChatSkeleton rows={4} />
          : turns.length === 0 ? <p className="text-neutral-500">No history yet for <span className="text-neutral-300">{row.branch}</span>. Send a message below to start.</p>
          : <DraftContext.Provider value={drafts}>{renderTurns(shownTurns!)}</DraftContext.Provider>}
        {hiddenBelow > 0 && (
          <div className="mb-3 flex justify-center" data-slot="chat-newer">
            <button type="button" onClick={() => setWin(revealBelow(turns ?? [], win))} className="rounded-md border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200">
              ↓ {hiddenBelow} newer turn{hiddenBelow === 1 ? "" : "s"}
            </button>
          </div>
        )}
        {/* Not drawn once the real thing has arrived over the stream — the same text twice, one of
            them "sending", is worse than the moment's gap it would cover. */}
        {sending.filter((m) => !landed(m.text)).map((m) => chatStyle ? (
          <div key={m.id} className="mb-4" data-slot="chat-sending">
            <div className="mb-2 flex justify-end"><div className="bg-accent text-foreground max-w-[85%] rounded-lg px-3 py-2 whitespace-pre-wrap break-words opacity-70">{m.text}</div></div>
            <div className="text-muted-foreground pl-8 text-[11px]">▋ sending…</div>
          </div>
        ) : (
          <div key={m.id} className="mb-3" data-slot="chat-sending">
            <div className="flex gap-2 text-emerald-400">
              <span className="shrink-0 select-none">❯</span>
              <span className="min-w-0 whitespace-pre-wrap break-words">{m.text}</span>
            </div>
            <div className="mt-1 pl-4 text-neutral-500">▋ sending…</div>
          </div>
        ))}
        {queued.map((m) => (
          <Queued
            key={m.id}
            message={m}
            onCancel={() => void api.cancelQueued(row.repo, m.id).then(loadQueued)}
          />
        ))}
        {/* Scrolled up while the agent keeps talking: a way back down, instead of being dragged there. */}
        {!atTail && (
          <div className="sticky bottom-0 flex justify-center pointer-events-none">
            <button type="button" onClick={jumpToLatest} data-slot="chat-jump" data-unseen={unseen || undefined}
              className={`pointer-events-auto flex items-center gap-1 rounded-full border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-sans text-[11px] shadow-menu hover:text-neutral-100 ${unseen ? "text-sky-400" : "text-neutral-400"}`}>
              <ArrowDown className="size-3" />{unseen ? "New messages" : "Jump to latest"}
            </button>
          </div>
        )}
      </div>
      {/* `dark` scopes the theme tokens: the composer's text and border must read on the terminal
          background whatever the page's theme is. */}
      <div className={chatStyle ? "border-t p-2" : flush ? "dark text-foreground bg-neutral-950 p-2 pt-0" : logBar ? "border-t p-4" : undefined}>
      <ChatComposer
        className={chatStyle ? "shadow-none" : flush ? "border-neutral-800 bg-neutral-950 shadow-none" : undefined}
        leading={<ChatControls {...ctl} compact={ctl.contextPct === undefined && compacting === null ? undefined
          : { onCompact, pending: compacting !== null, busy: running, error: compactError }} />}
        persistKey={`orca.chat.${row.repo}::${row.branch}`}
        repo={row.repo}
        placeholder={running ? "The agent is working — queue the next instruction…" : `Reply to ${modelLabel(modelFor(row))}…`}
        history={row.followUps}
        onSubmit={submit}
        prefill={prefill}
        // The Chat tab's own panel only ever mounts while that tab is active (Radix unmounts the
        // others), so focusing on mount covers opening it by click, by route, or via a
        // notification's `?reply` — one condition, not three.
        autoFocus={logBar}
        // Interrupt + message as ONE gesture, the way Managed Agents pairs user.interrupt with the
        // next user.message: the run is stopped and the text goes straight after it. If the process
        // hasn't exited by the time the message arrives it is queued and dispatched on exit, so the
        // order is the same either way.
        alt={running && row.worktreePath ? {
          label: "■ stop & send",
          title: "Interrupt the run and send this instead. The worktree, its commits, and the session are kept.",
          onSubmit: async (text, images) => {
            await api.stopAgent(row.worktreePath!);
            await submit(text, images);
            await refresh();
          },
        } : undefined}
      />
      </div>
    </div>
  );
}
