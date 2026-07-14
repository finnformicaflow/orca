# 🐳 Orca

A local control plane for the seam between **managing coding agents** and **managing PRs**.
One kanban board over one lifecycle:

- **Local / Draft** — create a git worktree per feature; choose Claude, Codex, or Antigravity, let Orca launch it
  headlessly with your prompt, see what changed, then promote to a PR.
- **PRs** — open PRs with CI/review status and one-click actions: copy Slack notify/bump messages, resolve
  conflicts, fix CI, follow up, and merge-when-green.

Every agent action **runs your selected coding agent headlessly** (`claude -p`, `codex exec`, or `agy -p`,
using the CLI's existing login — no API key). Actions that need to touch code — resolve conflicts, fix CI, follow up —
run in the branch's worktree, **adopting one automatically if the PR doesn't have one locally**.
"Copy CLI" is the escape hatch to continue the active provider's run interactively. A follow-up can
resume the same provider natively or hand the portable conversation history to another provider;
Orca infers which behavior is needed from the selected provider. See `CLAUDE.md` for the rationale.

## Prerequisites

- [Bun](https://bun.sh) (this repo is Bun-native; Node is not required)
- `git` and the [`gh` CLI](https://cli.github.com), already authenticated (`gh auth status`)
- At least one authenticated agent CLI: `claude`, `codex`, or `agy`

## Setup

```sh
bun install
```

Point Orca at the repos you want to manage in `orca.config.ts` (each entry has its own
`repoPath`/`worktreeRoot`/`baseBranch`/`previewServices`). Repo paths are resolved against a
**required** base dir given by `ORCA_DEV_ROOT`, so the config needs no editing on a new laptop.
Set it in a `.env` file at the repo root — Bun auto-loads it, and it's gitignored so it stays
per-machine (the bridge fails loudly at startup if it's unset):

```sh
cp .env.example .env
# .env → ORCA_DEV_ROOT=$HOME/Documents/dev   (the dir that holds your repos)
```

At least one agent CLI (`claude`, `codex`, `agy`) must be on the **bridge's** `$PATH`. If a CLI
lives in `~/.local/bin` (e.g. `codex`), make sure that's on the PATH of the shell you launch
`bun run dev` from, or you'll see `Executable not found in $PATH`.

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
| spin up a worktree by hand | **New** → worktree created + your selected provider launched with your prompt |
| eyeball `git diff` | change summary on the card; full diff on the detail page |
| `gh pr create` | **Promote to PR** |
| watch CI/comments | kanban card auto-polls status |
| ask an agent to rebase | **Resolve conflicts** — runs the selected provider in the worktree (adopts one if needed) |
| ask an agent to fix a red build | **Fix CI** — same, headless |
| Slack the team, then bump | **Copy Slack message** → **Copy bump** (highlighted when stale) |
| merge when green | **Merge** (enabled only when mergeable + green) |
