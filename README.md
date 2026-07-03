# 🐳 Orca

A local control plane for the seam between **managing Claude agents** and **managing PRs**.
Two views over one lifecycle:

- **Agents** — create a git worktree per feature, see what changed, copy a prompt into your
  own Claude session, then promote to a PR.
- **PRs** — a kanban of open PRs with CI/review status and one-click actions: Slack
  notify/bump, copy a rebase prompt for conflicts, and merge-when-green.

Orca does **not** run Claude — you do. It automates everything around it. See `CLAUDE.md`
for the design and rationale.

## Prerequisites

- [Bun](https://bun.sh) (this repo is Bun-native; Node is not required)
- `git` and the [`gh` CLI](https://cli.github.com), already authenticated (`gh auth status`)

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
| spin up a worktree by hand | **New agent** → worktree created, prompt ready to copy |
| eyeball `git diff` | change summary on the card |
| `gh pr create` | **Promote to PR** |
| watch CI/comments | kanban card auto-polls status |
| ask Claude to rebase | **Copy rebase prompt** on a conflicted card |
| Slack the team, then bump | **Slack notify** → **Bump** (highlighted when stale) |
| merge when green | **Merge** (enabled only when mergeable + green) |
