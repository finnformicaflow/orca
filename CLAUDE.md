# Orca — durable brief for Claude

Read this first. It's the context that isn't obvious from the code.

## The problem Orca exists to solve

An engineer on a fast, high-PR-volume team drives features through a manual chain:
prompt a coding agent → open PR → watch CI/comments → fix conflicts → Slack the reviewers →
bump if it's been a day → merge. Every transition is hand-driven. **Orca automates the
connective tissue between "managing agents" and "managing PRs."**

**Orca launches Claude, Codex, or Cursor headless.** On create, the user selects a provider and Orca runs
`claude -p`, `codex exec`, or `cursor-agent -p` (using the CLI's existing login — no API key) in the new worktree, and shows a
status badge (running/done/error). Headless one-shot is the mechanism for the AUTOMATED board actions
(create, Address PR, Resolve conflicts on a local branch, Follow up, Slack, PR description) — they need the
structured outcome / portable transcript / run ledger, so **board automation is never routed through
tmux**. The card's **terminal** is now a conversation modal (the durable turns + a composer, see
below), not a live shell; a live tmux lane existed once and its backend is left dormant. For a quick
jump to a real terminal, "Copy CLI" still gives the provider-native resume
command to jump into an interactive session. When you
switch a card's agent (e.g. one model is maxed out), Copy CLI instead seeds a NEW interactive session
of the pinned provider with the portable transcript (written to a handoff file under the state dir,
never the worktree), so you keep prompting the new model in-context and the previous model is never
resumed. Same-provider follow-ups use the native session id. Cross-provider continuation starts a new native
session seeded with Orca's bounded portable transcript (instructions + final outcomes); files/git in
the shared worktree remain the source of truth. Each worktree is one feature/session, so Orca infers
native resume versus cross-provider handoff from the selected provider instead of exposing a chat-mode toggle.
The git change-summary poll shows commits as they land. Orca
then promotes the branch to a PR and drives it to merge with buttons.

(History: earlier slices deliberately did NOT run agents — the user reversed this. Slack
is an exact copyable message rather than a hidden Claude invocation, preserving provider isolation.
The principle that survives: Orca generates prompts / launches processes but hosts
no chat UI. Browser enrichment persists the small portable turn transcript and active provider/session
pointer; live worktrees, git, provider-native sessions, and GitHub remain the authoritative state.)

## Architecture

- **One Bun process** (`server/index.ts`, via `Bun.serve`) serves the built React SPA *and*
  a plain-JSON API. `Vite` is dev-only (HMR + proxy). The one streaming surface is the SSE turn
  stream (`/api/turns/stream`) — everything else is request/response. **The API has no auth of its
  own**, so the listen socket is loopback by default (`ORCA_BIND` overrides it for a deployed
  instance, which binds its tailnet address and is reached only over Tailscale — never `0.0.0.0`).
  (History: a keystrokes-into-a-shell terminal WebSocket once made the loopback bind critical; the
  WebSocket is gone, the bind rule stays because the bridge runs agents with repo-granted authority.)
- **Why the process must exist:** a browser can't run `git worktree`, read a local diff, or
  start a dev server. The bridge does *only* what the browser
  physically can't, plus proxies GitHub so tokens never touch the browser. It is still not a
  "backend" in the app sense — no service layer, no ORM, no job queue. It owns exactly one piece
  of business state (the chat history, below) because that data exists nowhere else.
