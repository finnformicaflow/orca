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
(create, Fix CI, Resolve conflicts, Address review, Follow up, Slack, PR description) — they need the
structured outcome / portable transcript / run ledger, so **board automation is never routed through
tmux**. Alongside it there is now a deliberate **interactive tmux lane** (see below) — a live browser
terminal you drive by hand. Both operate on the SAME worktree, so git stays the source of truth and
they coexist. For a quick jump to a real terminal, "Copy CLI" still gives the provider-native resume
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
  a plain-JSON API. `Vite` is dev-only (HMR + proxy). The one streaming surface is the interactive
  terminal WebSocket (`/api/terminal/ws`) — everything else is request/response. The listen socket is
  **bound to `127.0.0.1` only** (single-user local tool) so the terminal — which sends keystrokes into
  a live shell — is never network-reachable.
- **Why the process must exist:** a browser can't run `git worktree`, read a local diff, or
  start a dev server. The bridge does *only* what the browser
  physically can't, plus proxies GitHub so tokens never touch the browser. It is still not a
  "backend" in the app sense — no service layer, no ORM, no job queue. It owns exactly one piece
  of business state (the chat history, below) because that data exists nowhere else.
- **The chat history (`server/db.ts`, SQLite via `bun:sqlite`) IS app state — a deliberate reversal
  of the original "no DB" rule.** (History: enrichment lived wholly in `localStorage` and turns were
  recorded by the *browser*, from a poll — so a bridge restart, a closed tab, or a follow-up landing
  inside the 8s poll window destroyed the agent's response permanently. The turn is now written where
  the data already is: inserted at `launch()` with `status='running'`, completed in the exit handler.)
  Two tables: `workstream` (surrogate integer id; `(repo, branch)` is a *mutable pointer*, unique only
  while live, so renames and reused branch names don't collide) and `turn` (keyed by `run_id`, so a
  fast follow-up can't clobber its predecessor the way the worktree-path-keyed `runs` map did).
  **Nothing is deleted — finished workstreams are ARCHIVED**, because the conversations most worth
  chaining from later are exactly the ones whose branches got merged and reaped. Granularity is
  prompt + final response + structured outcome (what you'd feed a model), NOT the provider's raw event
  stream — that's far larger, mostly tool output, and the provider already keeps it; `turn.raw_ref`
  points back at it. Migrations are `PRAGMA user_version` + a numbered step, nothing more. A history
  write must never break the run that produced it (`recordTurn` swallows and logs).
- **Operational state dir (`~/.orca`, override `ORCA_STATE_DIR`) holds both.** The DB lives here too
  (mode `0600` — it holds prompts and responses in plaintext) alongside the *advisory* operational
  files. It holds run **leases** (`server/lease.ts`: pid/runId/provider/
  branch/expiry, so a restarted bridge rejects overlapping agent runs and reclaims dead/expired
  ones) and the bounded **run ledger** (`server/ledger.ts`: counts/sizes per run for
  `/api/diagnostics` — never prompts, responses, logs, or secrets; it is NOT a transcript backup).
  The lease and ledger stay **advisory**: if a file is missing or unreadable, degrade (reclaim the
  lease, drop the record) — never refuse a legitimate run. The DB is not advisory — losing it loses
  chat history (git/gh/worktrees still hold the code, so nothing unrecoverable is at stake). The whole
  dir is kept OUT of every worktree so none of it can leak into a diff or PR body. Leases persist
  across shutdown by design (the bridge leaves agents running; the lease is how the restart sees
  them). For everything except the chat history, live system + git + gh remain the sources of truth.
- **Source of truth is the LIVE system, not localStorage.** Draft column is driven by
  `GET /api/agents` (git worktrees + in-memory run status); the PR lanes by `GET /api/prs`
  (`gh pr list --author @me`). `localStorage` only **enriches** that live data with what
  git/gh can't recover — prompt, title, provider/session pointer, portable transcript, Slack timestamps — keyed by branch (`web/src/store.ts`).
  PRs/worktrees with no enrichment still render (backwards compat, incl. PRs not made by Orca).
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

## Interactive terminal (the hand-driven lane)

A live browser terminal, backed by **tmux**, for driving an agent by hand — the deliberate exception
to "hosts no chat UI and does not stream". It COEXISTS with headless one-shot (which stays the
mechanism for every automated board action); both share the worktree, git is the source of truth.

- **One tmux session per worktree**, namespaced `orca/<repo>/<branch-slug>` so it can't collide with
  the user's own sessions. Pure naming lives in `shared/tmux.ts` (`sessionName`); the launch-vs-attach
  *command* reuses `attachCommand` (`shared/agent.ts`) — so a terminal resumes EXACTLY like Copy CLI
  (native resume, or a seeded cross-provider handoff file).
- **`server/tmux.ts`** — thin wrappers over the real `tmux` binary (no node-pty / native module, per
  the Bun-only rule): `ensureSession` (idempotent — re-open just re-attaches), `sessionExists`,
  `sendKeys`, `capturePane`, `resize`, `killSession`, `listSessions`. tmux **outlives the bridge** by
  design, so `listSessions` re-surfaces live terminals after a restart (dovetails with `lease.ts`);
  `/api/agents` tags each worktree `tmux: true/false` for the card's live-session badge. If `tmux`
  isn't installed the lane degrades (endpoint 501, no badge) rather than crashing.
- **`server/terminal.ts` + `/api/terminal/ws`** — the WebSocket glue: on connect send the current
  screen (`capture-pane -pe`), then stream raw ANSI via `tmux pipe-pane` → FIFO → `cat` → ws (binary
  frames); client keystrokes → `send-keys -l`, resize → `resize-window`. Reconnects on drop.
- **Frontend:** an xterm.js component (`web/src/components/Terminal.tsx`, all assets bundled — no CDN)
  in a "Terminal" tab of the local/PR detail view.
- **Two entry points:** "Open terminal" (card Agent menu + the Terminal tab, `ensureSession` first so
  it works for a PR/worktree with no session yet); and "Start interactive session" in New-draft (the
  ⌨ toggle) — cuts the worktree, starts the agent in tmux seeded with the typed prompt as its first
  message, and drops you into the terminal. Closing the tab leaves it running.
- **Lifecycle:** killed on Discard/Close (and when a merged branch is reaped); left running on normal
  shutdown — persistence is the whole point.

## The one board & model

One board (`web/src/views/Board.tsx`), lanes: **Local → Draft → In Review → Mergeable → Done·today**.
A workstream is a branch; its lane (`store.laneFor`):
- **open PR, draft** → Draft. **open PR, approved** → Mergeable. **open PR, else** → In Review.
- **no PR** → Local, until Promote (local repo: sets `promoted`; then Mergeable if `git merge-tree`
  is clean, else In Review). **merged today** (server-local calendar day) → Done (`gh pr list --state merged`).

Actions (all via `ActionButton`, spinner → ✓/✗, no double-fire):
- **Promote** (Local, remote repo) = a dropdown: Create PR ready / draft, ± add preview label.
  Local repo → plain Promote (sets `promoted`).
- **Resolve conflicts / Fix CI / Follow up** = launch the selected provider headlessly in the branch's
  worktree. They **`ensureWorktree` first** (`store.ts`): use the existing worktree, else adopt one
  via `git worktree add` from the branch (incl. PRs with no Orca history) — so no action ever
  requires a manual "check out" step or a copied prompt. Follow up resumes the provider-native
session when possible or uses the portable transcript for a cross-provider handoff.
Claude sessions at 80% context or higher also reset through that compact handoff rather than
dragging an almost-full native context into another turn.
  `ensureWorktree` also copies `copyToWorktree` config into the fresh worktree.
- **Mark ready** (draft PR) = `gh pr ready`. **Merge**: PR → `gh pr merge`; local → guarded `git merge`.
- **Discard** never deletes a branch that has an open PR (only pre-PR locals).

Agent runs are killed on discard and on server shutdown (SIGINT/SIGTERM) so restarts don't orphan
them. Routing: `/` = board, `/{repo}/prs/:n[/files|/checks|/preview]` = PR detail,
`/{repo}/local/:branch[/files|/preview]` = local-session detail.

`web/src/workstream.ts` is the pure state machine (no React/IO — imported by store + tests):

```
DRAFTING → READY → (promote) → IN_REVIEW → (approved) → MERGEABLE → MERGED
```

Lanes are review-driven only (`deriveKanbanState`): approved→MERGEABLE, else IN_REVIEW.
Conflict / CI / mergeability / "ready for review" are **badges, not lanes**. Agent actions use
the workstream's selected provider; Slack posting uses a lightweight model of that provider (or copy). Previews start N services
(frontend+backend) on assigned ports via
`server/preview.ts`.

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
