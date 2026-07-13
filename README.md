# 🐳 Orca

A local control plane for the seam between **managing coding agents** and **managing PRs**.
One kanban board over one lifecycle:

- **Local / Draft** — create a git worktree per feature; choose Claude or Codex, let Orca launch it
  headlessly with your prompt, see what changed, then promote to a PR.
- **PRs** — open PRs with CI/review status and one-click actions: Slack notify/bump, resolve
  conflicts, fix CI, follow up, and merge-when-green.

Every agent action **runs your selected coding agent headlessly** (`claude -p` or `codex exec`,
using the CLI's existing login — no API key). Actions that need to touch code — resolve conflicts, fix CI, follow up —
run in the branch's worktree, **adopting one automatically if the PR doesn't have one locally**.
"Copy CLI" is the escape hatch to continue the active provider's run interactively. A follow-up can
resume the same provider natively, hand the portable conversation history to another provider, or
start a clean chat in the same worktree. See `CLAUDE.md` for the design and rationale.

## Prerequisites

- [Bun](https://bun.sh) (this repo is Bun-native; Node is not required)
- `git` and the [`gh` CLI](https://cli.github.com), already authenticated (`gh auth status`)
- At least one authenticated agent CLI: `claude` or `codex`

## Setup

```sh
bun install
```

Point Orca at the repo you want to manage — edit `orca.config.ts`, or set env vars:

```sh
export ORCA_REPO_PATH=/absolute/path/to/your/repo
export ORCA_WORKTREE_ROOT=/absolute/path/to/orca-worktrees
export ORCA_BASE_BRANCH=main
export ORCA_DEV_COMMAND="bun run dev --port {port}"   # how to start a preview; {port} is filled in
# optional Slack:
export SLACK_BOT_TOKEN=xoxb-…        # enables threaded bumps
export SLACK_CHANNEL=#eng
# or, instead of a bot token:
export SLACK_WEBHOOK_URL=https://hooks.slack.com/…
```

## Run

```sh
bun run dev      # http://localhost:8788 (UI) → proxies /api to the bridge on :8787
                 # override the UI port with ORCA_UI_PORT
bun run build    # production build; then `bun run server` serves the built UI + API
bun run check    # typecheck + tests — run this before every commit
```

## How it maps to your workflow

| You used to… | Now |
| --- | --- |
| spin up a worktree by hand | **New** → worktree created + `claude -p` launched with your prompt |
| eyeball `git diff` | change summary on the card; full diff on the detail page |
| `gh pr create` | **Promote to PR** |
| watch CI/comments | kanban card auto-polls status |
| ask Claude to rebase | **Resolve conflicts** — runs Claude in the worktree (adopts one if needed) |
| ask Claude to fix a red build | **Fix CI** — same, headless |
| Slack the team, then bump | **Slack notify** → **Bump** (highlighted when stale) |
| merge when green | **Merge** (enabled only when mergeable + green) |