- **The chat history (`server/db.ts`, POSTGRES via `Bun.SQL`) IS app state — a deliberate reversal
  of the original "no DB" rule.** (History: enrichment lived wholly in `localStorage` and turns were
  recorded by the *browser*, from a poll — so a bridge restart, a closed tab, or a follow-up landing
  inside the 8s poll window destroyed the agent's response permanently. The turn is now written where
  the data already is: inserted at `launch()` with `status='running'`, completed in the exit handler.)
  Two tables: `workstream` (surrogate id; `(user, repo, branch)` is a *mutable pointer*, unique only
  while live, so renames and reused branch names don't collide) and `turn` (keyed by `run_id`, so a
  fast follow-up can't clobber its predecessor the way the worktree-path-keyed `runs` map did).
  **It is Postgres, not SQLite, because the database is becoming the shared source of truth for more
  than one Orca instance** (a cloud box and a laptop, each executing its own worktrees against one
  database) — which a file on one host cannot be. `Bun.SQL` ships with the runtime, so it costs no
  dependency. **Every table carries `user_id`** from the first migration: there is no auth yet
  (`db.currentUser()` returns a constant) and exactly one user, but retrofitting row-level scoping
  later would mean revisiting every query, so the column goes in while it is free.
  **Nothing is deleted — finished workstreams are ARCHIVED**, because the conversations most worth
  chaining from later are exactly the ones whose branches got merged and reaped. Granularity is
  prompt + final response + structured outcome (what you'd feed a model), NOT the provider's raw event
  stream — that's far larger, mostly tool output, and the provider already keeps it; `turn.raw_ref`
  points back at it. Migrations are numbered, append-only steps in a `migration` table — never edit an
  applied step, add another — and each runs in one transaction. A history write must never break the
  run that produced it (`recordTurn` logs and swallows). The API is async throughout: `launch()`
  **awaits** the start write, because "the turn exists before the run can produce output" is the whole
  point of writing at launch; the finish write is fire-and-forget, tracked so `agent.flushHistory()`
  can drain it before shutdown closes the pool. A finished turn records **why** it ended as
  `stop_reason` (`shared/agent.ts` `StopReason`, Managed Agents' vocabulary): `end_turn`,
  `budget_reached` (the repo's `agentMaxBudgetUsd` → `--max-budget-usd`), `interrupted` (you stopped
  it; still resumable), `error`; `requires_action` is reserved for a run blocked on a tool
  confirmation. It is a column so a conversation list can filter on it, never a heuristic over the
  response text. The agent's process gets the bridge's environment **minus Orca's own secrets**
  (`agentEnv` in `server/agent.ts`) — a prompt injection that reads the environment must find no
  Slack token or database URL there.
- **Operational state dir (`~/.orca`, override `ORCA_STATE_DIR`) holds the on-disk state.** The
  database is not among it (see `ORCA_DATABASE_URL`), and neither are the per-run step transcripts
  any more (`server/transcript.ts` writes them to Postgres, so both instances can read them). The
  dir holds the *advisory*, per-host operational files: run **leases** (`server/lease.ts`: pid/runId/provider/
  branch/expiry, so a restarted bridge rejects overlapping agent runs and reclaims dead/expired
  ones) and the bounded **run ledger** (`server/ledger.ts`: counts/sizes per run for
  `/api/diagnostics` — never prompts, responses, logs, or secrets; it is NOT a transcript backup).
  The lease and ledger stay **advisory**: if a file is missing or unreadable, degrade (reclaim the
  lease, drop the record) — never refuse a legitimate run. The DB is not advisory — losing it loses
  chat history (git/gh/worktrees still hold the code, so nothing unrecoverable is at stake). The whole
  dir is kept OUT of every worktree so none of it can leak into a diff or PR body. Leases persist
  across shutdown by design (the bridge leaves agents running; the lease is how the restart sees
  them). For everything except the chat history, live system + git + gh remain the sources of truth.
- **Source of truth for lanes is the LIVE system.** Draft column is driven by
  `GET /api/agents` (git worktrees + in-memory run status); the PR lanes by `GET /api/prs`
  (`gh pr list --author @me`). **Enrichment** only decorates that live data with what
  git/gh can't recover — prompt, title, provider/session pointer, transcript, Slack timestamps — keyed
  by repo+branch. It lives in the DB (`GET/POST /api/enrichment`); `web/src/store.ts` keeps a
  synchronous in-memory **mirror** so reads stay sync during render, writes go through the server, and
  the agents poll re-hydrates. Writes still in flight are re-applied over a hydration
  (`pendingWrites`) — a poll that started before a write returns data predating it, and silently
  reverting `followSig` would re-fire a follower's action every poll. Rows are assembled from live
  PRs + worktrees, so enrichment with no branch behind it renders nothing; PRs/worktrees with no
  enrichment still render (incl. PRs not made by Orca). **There is no enrichment GC** — it existed to
  bound a 5MB localStorage bucket, and pruning is now the opposite of the goal. `localStorage` keeps
  only per-browser UI state (theme, density, composer drafts); a one-shot `migrateLocalEnrichment`
  hands any pre-DB blob (transcripts included) to the bridge on first load.
- **GitHub = the `gh` CLI; Slack = a direct `chat.postMessage`** from your identity using a user token
  (`SLACK_TOKEN`) — the ONE Slack path for every provider: deterministic, verbatim, instant, no model,
  no MCP (via `server/slack-api.ts`'s `postMessage`, reused by `/api/slack`). No OAuth app. A failed
  post surfaces as an error (never silently degraded), and the client copies the exact message to the
  clipboard so it can be pasted by hand. The message is the linked `#7 Title` (Slack mrkdwn for the
  post, rich HTML for the copy).

## Multi-repo (aggregated)

`orca.config.ts` holds `repos: RepoConfig[]` (each with repoPath/worktreeRoot/baseBranch/
previewServices/slackChannel) + global portRange/staleHours. Every repo-scoped API call names
its repo (`?repo=` on GET, `repo` in POST body; server resolves via `repoOf`). The board shows
**all repos aggregated** — the store polls each repo and `useWorkstreams()` builds unified
rows tagged by repo (each row carries `repo`; actions use `row.repo`). Enrichment is keyed
`repo::branch`. The New-draft box has a repo **dropdown**; cards show a repo tag.

## No live terminal

There is deliberately no tmux/xterm lane. One existed per card (deleted as unused) and came back
once for the orchestrator's window (#96: Claude Code's TUI in tmux, streamed over a WebSocket) —
the user found it didn't work for them and had it reverted the next day. The orchestrator's window
is the chat panel over its recorded turns; a wake is `claude -p --resume` on its session.

## The one board & model

One board (`web/src/views/Board.tsx`), lanes: **Local → Draft → In Review → Mergeable → Done·today**.
A workstream is a branch; its lane (`store.laneFor`):
- **open PR, draft** → Draft. **open PR, approved** → Mergeable. **open PR, else** → In Review.
- **no PR** → Local, until Promote (local repo: sets `promoted`; then Mergeable if `git merge-tree`
  is clean, else In Review). **merged today** (server-local calendar day) → Done (`gh pr list --state merged`).

Actions (all via `ActionButton`, spinner → ✓/✗, no double-fire):
- **Promote** (Local, remote repo) = a dropdown: Create PR ready / draft, ± add preview label.
  Local repo → plain Promote (sets `promoted`).
- **Address PR / Follow up** = launch the selected provider headlessly in the branch's
  worktree. **Address PR is the one agent verb for a PR** (`store.addressPr`, `addressPrPrompt`): a
  single run that resolves merge conflicts, fixes failing CI and addresses the review — whichever
  apply, in that order — instead of three buttons the user had to triage between. Resolve conflicts
  remains on its own only for a LOCAL branch with no PR. They
  worktree. They **`ensureWorktree` first** (`store.ts`): use the existing worktree, else adopt one
  via `git worktree add` from the branch (incl. PRs with no Orca history) — so no action ever
  requires a manual "check out" step or a copied prompt. Follow up continues the conversation by
  the **handover ladder** below.
  `ensureWorktree` also copies `copyToWorktree` config into the fresh worktree.

**Handover ladder** — how the next turn gets the previous turns' context. Lossless rungs first;
the lossy one only when nothing above it applies. This is the whole contract; nothing else carries
context between turns.

1. **Native resume, same login** (lossless). `--resume <session>` on the provider's own session:
   every message, tool call and result the provider recorded. The default for every follow-up.
   Changing the *model* keeps this rung — a resumed Claude session accepts a different `--model`.
2. **Native resume, other Claude login** (lossless) — **hydra's job, not Orca's.** The `claude` on
   the bridge's PATH is [claude-hydra](https://github.com/finnformica/claude-hydra)'s shim: every
   launch, interactive or `claude -p`, goes to the login with the most headroom (5-hour, weekly and
   Fable windows, model-aware). Sessions are shared between logins through hydra's symlinked
   `projects/`, so a `--resume` works on ANY account with no copy — verified cross-account. Orca
   therefore has no profile routing of its own (it once did: a `claudeProfiles` picker plus a
   session-file copy; both deleted when hydra took over). An explicit `CLAUDE_CONFIG_DIR` bypasses
   hydra. If the shim is missing (Claude Code's updater rewrites `~/.local/bin/claude`), every run
   silently lands on the default login — `/api/usage` reports `routing.shim` and the meter warns.
3. **Portable transcript** (lossy, bounded). Used for a provider switch, a Claude session at ≥80%
   context, a Codex/Cursor session past 12 turns or three straight failures, a session the provider
   can't find, or a login switch whose session file is missing. `handoffPrompt` (`shared/agent.ts`)
   sends the newest ~12k tokens of turns, oldest dropped first: each turn's *instruction* (not the
   scaffolding), an **Activity** list of the tools it ran and what on (when the turn's steps are
   available — the server-side fallback loads them), and its structured outcome (Remaining,
   Decisions, Outcome, Verification, Commits) or, failing that, its final response. The worktree —
   files, git status, commits — is declared the source of truth over the transcript.

What is *not* carried on rung 3: the provider's reasoning, tool outputs, and anything older than the
bound. If a handover feels amnesiac, check which rung it took (the run's `mode` in the ledger:
`resume` / `reset` / `handoff`) before blaming the model.
**Verification gate** (`server/check.ts`) — after any run that *committed* (HEAD moved), Orca runs
the repo's `checkCommand` in the worktree itself and records the result on the turn (`turn.check`:
command, exit code, output tail). The card says **Verified** or **Check failed**; the chat shows the
verdict with the output folded under it. This is Orca's evidence, deliberately separate from the
agent's self-reported Verification section: "looks done" is the only signal a model has without
it. With `followAutomation` on, a failure queues ONE fix follow-up whose instruction starts with
`AUTOFIX_MARKER` and carries the output; a fix attempt that fails again stops there (`isAutofix`),
so the gate can never loop. The conversational prompts also open with a session-start ritual
(`SESSION_START` in `workstream.ts`: git log, git status, the prior Remaining/Decisions, one thing).

- **Mark ready** (draft PR) = `gh pr ready`. **Merge**: PR → `gh pr merge`; local → guarded `git merge`.
- **Discard** never deletes a branch that has an open PR (only pre-PR locals).

Agent runs are killed on discard and on server shutdown (SIGINT/SIGTERM) so restarts don't orphan
them. Routing: `/` = board, `/{repo}/prs/:n[/files|/checks|/preview]` = PR detail,
`/{repo}/local/:branch[/files|/preview]` = local-session detail.

**Terminal (the conversation)** — `web/src/components/Terminal.tsx`'s `TerminalDialog` is a modal
opened from the card's terminal button, rendering `ChatPanel` (`web/src/views/Chat.tsx`): the branch's
whole conversation from `GET /api/turns` as a **terminal-style log** (dark monospace, each instruction
shown as `❯ …` with the agent's output below), plus the follow-up `ChatComposer` to send the next
message. It is NOT a live shell — it renders the turns Orca already records, so nothing tmux is
involved. Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every
board action uses. A turn written at launch but not yet finished renders as `▋ working…` (that's how
an interrupted run stays visible); a turn with a parsed outcome renders its sections. (History: this
was briefly a detail-page "Chat" tab; the user asked for it as a terminal-style modal instead, and the
tab was removed.)

`web/src/workstream.ts` is the pure state machine (no React/IO — imported by store + tests):

```
DRAFTING → READY → (promote) → IN_REVIEW → (approved) → MERGEABLE → MERGED
```

Lanes are review-driven only (`deriveKanbanState`): approved→MERGEABLE, else IN_REVIEW.
Conflict / CI / mergeability / "ready for review" are **badges, not lanes**. Agent actions use
the workstream's selected provider; Slack posting uses a lightweight model of that provider (or copy). Previews start N services
(frontend+backend) on assigned ports via
`server/preview.ts`.

## The orchestrator (one conversation that delegates)

A floating launcher in the bottom-right corner (inverted against the theme, on every route) pops
out a chat window — a popout like a site's chat widget, deliberately not a modal, so the board it
is moving stays visible. Its composer sits on the terminal's own background and carries a model
picker (Claude models only; changing it keeps the session) and an icon button whose ring shows how
full its context is (the percentage is in its hover popover) — the same `ChatControls` every card's
terminal composer has, fed the orchestrator's values instead of the card's. The popover's **Compact**
button (`POST /api/compact`, `verbs.compact` / `orchestrator.compact`) launches `/compact` as the
whole prompt on a native resume of that conversation's own Claude session — the same command typed
in the session, through the same `agent.launch`, never the handover ladder (which would swap a
filling session for a fresh one). It shows once a Claude run has reported context; it is pending
until its turn finishes, then the ring re-reads from the CLI's post-compaction count
(`compact_boundary`). Mid-turn it is disabled with a tooltip and the bridge answers 409 — not
queued, because a queued message reaches the model as prose and `/compact` only works as its own
run. A compact is housekeeping: it neither counts as an orchestrator wake nor reports a worker
event.
The window is dragged by
its header and resized from any edge, and can never leave the viewport (`clampFrame`/`resizeFrame`
in `workstream.ts`: on every move, on browser resize, and on load, which also fixes a saved spot
from a bigger screen). **Pop out** moves it into an always-on-top Document Picture-in-Picture window
(Chrome/Edge 116+) via a React **portal**: the same tree, so draft, SSE, popovers and keys carry
over. The page's stylesheets are copied into it and `<html>`'s class/style mirrored (theme). Radix
popovers/selects portal into it through `PortalContainer` (`lib/utils.ts`). Return to tab, its own
close, or the launcher brings it back, and its size is remembered. Browsers without the API get no
button (a plain popup can't stay on top, so it was not worth having).
It is one conversation you talk to; it starts and steers
workstreams itself. Anthropic's orchestrator-workers pattern, kept to **two layers** — it, and the
workstreams the board already shows (each worker is a Claude Code session that can spawn its own
subagents; Orca does not model that). `server/orchestrator.ts` is all of it.

- **It is not a new runtime.** A wake is the same headless one-shot as every board action, recorded
  as turns under a reserved pointer (`ORCHESTRATOR_REPO` `@orca` / branch `orchestrator` — no git
  repo behind it), so the chat panel, the SSE stream, the queue and Stop all work on it unchanged.
  Its cwd is `~/.orca/orchestrator`, never a worktree.
- **It has Claude Code's full terminal toolset by default** (`bypassPermissions`): shell, files,
  web, subagents, MCP — a manager who can find things out, digest, run and fix the machine, and
  send messages, as the user asked. `orchestratorShell: false` (app config) keeps it to the `orca`
  command, reading, the web and read-only subagents via `--allowedTools` — for a shared box, since
  it reads every worker's output. Its prompt states which mode it is in on EVERY wake (`## Access`).
  Either way it **cannot promote, merge or Slack through Orca**; those stay your buttons. Code
  changes to a repo go to a workstream — a worker owns its branch. Claude only (workers keep their
  per-card model). What it gets from its cwd (`~/.orca/orchestrator`): a `CLAUDE.md` there (yours to
  write) is read as standing orders alongside the role in the prompt, a `.mcp.json` there is its
  project-scope MCP servers, and Claude Code's own auto-memory accrues under that cwd; user-level
  `~/.claude` config loads as in any session.
- **`orca`** (`bin/orca` → `POST /api/orchestrator/tool` → `orchestrator.tool`): `board`, `spawn`,
  `send`, `address`, `archive`, `preview` (`--status`; and `--push-to-template [--confirm]`,
  `server/pushTemplate.ts`, which makes a preview's whole database the repo's `PREVIEW_TEMPLATE_DB`
  — old one kept as `<template>_bak_<ts>` — and writes its integration env vars back to the main
  checkout's copied `.env`; dry run without `--confirm`, values masked — README), `chats`, `read`,
  `notes`.
- **Its role text is judgement-first.** It is told it is a senior engineer running a team, given
  the trade-offs (send to an existing workstream vs spawn; one branch per mergeable unit) and left
  to decide. An earlier, rule-shaped version ("do not spawn for something a workstream owns") made it
  spawn a second workstream rather than ask the first to adapt — the user wants it free to decide.
- **Stability.** Two things once made runs look like they died. (1) The dev launcher runs the bridge
  under `bun --watch`, so a change to THIS checkout restarts it under in-flight runs. The agent
  processes survive that; what died was the bridge's view of them — the stdout reader and the exit
  handler that records the result, runs the check, wakes the orchestrator and sends the queue — so
  finished runs sat "running" (zombie children kept their leases live until expiry) and a wake
  killed mid-turn (exit 143) looked like the orchestrator leaving. Now `agent.adoptLeases` runs at
  startup: every live lease is shown running and, when its process exits, its turn is finished from
  the provider's session file and the normal after-run path fires (minus the check gate). The
  orchestrator's own wake is `orchestrator.recover`'s. `lease.pidAlive` treats a zombie as dead.
  (2) There was a per-wake `--max-budget-usd` (5, then 25) and a long resumed session hit it
  mid-reply several times a day; **there is no cap unless `orchestratorWakeBudgetUsd` is set**.
  Also: a lease records its `sessionId` and `launch` refuses a resume while another live run is on
  that session (`lease.sessionBusy`) — two runs on one session both end with the same reply, which
  was the "one message behind" bug.
- **Working on Orca itself: worktree + PR, never this checkout.** The bridge serves the main
  checkout and restarts when it changes, so edits and `git pull` there are restarts under live
  runs. Make changes in a worktree (`git worktree add .worktrees/<name>`, symlink `node_modules`,
  copy `.env` for the test database), open a PR, and pull `main` into the checkout deliberately —
  a restart is survivable now, but it is still a restart. This supersedes "commit straight to main"
  below for this repo.
- **Server-side verbs** (`server/verbs.ts`): create / follow up / Address PR existed only in the
  browser store, which a server-side caller can't reach. They are built from the same pure pieces —
  the prompts and `continuation()` (the handover-ladder decision, now in `workstream.ts` and used by
  the store too) — so the two callers can't disagree on a prompt or a rung. The browser still runs
  its own I/O glue (optimistic cards, Undo, Follow); only the decisions are shared.
- **It chooses the worker's model.** `MODEL_LADDER` (`workstream.ts`): Haiku for mechanical
  edits, Sonnet for small clear tasks, **Opus 5.5 as the default for most tasks**, Fable ONLY for
  what has already defeated Opus or is genuinely novel — Fable is the scarce resource. The ladder
  rides EVERY wake (`## Models`), not just the role text, because a resumed session sees the role
  once; and `spawn` REQUIRES `--model` — when it was optional, every worker silently got the config
  default, which was Fable. `spawn --model` sets it; `send --model` moves a workstream along the
  ladder, by re-pinning the card's `preferredModel` before the follow-up. The orchestrator itself
  runs on **Opus 5.5** unless its picker says otherwise (`ORCHESTRATOR_DEFAULT_MODEL`); Sonnet was
  tried first and the user moved it up. The catalog has Opus **5.5** (`claude-opus-5-5`), not Opus 5,
  which this account can't use.
- **New draft goes through it by default.** The New-draft box's picker starts at `AUTO_MODEL`
  ("Auto"): the prompt is sent as a `[new draft] repo: <name>` message
  (`newDraftMessage`), which the role text says to answer with exactly ONE spawn, briefed and
  modelled by it. The optimistic card is still painted at once and hands over to the first branch
  the repo didn't have before (`createViaOrchestrator`; Undo tears that spawn down). Picking a real
  model in the box bypasses the orchestrator and launches directly, as before. "New chat" never goes
  through it — a chat is a conversation with a model you chose.
- **A brief has three required parts** — objective, expected output, boundaries (`briefProblems`);
  `spawn` refuses one without them, because a worker knows only its brief.
- **Wake loop — management by exception.** A workstream it spawned or sent to is marked
  `orchestrated` in enrichment (the bot icon on the card). `agent.onRunFinished` fires when such a
  run ends *and nothing queued took over* (an autofix is not "idle"), producing a `workerEvent`:
  the condensed outcome, Orca's check verdict, and the run id as a reference — never the transcript.
  A **problem** (the run failed, was stopped, or its commit failed the check) wakes the orchestrator
  at once. A **clean finish** is queued and delivered when the last of its running workers finishes
  or when the user next speaks, whichever is first — one wake carrying every report since. The same
  rule applies when its OWN run ends (`drain`): clean reports that queued while it worked wait too,
  or its exit re-delivered them one wake at a time. "Problem" is read off the report text
  (`isWorkerProblem`), so a queued report can be judged later; a held report shows in the chat as a
  muted `⚙ … held for the batch` line. Between wakes it checks in itself with `orca board` /
  `orca read`. (It used to be woken per completion;
  the user found that noisy and wanted it to operate like a manager.) In the chat, a wake whose
  message was only worker reports renders as muted `⚙` system lines with the report folded, not as
  a `❯` prompt. It is asynchronous by design: it spawns, ends its turn, and is woken; it never polls.
- **One wake per batch.** Its runs launch with `queue: false`; everything that arrived while it
  worked (worker events, your messages) is drained into ONE resumed run, and deliveries are
  serialised so two workers finishing together can't race a launch.
- **Loop guards.** `MAX_WAKES` (12) self-wakes in a row with no message from you → it pauses and
  holds further events in the queue until you reply (the window's title says so). Each wake has a
  `--max-budget-usd`: `orchestratorWakeBudgetUsd` in the app config, 5 unless set. There is
  deliberately NO cap on concurrent workers (there was one, of 4; the user removed it).
- **A wake that dies says why, and its message is retried once.** `wakeExit` reads the exit the
  agent's handler reports (`RunFinished.exit`): the CLI's budget result subtype, Orca's own timeout
  timer, any other nonzero exit (with the stderr tail), or the CLI's "No response requested."
  placeholder (a heuristic — exit 0, but no reply). The turn's response becomes a `Wake stopped: …`
  line (`db.failTurn`), the messages it claimed (`handling` in its blob — the blob, so a death with
  the bridge is covered) go back on the queue, and the next wake's prompt carries `## Previous wake
  was cut off`. A message whose wake dies twice (`died`) is NOT queued a third time; the line says
  to send it again. A restart is detected at startup (`orchestrator.recover`): a claim with no live
  lease whose turn did not end on text was cut off; one that outlived the bridge and finished is
  just drained. Stop is not a death. The popout shows the last wake's spend and, once a wake costs
  half the cap or the context is half full, a hint that a fresh session would be cheaper
  (`sessionHint`) — a hint only, nothing is reset. The ledger records `costUsd` per run and
  `errorKind` `budget` / `timeout` instead of one `nonzero-exit`.
- **The session is disposable.** Its notes (`orca notes set`, stored in its workstream blob) and a
  fresh board go into EVERY wake prompt; the role text only when a session starts. So the ladder
  applies as for any conversation — resume while healthy, reset onto the portable transcript at 80%
  context — and a reset loses nothing it was told to keep. If it seems amnesiac, read its notes
  before blaming the model.
- **Memory of past work** is the turn table: `orca chats "<terms>"` is Postgres full-text over every
  instruction and response, archived workstreams included; `orca read` loads one on demand
  (just-in-time retrieval, no embeddings, no index yet).
- **Limits to know:** it acts only on repos its own instance runs (no forwarding); two instances
  must not both drive it at once (the run lease is per host); a worker's outcome text is model
  output fed to something that can spawn and send, which is why its authority stops there.

## Deploying (a cloud box + the laptop, one database)

Two instances share the Postgres database; each names itself (`ORCA_INSTANCE`, default hostname)
and executes only the repos whose `runsOn` matches (`runsHere`). A request for a repo owned
elsewhere is forwarded to that instance's URL from `instances` (`forwardToOwner`), except the
`DATABASE_ONLY` routes, which any instance answers from Postgres. Each instance publishes the
worktrees it can see (`worktree_inventory`) so the board shows both. Leases, the ledger, handoff
files, `~/.claude/projects` backfill, preview ports, and `/api/usage` are **per host** — they
describe the instance that answered, which is right for leases and wrong-but-tolerable for the
usage meter. `deploy/orca.service` is the systemd unit; `bun run build` then `bun run server` is
the whole deploy. The unit's `PATH` must hold `~/.local/bin` (hydra + the `claude` shim) and
`jq`/`curl` (hydra's dependencies), and the box runs `hydra add … ; install.sh --shim` once. `.github/workflows/check.yml` runs the gate on Linux, which is where a
macOS-only path (Keychain, `clonefile`) or a tool-flag difference would show first. **Pin the
Claude Code version on the server:** `--bare` is slated to become the default for `-p`, and bare
mode never reads OAuth credentials, which would silently break every subscription-login launch.

## Conventions (follow these)

- **Adapter boundary:** all shell/network I/O lives in `server/{git,gh,slack}.ts` behind
  thin functions that take explicit args (no global config reads). Tests swap the `gh`
  binary via a PATH shim and run `git` against a scratch repo — so keep adapters shelling
  out to real binaries, not reimplementing them.
- **Pure logic in `workstream.ts`**, so it's testable without booting anything.
- **Ponytail:** reuse `git`/`gh`, no bespoke machinery. Shortest working change wins.
- **Node is blocked behind an unset asdf** — always run Node-based tools through Bun:
  `bunx --bun tsc`, `bunx --bun vite`. Plain `bunx`/`npm` will fail.

## Committing (do this without being asked)

**Commit and push after every request, no matter how small — don't wait to be told.** The loop
for each task: make the change → **add/update the e2e test that proves it** → `bun run check`
(must be green) → `git commit` → `git push`. One focused commit per request, each with a clear
message. Never leave the working tree dirty at the end of a turn. If on the default branch and the
change warrants a PR, branch first; otherwise commit straight to `main` and push. End commit
messages with the `Co-Authored-By` trailer.

## Run & test

```
bun install
bun run dev      # bridge + Vite (edit orca.config.ts / env first — see README)
bun run check    # tsc --noEmit + bun test — the gate; keep it green on every change
```

`tests/workflow.test.ts` encodes the core problem as W1–W7. **It is the north star: if a
change breaks a W-test, the change is wrong, not the test** (unless the problem itself
changed). See `QA.md` for the manual equivalent against real GitHub/Slack.

**Every new feature or behaviour change ships with a test that exercises it end-to-end** —
a new numbered case in `tests/workflow.test.ts` (or a focused sibling), in the same style: drive
the real adapters (`git` against a scratch repo, `gh` via the PATH shim — see `tests/helpers.ts`),
no network, no mocks of our own code. When you *change* existing behaviour, **update the test that
covered it** so it asserts the new contract, don't just make the old one pass. Push pure decision
logic into `workstream.ts` so most of it is testable without booting anything. A change with a
runtime surface but no test is incomplete; the exceptions are pure docs/comment/style edits.
