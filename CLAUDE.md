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
  stream (`/api/events`, ONE per tab, multiplexing every chat, the notification centre's pushes, and
  relaying the other instances' buses — a browser gets six HTTP/1.1 connections per host across all
  tabs, and a stream per chat starved the PR page's fetches) — everything else is request/response. **The API has no auth of its
  own**, so the listen socket is loopback by default (`ORCA_BIND`, comma-separated addresses). A deployed
  instance binds loopback PLUS its tailnet address (`127.0.0.1,<tailnet ip>`) and is reached from other
  machines only over Tailscale — never `0.0.0.0`. Loopback is not optional on the box: `bin/orca` and an
  Orca preview's Vite proxy (`/api` → `localhost:8787`) both find nothing without it.
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
  later would mean revisiting every query, so the column goes in while it is free. **A connection the
  remote Postgres dropped out from under us** (a laptop asleep long enough that it drops every pooled
  connection, not just `ERR_POSTGRES_CONNECTION_CLOSED` but a `pg_terminate_backend`-style FATAL too)
  **is reopened and the one query retried once** — every exported function routes through `withRetry`
  rather than hand-catching, so this lives in one place.
  **An UNREACHABLE database is a state, not a crash (degraded local mode).** The day the box hung, the
  laptop's bridge died at boot (`db.open()` ran migrations, the connect timed out, the process
  exited) and nothing ran for the whole outage. Now `server/index.ts` serves at once and does not await
  the database: `db.open()` is lazy with a bounded connect timeout (`ORCA_DB_CONNECT_TIMEOUT_S`, 5s);
  a refused/timed-out connect records `unavailableSince`, every later query fails FAST with
  `db.DbUnavailable`, and one background probe retries with exponential backoff (capped at
  `ORCA_DB_RETRY_MAX_MS`, 30s). Migrations, the boot-time reconcile and orchestrator recovery run on the
  first successful connect (`db.onAvailable`); a refused migration ledger still exits (`db.onFatal`).
  A dropped connection (`ERR_POSTGRES_CONNECTION_CLOSED`) is still `withRetry`'s retry, not an outage. If the reopened pool fails too, the database is marked down. **Every background duty catches
  through ONE helper, `db.logUnlessDown(label)`:** a database error (`db.isDbError`) logs nothing, and
  any other error logs one `label: message` line with no stack. The `[db] connection dropped` line
  prints at most once per outage. Duties skip their work while the database is down (`primary.held()`).
  While down: the config is the last good one (`server/config.ts`: memory, else
  `~/.orca/config.cache.json` — tagged with a hash of the database URL, written only when it changed —
  else the checked-in file); reads degrade to empty plus a marker (`x-orca-database` header on every
  answer, `dbUnavailable: true` on an object body; a 503 where empty would mislead — writes, the
  orchestrator); `/api/health` and `/api/config` report `database: 'unreachable since <iso>'`.
  **Agents still run:** a turn's writes (start, steps, finish, check) and enrichment patches go through
  `server/outbox.ts`, which journals them to `~/.orca/outbox/<runId>.json` /
  `enrichment-<ts>-<n>.json` on `DbUnavailable` and replays them in order when the database is back,
  through the SAME idempotent queries (run_id / (run_id, seq) conflicts) — no schema change. A run with
  a journal keeps journaling until the replay drains it; each journal names its database (a hash), so
  nothing replays into another one. `/api/turns` merges the journal (and `/api/turns/local` serves only
  it); the chat shows "database unreachable — this conversation will sync when it is back". Placement
  falls back to this disk's worktrees when the inventory has no row, so local work is never forwarded
  to a box that is down.
  **Nothing is deleted — finished workstreams are ARCHIVED**, because the conversations most worth
  chaining from later are exactly the ones whose branches got merged and reaped. Granularity is
  prompt + final response + structured outcome (what you'd feed a model), NOT the provider's raw event
  stream — that's far larger, mostly tool output, and the provider already keeps it; `turn.raw_ref`
  points back at it. Migrations are numbered, append-only steps in a `migration` table — never edit an
  applied step, add another — and each runs in one transaction. **A step's identity is id + `name`**:
  the runner compares the recorded name with the code's before applying anything, re-runs an
  `idempotent` step recorded under a foreign name (so write steps `IF NOT EXISTS` wherever Postgres
  allows) and refuses to start on a non-idempotent one; `bun run db:check` prints the ledger,
  read-only. (History: two branches each took id 13; a branch's 13 reached the shared database
  first and main's `running_agents` column was skipped as "applied".) **Numbered steps are frozen
  at 18 (`LAST_NUMBERED_ID`); every new step is NAMED** — no `id`, `name: "YYYYMMDD-slug"` (the day
  you write it), `IF NOT EXISTS` throughout — and recorded in its own ledger, `migration_named`
  (name → applied_at). (History: parallel branches kept taking "the next integer" — 16, 17 and 18
  were reserved by hand across #152, #157 and #160.) Pending named steps apply after the numbered
  ones in NAME order, so two branches that never coordinated land in one stable order on every
  database. `checkSteps` (run at boot, and by the gate over `MIGRATIONS`) refuses a new numbered
  step, a malformed or duplicate name, a non-idempotent named step, and a named step that sorts
  before one above it in the array — code order IS apply order, so a step that depends on one it
  was rebased onto must be re-dated (today) to sort after it; an independent one may move above.
  **Compatibility:** an existing database keeps its numbered ledger (1–15 on the shared one; 17
  and 18 — #160 merged with its integer first — apply as numbered steps); the runner creates `migration_named` on first boot. A bridge still on
  older code reads only `migration`, so it never sees a row it can't parse. A database where a branch
  once recorded its step under an integer (a test DB with #152's 16) logs that id as unknown and
  re-runs the named step, harmlessly, because it is idempotent. **Rebasing an open PR that adds a
  numbered step (#152's 16 `attachment`):** drop the `id`, rename it
  `YYYYMMDD-<old name>` (e.g. `20261013-attachment`), append it after the last step in name order,
  and change any test that finds it by id to find it by name. **Workers: a migration name is reserved
  only by MERGING to main** — never point a running bridge or a test at the shared
  database from a worktree (a worktree's copied `.env` names it; `bun test` refuses any database
  that isn't a `tests/pg.ts` schema, and a worktree's bridge refuses to apply migrations unless
  `ORCA_ALLOW_WORKTREE_MIGRATIONS=1`). A history write must never break the
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
  ones), the **outbox** and **config cache** of degraded mode (above — NOT advisory: the outbox is the
  only copy of a turn until it is replayed, so a bad file is kept, never dropped) and the bounded **run ledger** (`server/ledger.ts`: counts/sizes per run for
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
  only per-browser UI state (theme, density, composer drafts; the shell's repo, instance scope,
  sidebar collapse and palette recents, like the Agents list's view, density, sort and filters, go
  through `lib/persisted.ts` — `persistedAtom` / `usePersisted`, versioned `orca.ui.v1.<name>` keys
  (`persistedKey(name, repo)` for a per-repo value), a safe parse that falls back to the default, and
  a restored repo/instance the config no longer has reads as "all" (`validChoice`); reuse it for new
  UI state); a one-shot `migrateLocalEnrichment`
  hands any pre-DB blob (transcripts included) to the bridge on first load.
- **GitHub = the REST and GraphQL API over `fetch` (`server/github.ts`: a token per repo account from `gh auth
  token`, ETag reuse, rate-limit backoff, typed errors; only the auth flows, the identity lookup and `repo
  clone` still run `gh`); Slack = a direct `chat.postMessage`** from your identity using a user token
  (`SLACK_TOKEN`) — the ONE Slack path for every provider: deterministic, verbatim, instant, no model,
  no MCP (via `server/slack-api.ts`'s `postMessage`, reused by `/api/slack`). No OAuth app. A failed
  post surfaces as an error (never silently degraded), and the client copies the exact message to the
  clipboard so it can be pasted by hand. The message is the linked `#7 Title` (Slack mrkdwn for the
  post, rich HTML for the copy).

## Integrations (one path in, one path out)

`server/integrations/` is the channel layer (design: `docs/research/integrations.md`; how to write an
adapter: `docs/integrations/ADAPTERS.md`). Every event is a keyed envelope in `event` (`notify.emit`
writes one beside each NEW notification, same key). `subscription` rows plan `delivery` rows in the
same transaction; the dispatcher (primary only) claims them `FOR UPDATE SKIP LOCKED`, backs off 5 s →
1 h and marks a row dead after 6 attempts (`orca.integration.failed`, an `integration_failed`
notification). Adapters (`web`, `webhook`, `slack` outbound so far) start only on the primary bridge
of `integration.instance`. Secrets stay in env vars named `ORCA_SECRET_*` (stripped from agents); a
row holds only the name. An outside sender's message gets a grant (min of link level and person) that
rides `queued_message.grant_scope`: one grant per orchestrator wake, `orchestrator.tool` refuses
verbs outside it (`grantRefusal`), and such a wake has no shell; a workstream it spawns or steers
gets `grantScope` and runs with `agentPermissionMode: "ask"`. An unknown sender gets a one-time
pairing code (`pairing_code`; approve with `POST /api/integrations/pairing/approve`). The orchestrator
has `orca channels`, `post`, `thread link` and `ask-user`. A subscription's `digest_seconds` batches
its deliveries per fixed window (`delivery.digest_key`). `/api/slack` still posts at once as
you (`postAsUser`), not through the queue; `/api/orchestrator/event` stays for instance-to-instance
reports, scripts use a signed webhook (`/api/integrations/<id>/inbound`).

## Multi-repo (aggregated)

**Two GitHub accounts on one board** (a work account and a personal one for weekend repos): no
second instance, no switcher. `gh` holds several signed-in accounts per host (`gh auth login`
twice) with one active; a repo pinned to the other by `githubUser` in its RepoConfig gets that
account's token as `GH_TOKEN` in every process Orca runs under its paths — `gh`, `git -C`, agents,
previews (`server/env.ts` `githubEnv`, laid in by `runCmd`, `agent.launch` and `preview.start`;
the map is refreshed whenever a config becomes current). `GH_TOKEN` overrides the active account
for `gh` and for git's `gh auth git-credential` helper, so `@me`, PR creation, merges and pushes
land on the right account. Commit identity rides along as `GIT_AUTHOR_*` / `GIT_COMMITTER_*`: the app config's
`githubAccounts[login]` `{ name, email }`, each missing field from the account's GitHub profile
(`gh api user`: its name; its public email, else GitHub's noreply address) — no per-clone
`git config`.
Unset, nothing changes. The repo switcher shows `owner/name` once the repos span more than one
GitHub owner (`repoLabel`; `owner` on `/api/config` from origin). **The orchestrator can set a
repo up itself** (`orca repo list` — every repo each signed-in account can see; `orca repo add
<owner/name> [--on <instance>]`, `server/repos.ts`, the `/api/repos/add` route on the target
instance): clone under `ORCA_DEV_ROOT` with the account whose login is the owner (else the active
one), append a RepoConfig (default branch, `.worktrees`, `runsOn` that instance, `githubUser` when
the owner is a non-active account, no previews), save. Previews and `checkCommand` remain a hand
edit in Settings.

**The GitHub page** (`/github`, `GitHubPage` in `views/Pages.tsx`, nav item between Repos and Usage,
`G H`) shows one row per `gh` account signed in on THIS host (`GET /api/github/accounts`,
`repos.accountsHere` — per host, like `/api/usage`): the login, an `active` pill, the identity its
commits carry (`commits as Name <email>`) and the repos that use it (`repos.accountRows`: a repo
with no `githubUser` uses the active login). Name and email are editable per row; Save writes
`githubAccounts[login]` to the shared config (`POST`, `repos.setAccount` over the pure
`repos.withAccount`: trimmed, `""` clears a field, an empty entry is dropped), so an empty field
falls back to the GitHub profile. The only setup is `gh auth login` in a terminal — a device-code
flow Orca does not wrap.

`orca.config.ts` holds `repos: RepoConfig[]` (each with repoPath/worktreeRoot/baseBranch/
previewServices/slackChannel) + global portRange/staleHours. Every repo-scoped API call names
its repo (`?repo=` on GET, `repo` in POST body; server resolves via `repoOf`). The board shows
**all repos aggregated** — the store polls each repo and `useWorkstreams()` builds unified
rows tagged by repo (each row carries `repo`; actions use `row.repo`). Enrichment is keyed
`repo::branch`. The New-draft box has a repo **dropdown**; cards show a repo tag.

## No live terminal

There is deliberately no tmux/xterm lane. One existed per card (deleted as unused) and came back
once for the orchestrator's window (#96: Claude Code's TUI in tmux, streamed over a WebSocket) —
the user found it didn't work for them and had it reverted the next day. The orchestrator's panel
is the chat panel over its recorded turns; a wake is `claude -p --resume` on its session.

**One exception: the instance web terminal** (`server/terminal.ts`, `components/InstanceTerminal.tsx`).
It is a shell on a MACHINE, not a lane for a card: xterm.js over one WebSocket (`/api/terminal`) to a
real PTY (`Bun.spawn({ terminal })`, no library). The shell runs as the service user, in its home,
with `agentEnv()`. Its first use was `gh auth login` for a second account from the phone. The UX (v2;
Finn did not like #265's bare panel off an instance card):
- Entry: Settings → Instances. Each machine's row has the on/off Switch and Open terminal. A disabled
  Open says why on the row (`terminalBlocked`): off, no address, or a page on loopback.
- It opens like the orchestrator: the shared `SidePanel` (`components/SidePanel.tsx`, the same
  header, width rules and left-edge resize; width `orca.ui.v1.terminalWidth`). On a phone it is a
  full page with Back, swiped right to close. One right-edge panel at a time: each hides the other.
- It is mounted at the app's root and stays mounted while closed, so sessions survive navigation.
  Tabs: one per session, labelled with the machine (`terminalTabLabels`), + opens a new one on a
  chosen machine. Only a tab's ✕ ends a shell. The state is pure (`terminal*` in `workstream.ts`).
- The app theme and mono font (13px, 14px on a phone), the chat's padding, a status dot (connecting,
  connected, reconnecting, closed) and Reconnect. A dropped open session retries 3 times
  (`terminalRetry`); a server refusal is final. A phone gets the extra-keys row as shadcn buttons.
- Keys in the screen belong to the shell: the global shortcut listener skips `terminal-screen`.
Rules:
- It is OFF unless `terminal[<instance>]` is `true` in the app config. Only the Settings row sets it
  (`POST /api/config/terminal`). A pasted config document keeps the stored value.
- Each machine serves only its own shell. The browser connects to that machine's bridge directly
  (`terminalTarget`, addresses from `/api/config`'s `instanceUrls`, or the switcher's base). A bridge
  NEVER relays a terminal to another box (box-to-box traffic is blocked on purpose): a request that
  names another instance closes with `CLOSE.elsewhere`.
- Owner only: loopback, or an UNTAGGED tailnet user device (`tailscale whois`) of the owner. On an
  untagged machine that is the same Tailscale user. On a tagged box (`tag:orca`, whose own user is
  `tagged-devices`) it is a login in `serverSwitcher.allowedLogins`; with none named, nobody.
- The Origin must be a known Orca page: the host itself, an `instances` address, or a server the
  switcher lists (`trustedOrigins`). A local proxy's `x-forwarded-for` is the caller that is checked.
- At most 2 shells per instance. No input for 30 minutes closes the shell. The PTY closes with its socket.
- Start and end are logged (who, instance, time). Keystrokes and output are never logged.

## The one board & model

**The console is Vercel's, copied outright** (Finn's re-brief after the first, swimlane-ish
overview: "copy the design theme of Vercel completely and reuse all of their design decisions").
Theme: Geist Sans/Mono (a Google Fonts `<link>`, no dependency), softened Notion-style, pulled back
to a middle ground between Geist's flat grays and a first, too-soft pass after review (#134) —
`#f9f9f8`/`#fff` light and `#111111`/`#161616` dark, translucent hairline borders rather than flat
gray, the Geist grays elsewhere, 1px hairlines, no card shadows, `#0070f3` as the one accent,
status dots and pills as `--geist-*` tokens — all CSS variables in `styles.css`, so every component
inherits it. **Surface rules** (Finn found the first pass heavy-handed; `tests/console.test.tsx`
asserts them on every page): 1px hairlines only, never 2px; rows use dividers, never a box inside a
card's border; 8px cards (`rounded-lg`), 6px controls (`rounded-md`); 13px body / 12px meta; icons at
1.5 stroke (a global `svg.lucide` rule); NO shadows except Geist's menu / modal tokens
(`shadow-menu`, `shadow-modal`) and the orchestrator's side panel (`shadow-modal`); badges are tinted fills
with no border; buttons are Geist's three — primary (inverted; Merge too), secondary (hairline),
tertiary (ghost: every icon-only row / toolbar button). The agent page's conversation runs
full-bleed in its card and follows the page's theme (`.log-themed` remaps the terminal palette in
light mode). Every conversation — the agent page's Chat tab, a card's modal, the orchestrator's panel
and page — is ONE `ChatPanel` in ONE styling (bubbles; replies under the agent's name, `author`
"Orchestrator" for it); only `size` (page | panel) and the composer's wiring differ. Shell (`components/Shell.tsx`): a collapsible left sidebar (instance switcher
all/local/cloud scoping the pages, Find — the `F` key — which filters Agents, the nav Overview /
Agents / Previews / Repos / Usage / Settings, then **Add New** as the last action, above the divider — a modal `<dialog>` holding the New-draft box
(`C` opens it; it is the portal container for the composer's selects, since a modal leaves the rest
of the page inert; sending closes it and leaves "Sent to … · Undo" for 6s; the typed draft persists) — and
below it you on one thin line — "You · local" — with the collapse toggle;
collapsed it is one icon column, expand toggle above you; off-canvas when narrow; `⌘B` / Ctrl+B
toggles it, remembered) and a top bar (repo switcher, breadcrumb, and **Ask the orchestrator** at its
right on every page — Vercel's "Ask AI", as a BUTTON: it opens the orchestrator's side panel with its
composer focused. It was a text box whose keystrokes carried into the composer; the quick-ask pill
below now covers "fire off a line"). **The quick-ask pill** (`components/QuickAsk.tsx`, the `A` key):
a small "Ask · A" pill fixed at the bottom centre of the main column (its strip starts where
the sidebar ends, collapsed or expanded) on every page (desktop; below md the phone's bottom
bar has the orchestrator instead) MORPHS (one surface: width, height, radius; instant under reduced
motion) into a box for messages to the orchestrator with no history — "Ask the orchestrator...", a
textarea three lines tall that grows to a cap (a JS fallback where `field-sizing` is unsupported), no ✕. Its input
IS the shared `ChatComposer` (`variant="quick"`, never a fork), so the `@` PR picker, attachments,
paste, Enter sends / Shift, ⌘ or Ctrl+Enter breaks the line and focus are the chat composer's; the
picker is portaled out of the surface's `overflow-hidden`. A pointerdown outside the box closes it like
Esc (the draft is kept) — not one in the box, in the `@` picker or a Radix popover, nor while "Sent"
shows. The agent icon sits top left with the text
the whole width beside it; the row below is every composer's toolbar — the orchestrator's model picker
and context ring (`ChatControls`, fed by `useOrchestratorState`, the side panel's own status poll, so a
model change there is the panel's), the "Sent · Open chat" receipt, attach, and a Send button
carrying the `send` keycap. Only its look differs from the panel's composer. Collapsing keeps the box's contents mounted through the morph —
faded, inert, pinned at their width — and the pill fades in after (`MORPH_MS`); swapping them at once
made the exit janky. A send is optimistic: the box clears and stays open, a brief "Sent · Open chat" fades, and
the POSTs are chained so quick sends arrive in order (a busy orchestrator queues them); a failed send
gives the text back. Every orchestrator sender (quick-ask, the panel's and the phone page's composer, the New-draft
box) goes through ONE outbox (`lib/orchestratorOutbox.ts`), which the panel draws as `sending…` at once
and drops only after re-reading its newest page and queue — a message queued behind a busy wake
publishes no event, so the panel (mounted while closed) once showed it only when the wake ended. The top-bar button and the phone's bottom bar (never the pill) carry the orchestrator's
**activity dot** (`ActivityDot`: pulsing while a wake runs, lit once one finished while the panel was
closed, cleared when it opens), fed by ONE subscriber (`useOrchestratorActivity` in the Shell: a
status read on mount, then one per `turn` event on the tab's shared stream — no poll of its own).
**Keyboard** (`lib/shortcuts.ts`: ONE table + a pure matcher; ONE listener, `Shortcuts` in
`components/CommandPalette.tsx`): `⌘K` / Ctrl+K the command palette, `C` New agent, `O` the
orchestrator, `A` quick ask, `F` Find, `⌘B` the sidebar, `?` the shortcuts sheet, Esc closes the
overlay (the quick-ask box first, then the panel) — with none open it blurs the focused text field
(`escapeBlurTarget`), after anything that took Esc first (the `@` picker, a menu, a native dialog). Letters
and ⌘B never fire in a field or inside a modal dialog (they'd eat a keystroke of the message); ⌘K and
Esc fire everywhere. **Every open path goes through `openOrchestrator`** (`lib/orchestratorOpen.ts`): the composer focuses
in a layout effect in the commit that opens it, and keys typed before that are held by a short
typeahead and forwarded in order (typing "Sometimes" straight after O once gave "ometimesS").
**O, not ⌘J**, for the orchestrator: ⌘J / Ctrl+J is the browser's Downloads
(Chrome on Windows/Linux, Firefox), and a bare letter can't clash with a browser or a composer; from a
field, ⌘K → "Open orchestrator" is one key more. The table also feeds the tooltips, the palette's
hints and the `?` sheet, so a key can't be documented in one place and bound in another. **Every
visible hint is the ONE keycap** (`components/ui/kbd.tsx`: `Kbd`, `KbdGroup`, `<Shortcut id>` from the
table with ⌘ on a Mac / Ctrl elsewhere, `MenuShortcut` for a menu's or palette row's right-aligned
slot) — a fixed-height, `self-center` chip, never an ad hoc `<kbd>`; the profile menu lists Command
palette and Keyboard shortcuts with theirs. **The
palette** (⌘K, a native modal `<dialog>` with `shadow-modal`, like Add New): fuzzy search over
workstreams, PRs, pages and actions (New agent, Open orchestrator, Toggle sidebar, switch repo /
instance, Start preview for the workstream whose page you're on); ↑/↓ wrap, Enter runs; empty, the
recently run items lead (persisted); a query with no good match can always go to the
orchestrator as a prefilled message (offered last, never above a match). Ranking is pure
(`lib/palette.ts`). The overlays' open state is jotai atoms (`lib/atoms.ts`), so a key, a button and
the palette open the same one. **Previews** is a page (running previews with Open / Stop, and Test
master per repo); its nav item carries the badges the old header buttons had — the running count
and a spinner / dot for a base-branch preview — from one shared `/api/previews` poll
(`usePreviewList`). The
orchestrator's side panel is rendered outside the shell (`App`'s `OrchestratorPanel`). Building blocks (card, ring,
status dot, pill, details grid, line chart) are `components/console.tsx`.
- **Overview** (`/`, `views/Overview.tsx`): a Usage card — Claude per window as ring + value / limit
  rows (the fleet, every hydra login on expand) and Codex; it REPLACED the header usage meter — one
  card per machine (`views/Vitals.tsx`: a details grid plus CPU % / memory GB line graphs over
  6h/24h/7d from `/api/health/history`; it replaced the header's cloud chip), ONE Agents card with
  the four numbers (running, needs attention with its reasons, open PRs by state, merged today —
  each opens the Agents list filtered to exactly that), and Recent activity. **Needs attention**
  (`attentionReasons`): check failed, conflicts, CI red, changes requested, a run error or stop, or a
  message held behind a run that isn't coming (`/api/agents` attaches each branch's undispatched
  count, `db.queuedCounts`). The Usage card's per-login breakdown is a remembered toggle (the
  chevron at its foot or its header row, `orca.ui.v1.usageExpanded`); each machine card's range is remembered per machine (`orca.ui.v1.instanceRange:<instance>`). The first cut's
  separate Awaiting-you tiles were dropped as redundant. **Loading states are skeletons, not text**:
  the Agents card's four stat tiles (`StatSkeleton`), the Usage card's rows (`RowSkeleton`) and each
  machine's CPU/memory graphs (`ChartSkeleton`, `components/console.tsx`) render placeholders sized
  like the real content — nothing shifts once the first poll lands. "Not loaded yet" is tracked
  SEPARATELY from "loaded, genuinely nothing" (`useWorkstreamsLoaded` in `store.ts`,
  `useUsageLoaded` in `lib/vitals.ts`): both `useWorkstreams()` and `useUsage()` read `null`/`[]` for
  either case on the wire, which the skeleton can't tell apart from the real value alone.
- **Agents** (`/agents`, `views/Agents.tsx`): Vercel's Deployments list — one-click **quick
  filter chips**, grouped into families with a muted caption (State: Open PRs, Mergeable, Merged
  today, Not merged; Activity: Running, Needs attention; Repo: one per repo; AND across groups, OR
  within one, each with its count) held in the URL query (`?status=attention&pr=open`,
  `parseQuickFilter` / `quickFilterQuery`), so a filtered view is a link and the Overview's numbers
  open exactly their chips. The Mine/Orchestrated and per-instance pills were dropped as redundant
  with the row's own orchestrated badge and instance column — their `by`/`on` URL params and pure
  filtering logic still work for a link someone already has, just with no pill to toggle them.
  search, sort; one ~56px row per workstream (repo
  icon + title, latest instruction, status dot + duration, state pill, CI/conflict badges + the
  review cluster, PR, branch, instance, updated, the model as avatar); every action in the trailing
  ⋯ (`WorkstreamActions menuOnly`). The swimlanes stay behind a persisted List | Board toggle.
- **Agent page** (the existing `/{repo}/prs/:n` and `/{repo}/local/:branch` routes,
  `views/AgentPage.tsx`): ONE compact sticky header row (`AgentHeader`: repo / title, status, branch
  or PR link, the actions) with the tabs Overview | Chat | Files | Preview directly under it, flush
  under the top bar (which is opaque), so the Chat tab's conversation gets the rest of the viewport
  (`CHAT_FILL_HEIGHT`); a Details card with
  the failure box where Vercel shows "Build Failed" (`agentFailure`: the run's error, else the
  failed check), Created / Status / Duration / State / Model / Instance / PR / Preview and the
  Source (branch → base, latest commit); then the conversation where Build Logs sit (`ChatPanel
  logBar`: timestamped, tinted turns and the composer, full-bleed to the viewport's foot — no toolbar;
  the error / warning counters and Find in chat were removed as unclear).
  A PR's Overview then has Review, **Checks** (no tab of its own any more: failing, then running,
  passing + skipped folded into one expandable line — `checkGroups`), Description and the
  **Conversation** (`prConversation`: chronological like GitHub, a counts line + Jump to unresolved,
  resolved / outdated threads on one line, long bodies behind Show more, bots in ONE folded row).
- **Repos**, **Usage** (every login, every machine) and **Settings** (theme, density, the
  read-only config). The Usage page shows the SAME `UsageCard` as the Overview — the high-level rows,
  with every hydra login behind the one remembered chevron (`orca.ui.v1.usageExpanded`, shared by
  both pages).
Every number is a pure derivation over the assembled rows (`workstream.ts`: `overviewStats`,
`attentionReasons`, `filterRows`, `sortRows`, `recentActivity`, `usageGroups`, `rowDuration`,
`repoSummaries`, `agentFailure`) — no endpoint of its own, so the views can't
disagree. Usage, health and health history are one shared poll each (`lib/vitals.ts`
`sharedSource`; history only while a card shows it). Each PR row also carries a **review cluster**
(approvers, `N unresolved`, a severity dot) and the PR page a **Review panel** — `reviewDigest`
over `GET /api/prs/:n/review-signal`, fetched lazily per rendered PR (`store.useReviewDigest`).
**The phone** (below md, 768px — `lib/viewport.ts` `useNarrow` / Tailwind `max-md:`, so nothing changes
at desktop widths): a bottom bar (Menu · Agents · New agent · Orchestrator) replaces the top bar's Ask
box; Agents rows stack with every action in the one ⋯ and the chips + sort in a Filters bottom sheet;
the orchestrator, the terminal and Add New are full-screen `sheet`s sized to the visual viewport
(`--vvh`, so the composer clears the keyboard; no resize / PiP; the quick-ask pill is hidden — the
bottom bar's Orchestrator carries its dot); small menus and selects (the repo switcher, the server
menu, the profile menu, the model picker…) anchor under their trigger as on desktop, and the top bar
stays put while one is open (Finn found a bottom sheet for them jarring; `styles.css` keeps Radix's
scroll lock from making the body a scroll container, which scrolled the sticky bar away). Only the
large menus are a `BottomSheet`: the Agents Filters sheet, and a workstream's ⋯ (Agents row, agent page header) opens a real `BottomSheet` of large icon rows,
the SAME items fragment as the desktop dropdown (`WorkstreamActions`' `Item`/`Sub` switch on a
context), and only on a tap: a long-press / contextmenu never opens it (it popped while scrolling),
nor a touch's contextmenu on desktop rows; inputs are 16px, touch targets 44px, Enter on a touch screen
is a newline. A `BottomSheet` slides up on the sheet spring and down before it closes (reduced motion:
instant), with a haptic tick. **Every drawer and sheet dismisses by a swipe toward the edge it comes
from** — ONE hook, `useSwipeToDismiss(edge, …)` (`lib/gestures.ts`; decisions pure in `workstream.ts`
`swipeOffset` / `swipeArm` / `swipeDecision`): its header follows the finger, and its scrolling body
joins in only when the move is mostly along that axis and the content is at its start. Bottom sheets,
Add New and the image lightbox (header + body), the terminal (header only: its chat scrolls) swipe down;
the orchestrator's right-hand panel swipes right on a touch screen only. Pull the Agents list down to
refresh. It installs as a PWA
(`web/public/manifest.webmanifest`: round icons plus a full-bleed maskable one, New agent /
Orchestrator shortcuts as `/?open=…`). `vite build` writes `version.json` and `sw.js` (from
`web/sw.template.js`: this build's shell + hashed assets precached, `offline.html` with neither, and
**never** `/api` or `version.json`); a new build's worker waits until the "new version · Refresh"
banner tells it to skip waiting. A service worker needs a secure context, so over the plain-http
tailnet it stays inert (and Android won't offer an install) until that has HTTPS. Standalone CSS: no
overscroll, no tap delay or flash, chrome not selectable. A hidden tab polls nothing; the top bar says
when the board is stale ("Updated 3m ago" — a button: **Refresh everything**, `lib/refresh.ts`: every GET in
`api.ts` is tracked and one in flight >3s is aborted, every `poll()` and `onRefresh` source — the board's
streams, usage, notifications, an open chat, cached review signals — re-runs at once, the icon spins until
all settle, and past 15s it hard-reloads); an unreachable bridge shows the offline screen.

The board (`web/src/views/Board.tsx`), lanes: **Local → Draft → In Review → Mergeable → Done·today**.
A workstream is a branch; its lane (`store.laneFor`):
- **open PR, draft** → Draft. **open PR, approved** → Mergeable. **open PR, else** → In Review.
- **no PR** → Local, until Promote (local repo: sets `promoted`; then Mergeable if `git merge-tree`
  is clean, else In Review). **merged today** (server-local calendar day) → Done (`gh pr list --state merged`).

Actions (all via `ActionButton`, spinner → ✓/✗, no double-fire):
- **A failed action is a notification, never text in the row** — kind `action_failed`, in the ONE
  notification toast stack and the bell's centre (see Notification centre; there is no second,
  bottom-right stack any more — Finn found two inconsistent). It is LOCAL (`notificationStore`
  `actionFailed` / `notifyLocal`: a negative id, never stored nor sent to the bridge — your click failing
  is news to this browser only), persistent until dismissed, and the same failure while unread is
  re-popped, not stacked twice. Card = repo · workstream, labelled with the verb (`Merge failed`),
  body = the message; quick actions **Ask the orchestrator** (the #128 `ask`, prefilled `Action …
  failed: … Please investigate and fix.`) and **Copy** (message + repo/branch/PR/action), then Open.
  The button keeps only its ✗, first line as tooltip. Covers `WorkstreamActions` (Merge, Slack, Move,
  …), `ActionButton` with `failure`, a preview's start / stop / add-label request, and the Usage
  card's login switch. NOT a preview crash: the bridge's watcher already reports it as
  `preview_failed`, so one crash is one notification.
- **Enable auto-merge on a repo that disallows it** (`Auto merge is not allowed for this repository`):
  `enableAutoMerge` squash-merges directly if `mergeSafe`, else rethrows with "enable auto-merge in the
  repo settings, or merge when green". The stacked fallback still comes first.
- **Promote** (Local, remote repo) = a dropdown: Create PR ready / draft, ± add preview label.
  Local repo → plain Promote (sets `promoted`).
- **Address PR / Follow up** = launch the selected provider headlessly in the branch's
  worktree. **Address PR is the one agent verb for a PR** (`store.addressPr`, `addressPrPrompt`): a
  single run that resolves merge conflicts, fixes failing CI and addresses the review — whichever
  apply, in that order — instead of three buttons the user had to triage between. Resolve conflicts
  remains on its own only for a LOCAL branch with no PR. **A changelog-only conflict never reaches
  the agent** (branch-demo #6189 spent five runs re-merging one CHANGELOG hunk where both sides added
  an entry under the same heading): before either verb, Orca merges the base into the worktree itself
  (`POST /api/conflicts/settle` → `verbs.settleConflict` → `git.mergeBaseUnioningChangelogs`, on the
  worktree's instance). If every conflicted path matches the repo's `changelogFiles` globs (default
  `**/CHANGELOG.md`, `[]` turns it off), each is resolved by `git merge-file --union` — both sides'
  lines, ours first — then committed and pushed; a clean merge is pushed too. If that leaves nothing
  else (no failing CI, threads, comments or change request), NO agent starts (`status: "resolved"`,
  a self-hiding local notification); otherwise the agent runs without the conflict section. Any other conflict, a dirty
  tree, a running agent or a rejected push leaves the worktree exactly as it was, and the agent
  gets the conflict as before. A manual Address PR with no conflict still always runs. They
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
   The Usage card's per-login row has a hover switch (`POST /api/usage/profile`, per host) to take a
   login out of hydra's rotation — still signed in, just skipped by this ladder — or put it back. A login
   whose access token lapsed reads "token stale" (hydra only reads usage; Claude Code renews tokens
   when it launches), so Refresh on a Stale row and a 30-minute pass on each primary bridge
   (`usage.renewStaleLogins`, enabled logins only) renew it with ONE minimal launch under that login
   (`renewToken`: `hydra exec <name> -p` on haiku, no tools, empty temp cwd, output discarded); still
   stale after that means the refresh token is gone — `hydra login` — and a 429 is reported as
   rate-limited, not stale.
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
- **Cleanup after finished work** (`verbs.cleanupRepo`, run by each instance's agents poll / publish
  tick for ITS OWN worktrees): a merged or closed PR's worktree is reaped after `CLEANUP_GRACE_MS`
  (10 min, from `mergedAt`/`closedAt`) and never while an agent runs on it — preview stopped, placement
  cleared, a merged branch deleted (a closed one kept), the card archived. **Nothing that would lose
  work is removed** (`cleanupDecision`): uncommitted changes, or commits on no remote, not in base and
  not the PR's last head (`git.worktreeSafety`), flag the card (`cleanupBlocked`) instead. `orca
  archive` goes to the worktree's home instance (`/api/workstreams/archive`). **`orca sweep
  [--confirm]`** (`/api/cleanup/sweep`, fanned out to every instance) is the one-off: finished
  worktrees, previews with nothing behind them and Orca's own branches left with no worktree or open
  PR — a dry-run report unless confirmed, same safety, no grace period.

Agent runs are killed on discard and on server shutdown (SIGINT/SIGTERM) so restarts don't orphan
them. Routing: `/` = board, `/{repo}/prs/:n[/chat|/files|/preview]` = PR detail (an old `/checks` lands on Overview),
`/{repo}/local/:branch[/files|/preview]` = local-session detail.

**Terminal (the conversation)** — `web/src/components/Terminal.tsx`'s `TerminalDialog` is a modal
opened from the card's terminal button, rendering `ChatPanel` (`web/src/views/Chat.tsx`): the branch's
whole conversation from `GET /api/turns` in the orchestrator's chat styling (your messages as bubbles,
the agent's reply under its provider's name), plus the follow-up `ChatComposer` to send the next
message. Every `ChatComposer` has the **`@` PR picker** (`prTrigger`: `@` at the start or after a
space/bracket lists the board's polled PRs; a pick inserts `#123`, or `repo#123`). It opened on `#`
until Finn asked for `@`; `#` now opens nothing. It is NOT a live shell — it renders the turns Orca already records, so nothing tmux is
involved. Orca still hosts no chat *runtime* — the composer fires the same headless one-shot every
board action uses. A turn written at launch but not yet finished renders as `▋ working…` (that's how
an interrupted run stays visible); a turn with a parsed outcome renders its sections. A Claude run's
reply types out live: `--include-partial-messages` text deltas are pushed as `delta` events (never
stored; the whole message's step replaces the draft). A finished reply must render from the stream
alone: the chat applies only its NEWEST page request (a slower, older answer once reverted a finished
turn to `working…` until the next send), every `ready` re-reads the newest page, and an EventSource an
HTTP error closed for good is reopened (`lib/events.ts`). **The composer
is never busy:** a send clears the box at once and the next message can go while the launch is still
in flight (seconds, longer over the tailnet) — the log's `▋ sending…` line, until the bridge has it as
a running turn or a queued entry, is the receipt. (It used to go busy until the launch returned, and
Enter did nothing meanwhile.) A failed send comes back into the box if it is still empty, else into
the error line (`<error> — not sent: “<text>”`), so neither message is lost. (History: this
was briefly a detail-page "Chat" tab; the user asked for it as a terminal-style modal instead, and the
tab was removed. The Vercel re-brief brought it back on the agent page — as its Chat tab and in
Build Logs' place — alongside the modal, which the Board's cards and New chat still open.)

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

**Ask the orchestrator** in the top bar (every page), the `O` key, the palette, a failed action's
toast and the quick-ask box's "Open chat" open a **right-hand side panel** that slides over the page
(`OrchestratorPanel`, `components/Terminal.tsx`: a `transform`, so nothing reflows; `role=dialog`
`aria-modal=false` — no backdrop, the board it is moving stays visible and usable; Esc or ✕ closes
and focus returns to the opener; resized from its LEFT edge, width remembered as
`orca.ui.v1.orchestratorWidth` and clamped to the viewport by `clampPanelWidth`). Once opened it
stays MOUNTED while closed (slid out, `aria-hidden`), so reopening is instant with the transcript,
scroll position and draft where you left them. Its chat is `ChatPanel variant="chat"`: an
assistant-chat styling in the page's theme (`.log-themed`) — your messages as `bg-accent` bubbles on
the right, replies under "Orchestrator" with a bot avatar, folded steps and `⚙` worker reports,
day dividers (`dayLabel`), timestamps on hover, and a long message of yours cut to its first lines
behind Show more (`longMessage`). **One stream, worker traffic split out**: your
messages and its replies to them read as the conversation; each run of agent turns (the wakes worker
reports caused and its replies) is ONE collapsed, blue-tinted `⚙ 3 worker reports · 2 replies` block
that opens in place, and a wake that carried your message AND reports puts your words in the bubble
with the reports as their own collapsed block above it (`WorkerBlock`; `chatItems` / `agentsMarker` in
`workstream.ts`). Held reports and your queued messages both show. (History: a Chat | Agents toggle
split these into two channels; a wake carrying your message and reports counted as yours, so most
worker traffic never reached Agents, and the user asked for this instead.) The split rides
`turn.source` (`human` | `agents`, `shared/agent.ts` `TurnSource`; migration 18 — 16 and 17 were held
by open branches — backfilled from the stored text): `human` is anything you said (typed, quick-ask,
the palette, a toast's Ask, the New-draft box, Compact), `agents` a wake whose every message is a
`[worker finished]` report (`turnSource`, decided in `orchestrator.wake`). A row without it is read
off its instruction the same way (`sourceOf`). (History: a modal, then a draggable/resizable corner
window with the dark terminal styling — one more thing to place and keep out of the way.) Its composer
carries a model
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
**Pop out** (kept: it costs one button on the portal) moves it into an always-on-top Document
Picture-in-Picture window
(Chrome/Edge 116+) via a React **portal**: the same tree, so draft, SSE, popovers and keys carry
over. The page's stylesheets are copied into it and `<html>`'s class/style mirrored (theme). Radix
popovers/selects portal into it through `PortalContainer` (`lib/utils.ts`). Return to tab or its own
close brings it back (an ask while popped out lands in the PiP composer), and its size is remembered.
(History: a floating round launcher in the corner opened it; the top-bar entry replaced it — two
ways to do one thing, and the launcher covered the corner the window sat in. The quick-ask pill is
not that launcher: it sends a line without opening the conversation.) Browsers without the API get no
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
  Either way it **cannot promote or Slack through Orca, and merges only through the merge queue**
  (`orca merge --when-green`, below — never `gh pr merge`); the rest stay your buttons. Code
  changes to a repo go to a workstream — a worker owns its branch. Claude only (workers keep their
  per-card model). What it gets from its cwd (`~/.orca/orchestrator`): a `CLAUDE.md` there (yours to
  write) is read as standing orders alongside the role in the prompt, a `.mcp.json` there is its
  project-scope MCP servers, and Claude Code's own auto-memory accrues under that cwd; user-level
  `~/.claude` config loads as in any session.
- **`orca`** (`bin/orca` → `POST /api/orchestrator/tool` → `orchestrator.tool`): `board`, `spawn`,
  `send`, `address`, `archive`, `sweep [--confirm]`, `preview` (`--status`; and `--push-to-template [--confirm]`,
  `server/pushTemplate.ts`, which makes a preview's whole database the repo's `PREVIEW_TEMPLATE_DB`
  — old one kept as `<template>_bak_<ts>` — and writes its integration env vars back to the main
  checkout's copied `.env`; dry run without `--confirm`, values masked — README), `merge`
  (`--repo r (--pr N | --branch b) --when-green [--small]` or `--cancel`: the merge queue), `chats`,
  `read`, `notes`.
- **Merge queue — merge on green with nobody watching CI** (`server/mergeQueue.ts`, decisions in
  `workstream.ts` `mergeVerdict` / `mergeRefusal`). A PR — or a branch with no PR yet — is MARKED
  (`mergeWhenGreen` on its enrichment, so shared and restart-proof) by `orca merge --when-green`, the
  PR menu's **Merge when green**, or `POST /api/prs/merge-when-green`. Each minute the instance the
  repo runs on reads every marked PR with one `gh pr view` and squash-merges it only when every check
  passed (no checks yet is NOT green — a fresh push has none) and GitHub says `MERGEABLE`. Red CI or a
  conflict keeps the mark (fixed and green, it merges) and is reported once per head commit: the
  `pr_ci_failed` / `pr_conflicts` notification (same key as `/api/prs`'s, so one row) and, for the
  orchestrator's PRs, a `— merge blocked:` worker-problem report that wakes it. A merge is a `merged`
  notification and a clean `— merged` report (batched like a finish). **The policy is per-repo
  config, not prose in its notes:** `mergePolicy: { whenGreen: "never" | "small" | "any", denyPaths:
  [globs], autoPr }` — absent means never; `small` takes only PRs marked `--small`; a PR touching a
  `denyPaths` glob (e.g. `server/db.ts` for migrations, `server/cgroup.ts`, `deploy/`) is refused
  when marked AND re-checked at merge time (a later push can add one), unmarked, and notified
  (`merge_refused`). `autoPr: true` has an orchestrated worker's clean finish (done, check not
  failed, commits ahead of base, no PR yet) open its PR itself (`verbs.openWorkerPr`: title from the
  card, body from the outcome + commits, ready not draft), and the worker report says `Orca opened
  PR #N` — so the orchestrator never opens one by hand, and a branch it marked earlier joins the
  queue.
- **Automatic PR upkeep — Address PR with nobody pressing it** (`server/upkeep.ts`, decision pure in
  `workstream.ts` `upkeepDecision`). The orchestrator used to `orca address` a PR only when something
  happened to wake it, so PRs sat conflicting or red between wakes. Now a minute tick (beside the
  merge queue's, never on a preview bridge) looks at every open, non-draft PR of an ORCHESTRATED
  workstream whose worktree is on THIS instance (`verbs.addressPr` is local, and the cap is about this
  box's memory) and runs `verbs.addressPr` — the button's and `orca address`'s path, not a second
  implementation — on conflicts, a failed REQUIRED check (`listPrs`'s `ciStatus`) or actionable
  unresolved threads not yet handed (`unhandedActionable` vs `handedReviewThreadIds`, so a thread the
  agent answered but nobody resolved doesn't re-fire every push). Guards: not while the agent runs or
  has queued messages; not when `orchStatus.waitingOn` names the user (`waitingOnUser`); one address
  per (head, reason); two per head, or one whose reason stands with nothing new, then GIVE UP; four in
  a row across heads without a settled healthy look (`UPKEEP_MAX_STREAK` — a pending CI is not
  healthy, or a fix that's red on every push would loop); `autoUpkeepConcurrency` (app config,
  default 2, 0 = off) runs at once. Opt out per repo `autoUpkeep: false` (default on) or per branch
  `upkeepOff: true`. The record is enrichment `upkeep` (no table), written BEFORE the launch so a
  restart can't re-fire; the card shows `upkeepLabel` (`auto-addressing: conflicts` / `auto-upkeep
  gave up: …`). Notifications `auto_address` (start) and `upkeep_gave_up` (persistent, Address PR).
  The merge queue's decisions are untouched.
- **Its role text is judgement-first.** It is told it is a senior engineer running a team, given
  the trade-offs (send to an existing workstream vs spawn; one branch per mergeable unit) and left
  to decide. An earlier, rule-shaped version ("do not spawn for something a workstream owns") made it
  spawn a second workstream rather than ask the first to adapt — the user wants it free to decide.
- **Stability.** Two things once made runs look like they died. (1) The dev launcher restarts the
  bridge on a change to THIS checkout (it used `bun --watch`; now `scripts/supervise.ts` — see
  Deploying), so a change restarts it under in-flight runs. The agent
  processes survive that; what died was the bridge's view of them — the stdout reader and the exit
  handler that records the result, runs the check, wakes the orchestrator and sends the queue — so
  finished runs sat "running" (zombie children kept their leases live until expiry) and a wake
  killed mid-turn (exit 143) looked like the orchestrator leaving. Now `agent.adoptLeases` runs at
  startup: every live lease is shown running and, when its process exits, its turn is finished from
  the provider's session file and the normal after-run path fires (minus the check gate). The
  orchestrator's own wake is `orchestrator.recover`'s. `lease.pidAlive` treats a zombie as dead.
  (1b) **Reaping a merged PR's worktree SIGTERMed the orchestrator** (the 143s of 2026-10-13, each
  seconds after it merged a PR): the reaper's `killByBranch` killed every headless agent whose ARGV
  contained the branch name, and the orchestrator's prompt — the board, listing every branch — is
  in its argv. `agent.killInWorktree` matches by the process's cwd (`/proc/<pid>/cwd`, else `lsof`)
  instead, and leaves a process whose cwd it can't read alone. Never match agents by argv text.
  (2) There was a per-wake `--max-budget-usd` (5, then 25) and a long resumed session hit it
  mid-reply several times a day; **there is no cap unless `orchestratorWakeBudgetUsd` is set**.
  Also: a lease records its `sessionId` and `launch` refuses a resume while another live run is on
  that session (`lease.sessionBusy`) — two runs on one session both end with the same reply, which
  was the "one message behind" bug.
- **One primary bridge per instance** (`server/primary.ts`; incident 2026-10-14: four hand-started
  bridges from reaped worktrees kept running stale code on the shared database, and one woke the
  orchestrator with a deleted `bin/` on PATH). Background duties — orchestrator wakes/recovery, the
  run-finished hook, merge queue, upkeep, cleanup + reaper, autofix, inventory/preview/metrics
  publishing, lease adoption, preview reattach — run only in the bridge holding the instance's
  `pg_try_advisory_lock` (its own one-connection client; secondaries retry every 5s, so a restart's
  new process takes over). A secondary serves HTTP only and answers 503 to an orchestrator wake. A
  bridge whose code is under `.worktrees/` never contends unless `ORCA_PRIMARY=1` (test bridges set
  it); one whose source directory vanishes exits. The orchestrator's PATH is the main install's
  `bin/` (`mainBin`, via `git --git-common-dir`) and its `ORCA_URL` loopback + this primary's port.
  With the database unreachable at boot nobody holds the lock, so duties wait for it. `/api/config`'s
  `bridge` reports `primary` / `reason`. Workers run Orca only via `scripts/preview-orca.sh`.
  **Stray preview bridges** (incident 2026-10-15: a preview bridge on pre-#215 code ran 19h after its
  worktree was deleted, running the merge queue and launching the orchestrator's wakes): `held()` is
  false in a preview bridge even unelected, `agent.launch` refuses there, and each duty checks
  `held()` itself. A bridge exits when its checkout goes (`primary.checkoutGone`: source, git
  registration or cwd) and `preview-orca.sh` then exits rather than forwarding; it won't start a
  branch bridge older than #215. Removing/reaping a worktree stops Orca bridges whose cwd is in it
  (`proc.stopBridgesIn`); `orca sweep` lists bun processes on a deleted cwd and `--confirm` stops
  them. For bridges too old for any of that, the primary checks each minute that the orchestrator's
  live wake descends from ITSELF (`orchestrator.evictForeignWake`); another bridge's, seen on two
  checks in a row (a restarting primary drains for seconds), is stopped with its wake, which
  `recover` re-queues.
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
- **The ladder moves on evidence, not only its judgement.** An orchestrated worker that fails twice
  in a row on one model (the run errors, or its commit fails Orca's check — a stop is neither) gets
  a `Model ladder:` line in its report (`ladderStep`, the streak as `failStreak` on its enrichment,
  counted even when an autofix takes over): the next model up to retry on, or — with the repo's
  `modelEscalation: "apply"` — the workstream already re-pinned to it, so the orchestrator's next
  `send` runs there. At the top (Fable) the line says to stop and tell the user. A clean run ends
  the streak; a model off the ladder (Codex, Cursor) gets no line.
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
  message was only worker reports is an Agents-channel turn (above): muted `⚙` system lines with the
  report folded, not a `❯` prompt. It is asynchronous by design: it spawns, ends its turn, and is woken; it never polls.
- **One wake per batch.** Its runs launch with `queue: false`; everything that arrived while it
  worked (worker events, your messages) is drained into ONE resumed run — but each message stays its
  own: they are joined with `MESSAGE_BREAK` (`joinMessages` / `splitMessages`), not a blank line, so
  three sends are three bubbles in the chat and "N separate messages" to the model (a blank line
  merged them into one in both; rows from before keep their old reading), and deliveries are
  serialised so two workers finishing together can't race a launch. In that run's prompt what you
  said and what the workers reported are separate labelled sections, yours first — `## From the
  user`, then `## Worker reports` (each report verbatim) — so the model never reads a report as an
  instruction from you, or the reverse (`orchestratorPrompt`).
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
  was cut off` plus `## What the cut-off wake did` (`wakeProgress` over the steps it recorded as it
  went — they are in Postgres, so this covers a death with the bridge too): each acting command it
  ran (`orca spawn/send/address/archive/move/merge/preview/notes set`, `gh pr merge/create/…`) with
  the first line of its result or "no result recorded", then the reply it had started — so it
  neither repeats an action nor leaves you without the answer. A message whose wake dies twice (`died`) is NOT queued a third time; the line says
  to send it again. A restart is detected at startup (`orchestrator.recover`): a claim with no live
  lease whose turn did not end on text was cut off; one that outlived the bridge and finished is
  just drained. Stop is not a death. The header (panel and page alike) carries a live status line
  (`orchestratorStatus`): Idle, or Working · elapsed, then `N queued` and `N workers running`
  (orchestrated rows running, from the board's own poll); the last wake's spend and, once a wake
  costs half the cap or the context is half full, the hint that a fresh session would be cheaper
  (`sessionHint`) are its TOOLTIP, the hint shown only as an amber dot — a hint only, nothing is reset. The ledger records `costUsd` per run and
  `errorKind` `budget` / `timeout` instead of one `nonzero-exit`.
- **The session is disposable.** Its notes (`orca notes set`, stored in its workstream blob) and a
  fresh board go into EVERY wake prompt; the role text only when a session starts. So the ladder
  applies as for any conversation — resume while healthy, reset onto the portable transcript at 80%
  context — and a reset loses nothing it was told to keep. If it seems amnesiac, read its notes
  before blaming the model.
- **Per-workstream state is structured, not notes** (`orca status --repo r --branch b [--plan …]
  [--waiting …] [--merge small|needs-finn] [--clear]`): a short orchestrator-owned record on the
  workstream's enrichment (`orchStatus`, 300 chars a field — `orchStatusUpdate` / `orchStatusText`),
  on its board line every wake and on the user's card / Agents row (`OrchStatusNote`). The notes keep
  only the user's preferences and standing facts. The merge class is a label for the user; the
  merge queue still reads only `--small` and the repo's `mergePolicy`.
- **Memory of past work** is the turn table: `orca chats "<terms>"` is Postgres full-text over every
  instruction and response, archived workstreams included; `orca read` loads one on demand
  (just-in-time retrieval, no embeddings, no index yet).
- **Limits to know:** it acts only on repos its own instance runs (no forwarding); two instances
  must not both drive it at once (the run lease is per host); a worker's outcome text is model
  output fed to something that can spawn and send, which is why its authority stops there.

## Notification centre (toasts + the bell)

Flat notifications — one row per event, no threads — in a `notification` table (migration 15 — 13 and 14 were taken by branches open at the same time; `migrate()` tolerates the gap) shared
by both instances, so either machine shows the same centre. **One emitter, `server/notify.ts`**: the
row is written once (`db.addNotification`, idempotent on the event's `key` — `run:<runId>:<kind>`,
`check:<runId>`, `preview:<key>:<startedAt>:ready|failed`, `pr-ci:<repo>#<n>@<head sha>` — the commit, not the failing-check set, which flaps,
`pr-conflict:<repo>#<n>` — so a run finished twice by a restart's lease adoption, or a repo answered
by two instances, is one row), then pushed on the bus as a `notification` event that rides the
per-tab `/api/events` stream and is relayed between instances like steps and turns. Sources: the
run-finished hook (`finished`, `needs_input`, `failed`; `check_failed` beside the run's own event,
even when an autofix continues the branch; a `compact` is silent; the orchestrator's own wake is
reported only when it died or asked you something, and its Open opens the window), the Stop route
(`stopped` — a stopped run is superseded in `agent.ts` and never reaches the hook, and a discard is
not news), a watcher after `preview.start` (`preview_ready` with the URL you'd open, else
`preview_failed`; a preview you stop mid-boot is forgotten), and the `/api/prs` answer
(`pr_ci_failed`, `pr_conflicts`), and the merge queue (`merged`, `merge_refused`; its red CI reuses
`pr_ci_failed`), and automatic PR upkeep (`auto_address`, `upkeep_gave_up`). **Needs input is a heuristic** (`asksForInput`): a reply whose last
line is a question, or `requires_action` — nobody has a cleaner signal (CLAUDE: a question is still
`end_turn`). Titles are the card's title, else the branch. Rows are pruned past 30 days by the writer.
The decisions are pure in `shared/notifications.ts` (what an event is, what pops, how the stack is
cut, grouping by day); the browser mirror is `web/src/lib/notificationStore.ts` (loads once, holds
the tab's stream, catches up by `since` on reconnect; toasts pop only for rows newer than the first
load and younger than ten minutes); the surfaces are `components/Notifications.tsx`: the toast stack
bottom-LEFT, growing up from just above the bell (`stackAnchor`, measured from the bell; full width
above the bottom bar on a phone), so the orchestrator's window keeps the
bottom-right. It copies branch-demo's inbox toasts — sonner's stack — in CSS, no dependency
(`stackLayout` / `toastMotion` / `swipeOut` / the `HideClock`, all pure): newest in front, three
showing; past one they collapse behind it (14px lift, 5% smaller each) over a count bar with Mark
all as read; hover spreads them by their real heights; slide in from below, drop out over 200ms; swipe
left or down is the ×; auto-hide pauses while hovered, touched or the tab is hidden. A toast for a
finished run or a ready preview hides itself after 6s (still unread), a problem or a question stays
until dismissed — `KIND_META.persistent`. **Notifications always persist, and have ONE state —
unread or read.** There is no Clear and no delete route (only the 30-day prune removes a row; the old
`dismissed_at` column is ignored, its rows read as read): the × on a toast or a centre row, a swipe,
opening it, any quick action and Mark all as read all just `markRead`, which also takes its toast
off the stack. A toast's title opens its workstream's Chat tab (the agent page, a PR's included), composer focused.
**Quick actions** on every toast and centre row, shown on hover / focus (always on a touch screen),
as size-7 ghost **icon buttons** (lucide icon, aria-label, a `Tip` tooltip — `components/ui/tip.tsx`
— with the `Kbd` keycap where a shortcut exists; a failed action's Ask / Copy are two of them):
the kind's one or two verbs, the first primary (no Read button — acting marks it read), then **Open,
always, always last**, labelled just Open (its workstream's Chat tab with the composer focused; the
orchestrator's panel, composer focused, for its own wake) and, on an
unread centre row, the × — chosen by the pure `notificationActions` (`workstream.ts`), which drops
one whose prerequisite is missing (no live row, PR URL, failed check). CI failing / conflicts →
Address PR (`store.addressPr`) + View PR (GitHub); check failed → Fix (`autofixInstruction` as a
follow-up) + View output; finished / needs input → Reply (the Chat tab, `?reply` focuses the
composer); failed / stopped → Retry (`RETRY_INSTRUCTION` on the same session) + Open chat; preview
ready → Open preview + Stop; preview failed → Retry test + View log; a failed action (local) → Ask the orchestrator + Copy; the orchestrator's own wake →
Open only. Verbs run in `ActionButton`, so a
failure is the action-error toast with Ask the orchestrator), and
the bell at the sidebar's foot with the unread count, opening the centre: one compact header —
the title, an Unread (its count) / All `Segmented`, a Mark all as read icon — over the rows grouped
by day. It opens on **Unread**, so a read row is out of view yet one click away under All; the
choice is remembered (`orca.ui.v1.notificationFilter`). The per-kind chips and the header's
do-not-disturb toggle were dropped as noise (DND lives in Settings; the bell shows it). Settings: do not disturb, per-kind toasts, and browser
notifications (urgent kinds only, while the tab is hidden; the permission is asked for when switched
on). Preferences are per browser (`orca.notifications.*` in localStorage); the rows are not.

## Deploying (a cloud box + the laptop, one database)

The two instances are named **`local`** (the laptop, `ORCA_INSTANCE=local`, bound to
`127.0.0.1,<its tailnet ip>` so the box can reach it) and **`cloud`** (the EC2 box, `orca-box`).
`instances` in the app config holds both addresses, so a workstream can be placed on either from
either, and the orchestrator (`orchestratorOn: cloud`) can `spawn --on local`.

Two instances share the Postgres database; each names itself (`ORCA_INSTANCE`, default hostname).
**The laptop does not depend on the box being up.** Its `ORCA_DATABASE_URL` names the box's Postgres,
so a box outage is a database outage: the laptop's bridge runs in degraded local mode (Architecture)
— it boots, serves the board from the cached config and its own worktrees, runs agents and journals
their turns, and replays them when the box is back. What it cannot do meanwhile: show the box's
workstreams, chat history from before the outage, the orchestrator (if it lives on the box), queued
messages and notifications. **The dev launcher supervises the bridge** (`scripts/dev.ts` →
`scripts/supervise.ts`): a plain `bun run server/index.ts` restarted when it exits (1s backoff,
doubling to 15s, reset after a minute up) and restarted at once on an edit to `server/`, `shared/`,
`web/src/workstream.ts`, `orca.config.ts` or `.env` (its own debounced `fs.watch`). It used
`bun --watch`, which does NOT re-run a script that died of an uncaught error — it waits for an edit
— so after the crash the board stayed down until someone restarted `bun run dev`. The box's systemd
unit restarts on its own.
A repo may be checked out on SEVERAL instances; **a workstream lives on the instance holding its
worktree.** `verbs.placement` decides where a request goes: an explicit `instance` (the New-draft
box's "run on" picker, the orchestrator's `spawn --on`) → the worktree's home, read from
`worktree_inventory` by branch or path → the repo's `runsOn` (its DEFAULT placement) → here.
`forwardToOwner` forwards to that instance's URL from `instances` (after `server/peer.ts`'s TCP-connect probe:
an offline laptop black-holes its tailnet address, so an unprobed forward or `/api/usage` merge hung >60s and
held a browser connection; the probe answers in ≤2s and caches down 30s / up 15s), except the `DATABASE_ONLY`
routes, which any instance answers — `/api/agents` among them: every instance lists its own
worktrees (when the repo is on disk here, `verbs.repoHere`) plus what the others published. The
board tags each card with its instance once there is more than one (`instanceChoices`). The
orchestrator's `board` spans instances (`on:<instance>`), and `send`/`address` call the workstream's
home over HTTP (`viaInstance`, the `/api/workstreams/{spawn,followup,address}` routes). **The
orchestrator itself lives on ONE instance — `orchestratorOn`:** its routes are forwarded there and
other instances post worker reports to `/api/orchestrator/event`, so one process wakes it (two
resuming one session at once was the "one message behind" bug). Unset, it wakes wherever it is
spoken to — fine for one machine, wrong for two. **Moving a workstream** (`verbs.moveWorkstream`, the card menu's
"Move to <instance>", `orca move --to`): the branch is pushed to origin, the worktree here is
removed, the target adopts the branch over HTTP (with an explicit `instance`, since the inventory
still lists it here until the next publish), and the session pointer is cleared — the provider's
session file is on the old host's disk, so the next run there takes the portable-transcript rung.
Turns and enrichment are in the shared database and need no moving. Not while its agent runs.
**Preview state lives on the server; a browser is a view of it.** The bridge that starts a
preview records where in the branch's enrichment (`previewInstance: {instance, key, startedAt}`,
`verbs.startPreview`); the stop route clears it (`db.clearPreviewPlacement`, by key). The card keys
its preview by that record (`store.previewKeyOf` — the key is a path on the OWNER, e.g. the box's
own checkout after "Test on cloud") and sends status/stop there, so a refreshed page or another
device shows Starting/Open/Stop with no click. Each instance publishes its running previews to
`preview_inventory` (migration 12; the 10s publish tick, and right after a start/stop), and
`/api/previews` (database-only) answers its own live plus the others' published, hiding a machine
silent for `PREVIEW_STALE_MS`. **URLs are per viewer:** a service carries `url`, the owner's address
(`ORCA_PREVIEW_HOST`, else its `instances` host), and `localUrl` when the ANSWERING bridge has it on
loopback — its own preview bound to 127.0.0.1, or a forward (`server/forward.ts`). **The tailnet
`url` is the default everywhere; the forward is the exception**, only for a repo with
`previewSecureContext: true` (branch-demo: `crypto.randomUUID` is undefined on a plain-http tailnet
name, the page was blank, and the tailnet has no HTTPS certs). For such a repo, when a preview status
is relayed from its owner (or listed for a page served from localhost — the owner tags each published
row `secureContext`, since the viewer can't map the owner's path to a repo), the opened service's
port is forwarded on loopback here. Without the flag no forward is opened and every device gets the
owner's `url` (opening Orca's own preview from the laptop sent Finn to localhost when he wanted the
tailnet). **A preview command binds `{bind}`** (`ORCA_PREVIEW_BIND`: loopback on a laptop, the
tailnet address on a box) and embeds `{host}` (`ORCA_PREVIEW_HOST`) in any URL the app hands the
browser; a Vite app also needs to allow the tailnet Host header or it 403s with "Blocked request."
Vite 5 (`web`'s is 5.4.21) checks `server.allowedHosts` itself — `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`
is not a Vite env var, so exporting it in the preview command does nothing by itself; `web/vite.config.ts`
reads `ORCA_PREVIEW_HOST` and `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` (comma-separated) into
`server.allowedHosts` (never `true`, which would accept any host) — Orca's own preview command:
`cd web && export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS={host}
&& bunx --bun vite --host {bind} --port {port}`. branch-demo's `frontend/vite.config.ts` has no such
read yet, so its own preview would 403 the same way for a viewer not on localhost (see README).
Plain TCP, so
Vite's HMR websocket rides it; dropped on stop; a port a local preview holds gets no `localUrl`. The
browser opens `localUrl` only from a page on localhost (`previewHref`), else `url` — a phone opens the
owner's tailnet URL, which still lacks a secure context until the tailnet has HTTPS certificates.
**Attachments are in the database, not on a host** (`server/attachments.ts`, migration 16): the
upload stores the bytes (20 MB per file, pruned past 30 days) and answers `orca-attachment://<id>/<name>`
references in its `paths` field; `agent.launch` — the one place every launch passes, whether queued,
proxied to `orchestratorOn` or forwarded to a workstream's home — swaps each for a file under ITS
state dir (`attachments/<id>/`, cached by id). A legacy plain path is kept if it exists there, else
reduced to its name and marked unavailable — another machine's temp path never reaches an agent.
The chat shows a message's files (`/api/turns` decorates each turn with `attachments`, read off its
stored prompt; `Attachments` in `views/Chat.tsx`: a thumbnail for an image, a named chip otherwise),
each opening `GET /api/attachments/<id>` — served from Postgres by any instance, sandboxed and
`nosniff`. **The orchestrator forwards them:** its wake prompt lists the ids under `## Attachments`,
and `orca spawn` / `orca send` take `--attach <id|path>` (repeatable; `bin/orca` collects a repeated
flag) — an id, or a file on its own machine, which is stored like an upload (`attachments.forward`) —
appended to the brief / message as references, so the worker's instance materialises them at launch.
`tests/attachmentsRelay.test.ts` drives two real bridges (upload on one, run, the orchestratorOn
proxy and spawn/send `--attach` on the other). (History: a laptop's `/var/folders` path reached the box's
agents, which couldn't open it.)
**Slack posts from the instance you click on** (`/api/slack` is in the answer-here set): it needs no
worktree, only `SLACK_TOKEN`, which lives on the laptop — forwarded to the box it failed with no token.
**Machine metrics history:** each instance samples ITSELF once a minute (`startMetricsSampler` in
`server/health.ts`, started from `server/index.ts`, reusing `health()`) into `instance_metric`
(migration 11: instance, `at`, cpu %, load1, memory used/total, disk used; migration 13 added
`running_agents` — the count of leases `lease.live()` finds live at sample time, not agent.ts's
in-memory `runs` map, so a sample taken right after a restart still counts what's genuinely live;
nullable, so a pre-migration row reads back as 0 rather than null; indexed on `(instance, at)`).
Every insert also deletes that instance's own rows older than 32 days (a whole month for the Cost
cell), so retention
needs no second timer; a failed write is logged and swallowed. `GET /api/health/history?instance=&hours=`
(24 by default, at most 720) is database-only and its `instance` is a filter, never a forward, so
either machine graphs the other even while it is down. Each machine's card (Overview, Usage) draws
CPU and memory over 6h / 24h / 7d as inline SVG (no charting dependency), downsampled to ~300
points, one line each (no overlay — the running sessions are their own chart). Beside them, in the
same `LineChart` design, an **Agents** chart (`running_agents` over time) and **Disk used** (axis to
the disk's size; worktrees, preview databases and test containers are what fill the box).
**OOM kills** are red marks on the Memory chart, counted in its caption: a run the cgroup ceiling
killed (`server/cgroup.ts`) bumps `health.noteOomKill`, and the next sample writes the count to
`instance_metric.oom_kills` (named step `20261013-instance-metric-oom-kills`; a failed write carries
it to the next). **Cost** is NOT a chart (a constant rate made a straight ramp that said nothing the
rate didn't; before that, the first cut summed the runs' `total_cost_usd` — model spend, wrong in
intent, the Usage card's business). It is the details grid's **Cost · this month** cell: the
instance's hourly rate × the hours its samples show it UP since the 1st (UTC) — consecutive samples
more than 5 minutes apart (`UPTIME_GAP_MS`, the sparkline's gap) mean it was down and add nothing
(`db.uptimeMs`, one SQL window query; `health.monthCost`, on `/api/health` as `month`), the rate ×
hours in its tooltip (`monthCostLabel`). Cost Explorer was considered: the instance role is SSM-only,
and its data is daily with a ~24h lag, so at best it could add a "billed" figure, never a live one.
**The rate**
(`health.instanceRate`, on `/api/health` as `rate`): the app config's `instanceHourlyUsd[<instance>]`
(editable in Settings' Machine cost card → `POST /api/config/instance-rate`, which sets one entry
and leaves the rest of the document alone), else on EC2 the type + region from IMDSv2 priced from
the small built-in on-demand table `EC2_ON_DEMAND_USD` (source `estimate`; the box, m7i.xlarge in
eu-west-2, is $0.2331/h), else 0 — the laptop — whose Cost cell is "—". The rate is today's, applied
over the whole month (no rate history). `ORCA_HOURLY_USD` / `ORCA_BILLING_SINCE` are gone.
`instance_metric.cost_usd` (migration 17) is left in place but UNUSED by current code — an
instance still on a build before #165 keeps backfilling model spend into it (a laptop on old code
once showed $1770 on its "Cost accrued" for the same reason); dropping it would be a migration of
its own for no gain. All four come from the
one `/api/health/history` poll. Every chart and the card's header stats come from ONE series
(`instanceSeries`): the live `/api/health` reading, when newer, is the newest sample and every line's
raw last point, so a header stat can never disagree with where its line ends. The Instances heading's
refresh (`RefreshVitals`) refetches every shown health + history at once.
**On darwin, memory used comes from `vm_stat`** (active + wired + occupied-by-compressor pages,
Activity Monitor's own formula), not `totalmem() − freemem()` — macOS's `freemem()` is only the
truly-free page count and reads near-100% on every healthy Mac; `sysctl -n kern.memorystatus_level`
rides along as `memPressurePct`/`memPressure` (linux keeps `totalmem() − freemem()`, which already
tracks `/proc/meminfo`'s `MemAvailable`).
**Conversation loading with a remote database:** the chat is **paged**. `GET /api/turns?limit=50`
returns `{ turns, older }` — the newest page (oldest first) and an opaque cursor
(`<started_at>~<turn.id>`, exact across equal timestamps; `db.turnPage`) for the page before, which
`?before=<cursor>` fetches (null once the first turn is in hand). Paging bounds what is fetched; a **mounted
window** (`CHAT_WINDOW`, two pages; `capWindow` / `revealAbove` / `revealBelow` in `workstream.ts`)
bounds the DOM: scrolling toward an edge remounts loaded turns and unmounts the far side, one edge
per commit so the scroll anchor stays exact. In the orchestrator's chat styling, turns older than the
newest `RECENT_FULL` show their answer's first lines + Show more, and in its Chat channel each run of
agent turns folds into one marker line (`channelItems`; the channel filter runs over the loaded page). Without `limit` the whole array
comes back as it always did, so an older client keeps working. `ChatPanel` opens on the newest page
(`TURN_PAGE_SIZE`), fetches the next older page as you near the top (or on the "↑ earlier turns"
click, for a page too short to scroll) and restores `scrollTop` by the height added above
(`anchoredScrollTop`) so the turn under the eye stays put; a refresh (a `turn` event, a send)
re-reads the newest page and merges it over what is loaded (`mergeLatestPage` /
`prependOlderPage`). It follows the tail only while at it; scrolled up, new output lights a "New
messages" jump button instead of yanking the reader down. Turns whose `instruction` is stored ship
`prompt: ""` — the chat never shows the prompt, and the orchestrator's 375 prompts (its board
snapshot and notes, every wake) were 3.6 MB of its 5.3 MB conversation. Steps ride along for the
newest `STEPS_FOR_PAGE` (10) turns of a paged request, `STEPS_FOR_TURNS` (40) of an unpaged one,
in ONE query (`db.stepsForRuns`); other turns fetch theirs on unfold
(`/api/turns/steps` from seq 0). One query per turn over a 6ms link made a 300-turn conversation
take seconds to open; the whole 5 MB over the tailnet did too, and 375 markdown turns took ~0.8s to
render where 50 take ~0.1s. Leases, the ledger, handoff
files, `~/.claude/projects` backfill, preview ports, and `/api/usage` are **per host** — they
describe the instance that answered, which is right for leases and wrong-but-tolerable for the
usage meter. `deploy/orca.service` is the systemd unit; `bun run build` then `bun run server` is
the whole deploy. **Provisioning a box:** `deploy/provision.sh` launches an EC2 instance (default
VPC, a security group with NO ingress, the SSM instance profile) with `deploy/cloud-init.yaml`,
which installs Postgres, Tailscale (auth key read from SSM Parameter Store
`/orca/tailscale-authkey`), Bun, the Claude CLI, hydra + shim and `gh`; sign-ins can't be
unattended, so after first boot `gh auth login`, clone to `/opt/orca`, `hydra add …`, then
`deploy/bootstrap.sh` builds, writes `.env` bound to loopback plus the tailnet address and starts the unit. The
laptop points `ORCA_DATABASE_URL` at the box's Postgres over the tailnet. Modelled on a teammate's
"chorus-server" (m7i.2xlarge, Ubuntu 24.04, SSM-only). The unit's `PATH` must hold `~/.local/bin` (hydra + the `claude` shim) and
`jq`/`curl` (hydra's dependencies), and the box runs `hydra add … ; install.sh --shim` once. `.github/workflows/check.yml` runs the gate on Linux, which is where a
macOS-only path (Keychain, `clonefile`) or a tool-flag difference would show first. **Pin the
Claude Code version on the server:** `--bare` is slated to become the default for `-p`, and bare
mode never reads OAuth credentials, which would silently break every subscription-login launch.
**Auto-deploy:** `orca-autodeploy.timer` runs `deploy/autodeploy.sh` every minute so the box picks
up `main` without a manual deploy. Each tick: fetch `origin/main`; if HEAD already matches, no-op.
Otherwise, refuse while busy — the orchestrator is mid-wake (`GET /api/orchestrator` →
`running:true`), and just log `deferred: busy` to try again next tick; a live agent-run lease
(`~/.orca/leases`) does NOT count as busy, because a worker survives a bridge restart
(`agent.adoptLeases` re-adopts it), unlike an orchestrator wake, which is the whole reason for the
busy rule. Otherwise `git pull --ff-only`, then `bun install --frozen-lockfile` if `package.json` or
`bun.lock` changed between the old and new HEAD (a PR that adds a dependency, like #192's
@radix-ui/react-hover-card, would otherwise build against stale `node_modules` and fail with a
Rollup unresolved-import error while the box silently kept serving the old build), then `bun run
build`, and only on a successful build `systemctl restart orca`, then poll `/api/config` until it's
back. A failed install or build never restarts the service — the old build keeps serving — and its
log tail goes to `~/.orca/autodeploy.log` (one line per tick). Pause it with
`systemctl stop orca-autodeploy.timer`; `deploy/bootstrap.sh` installs and enables it, scoped by
`deploy/orca-autodeploy.sudoers` to exactly `systemctl restart orca` for the `orca` user.
**Orphan reaper:** a preview that dies with a bridge crash, a reaped worktree, or a worker's own
test run leaves its `orca_*` database behind — nothing else drops it, and the box had 8 of them
(~6.6 GB) accumulate before `server/preview.ts`'s `reap()` existed. It runs at startup and hourly
(`server/index.ts`): lists `orca_%` databases on each repo's preview Postgres (`server/previewdb.ts`,
connected the same way `scripts/preview-db.sh` is, from the repo's own `.env`), computes orphans
against every repo's live worktrees plus every tracked preview key (`orphanPreviewDbs`), skips
anything younger than 2 hours (a preview mid-clone), and drops the rest via `preview-db.sh drop`.
The same pass removes a repo's `testContainerPrefix` Docker containers (branch-demo's test harness
leaves `branch_demo_test_postgres_<port>` running) older than 3 hours, via `server/docker.ts` —
silently skipped when `docker` isn't on the box. `/api/diagnostics` reports the last pass (`reap`).
**Per-worker memory ceiling** (`server/cgroup.ts`): the incident this exists for — an m7i.xlarge
(16GB) ran 4-5 concurrent builds, the kernel OOM killer fired on the whole system, load average hit
49, and Postgres/Tailscale/SSM were unreachable for 12 minutes. Every agent run now gets its own
`systemd-run --user --scope -p MemoryMax=<repo's agentMemoryMaxGb, default 4>G -p
MemorySwapMax=0 -p CPUWeight=<agentCpuWeight, default 50>` — a worker's runaway build or headless
browser is OOM-killed inside its OWN cgroup, never the box's. There is deliberately no cap on
concurrent workers (Finn removed the orchestrator's once, for the same reason): the fix is bounding
the blast radius of ONE, not limiting how many run. `--user` (not the system manager): a non-root
`systemd-run --scope` against the system manager needs polkit authorization a headless box can't
grant interactively, but `--user` has no such check — it only needs a reachable user bus, which
`orca` (a service account, never logged in) doesn't have by default. `loginctl enable-linger orca`
(`deploy/bootstrap.sh`, once) starts a user manager at boot regardless; `cgroup.available()` checks
the bus socket itself (`/run/user/<uid>/bus`), not just the `systemd-run` binary, so a CI runner or
an unprovisioned box — which has the binary but no lingering — degrades to unwrapped, unchanged
behaviour rather than failing every run. `prlimit --as` was considered and rejected: it bounds one
process's own address space, not the tree a build or a browser spawns, so it would not have capped
the incident at all. A run killed this way is detected from BOTH signals — exit 137 (plain SIGKILL)
AND `systemctl --user show <scope> -p Result` reporting `oom-kill` (briefly, before the scope is
GC'd) — so a run you stopped yourself, which also exits non-zero, is never mislabelled; its turn
gets stop reason `error` and a response of `out of memory (<N> GB ceiling)`, and the ledger records
`errorKind: "oom"`. `deploy/orca.service` separately reserves `MemoryMax=` ~85% of the box's RAM for
the bridge's own tree (previews, git/gh, anything it runs directly — NOT agent runs, which have
already left this cgroup for their own scope by the time they'd count against it) and sets
`OOMScoreAdjust=-500` so the bridge is the last thing a true system-wide OOM kill would pick.
Postgres and Tailscale are untouched: they are separate systemd units, never children of
`orca.service`, so they were never inside either limit — the two settings just make sure nothing
Orca does crowds them out of the 15% left over.

**Screenshots** (`server/screenshot.ts`): workers can't run a browser (the OOM above), so the bridge
runs ONE — `POST /api/screenshot` (url, viewport, dark, wait-for, click/scroll/wait steps) queues on a
box-wide queue (one capture at a time), launches a fresh `chrome-headless-shell` over CDP inside its
own `systemd-run --user --scope` (`cgroup.scopedCommand`, `MemoryMax=1.5G`, no swap), times out at
45s, and kills the browser after EVERY job — nothing idles. The PNG goes to an `AttachmentStore`
(disk, `~/.orca/attachments/shots`, until attachments move to Postgres); `GET /api/screenshots/:id`
serves it. Workers get `bin/worker/` on PATH (`agentEnv` — not `bin/`, whose `orca` is the
orchestrator's) and `orca-shot <url> [--viewport 390x844] [--dark] …`, which prints `shot: <path>`;
every worker prompt says it is the ONLY way to take a screenshot (`SCREENSHOTS`), and shot paths in a
reply ride the worker report (`reportedShots` in `workerEvent`).
**Screenshots in PRs and on the agent page** (`server/prShots.ts`): shots are not stored per turn —
`workstreamShots` reads them off the branch's turns (reply + Verification). The newest
`PR_SHOTS_MAX` (6) go into the PR body's `## Screenshots` section (`withScreenshotsSection`: replaced
in place, the rest untouched; its `<!-- orca:screenshots ids -->` marker means an unchanged set is
never re-uploaded), hosted as ONE orphan commit on `refs/heads/pr-assets/<pr>-<slug>` via the git
data API (`gh api` blobs → tree → commit → ref) and linked `blob/<sha>/<file>?raw=true`. Only PNGs
from the shot store are uploaded. Triggers: Promote, `openWorkerPr` (autoPr), any run reporting
shots on a branch with an open PR (the run-finished hook), and **`orca pr-shots --repo r --branch b
[--pr N]`** (`POST /api/prs/shots`, on the worktree's instance — the files are on its disk) for a PR
opened with `gh pr create`. The reaper deletes a merged/closed PR's `pr-assets/<pr>[-…]` refs. The
agent page's Overview has a Screenshots card (`GET /api/shots`, by turn, newest first) and a worker
report in the chat draws its shot lines as thumbnails (`reportShots`); `/api/screenshots/<id>` asks
the other instances when the file isn't on this one.
**An Orca preview's `/api` is the branch's own bridge**, not main's :8787 (which made a branch's
Cost chart read main's numbers): `scripts/preview-orca.sh` runs the branch's `server/index.ts` with
`ORCA_PREVIEW_BRIDGE=1` (`db.previewBridge`) — shared database, never migrates, never publishes
inventory/previews/metrics, none of the startup side effects, every non-GET refused — and `web`
proxies to it (`ORCA_API_PORT={svc:bridge}`). A branch that predates the mode, or whose migrations
the database lacks, forwards to main instead; the top bar's `BridgeLabel` names whichever answered.

## Writing (STE, always)

Write all human-facing prose in **ASD-STE100 Simplified Technical English (STE)**. This includes
replies, reports, outcome sections, PR titles and descriptions, commit messages, review replies,
notes and the docs (`README.md`, `docs/`). Finn asked for this ALWAYS.

- Use simple words with one meaning each. Technical names and verbs are allowed (PR, commit, merge, CI).
- Use one name for each thing. Do not change the name later.
- Write at most 20 words in a procedure sentence and at most 25 words in a description sentence.
- Write one instruction in each sentence. Write instructions as commands.
- Use the active voice and simple tenses. Do not use -ing words as nouns or adjectives. Do not hedge
  with "would" or "could".
- Keep paragraphs short. Use lists for sequences.
- Do not apply STE to code, identifiers, file paths, commands, hashes, quoted error text or quoted
  user words.

The rules live in ONE place, `shared/writingStyle.ts` (`WRITING_STYLE`). Every prompt Orca sends
includes it: worker prompts through `withOutcomeContract` and `chatPrompt`, the PR description
prompt, and every orchestrator wake. Change the rules there, never in a copy.
`tests/writingStyle.test.ts` checks that each prompt builder includes it once.

## Conventions (follow these)

- **Adapter boundary:** all shell/network I/O lives in `server/{git,gh,slack}.ts` behind
  thin functions that take explicit args (no global config reads). Tests point GitHub
  calls at a fake GitHub server (`tests/helpers.ts` `installFakeGh`), swap the `gh` binary
  via a PATH shim for what still runs it, and run `git` against a scratch repo — so keep the
  git adapter shelling out to the real binary, not reimplementing it.
- **Pure logic in `workstream.ts`**, so it's testable without booting anything.
- **Browser polls use `poll()` (`web/src/lib/poll.ts`), never `setInterval(fetch…)`** — the bridge is
  HTTP/1.1, six connections per host across all tabs; clock-driven polls queued hundreds deep behind a
  busy pool and the PR page never loaded. Live push goes through the ONE stream (`lib/events.ts`).
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
