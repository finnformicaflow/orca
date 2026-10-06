# 🐳 Orca

A local control plane for the seam between **managing coding agents** and **managing PRs**.
One kanban board over one lifecycle:

- **Local / Draft** — create a git worktree per feature; choose Claude, Codex, or Cursor, let Orca launch it
  headlessly with your prompt, see what changed, then promote to a PR.
- **PRs** — open PRs with CI/review status and one-click actions: copy Slack notify/bump messages, resolve
  conflicts, fix CI, follow up, and merge-when-green.

Every agent action **runs your selected coding agent headlessly** (`claude -p`, `codex exec`, or `cursor-agent -p`,
using the CLI's existing login — no API key). Actions that need to touch code — resolve conflicts, fix CI, follow up —
run in the branch's worktree, **adopting one automatically if the PR doesn't have one locally**.
"Copy CLI" is the escape hatch to continue the active provider's run interactively. A follow-up can
resume the same provider natively or hand the portable conversation history to another provider;
Orca infers which behavior is needed from the selected provider. See `CLAUDE.md` for the rationale.

## Prerequisites

- [Bun](https://bun.sh) (this repo is Bun-native; Node is not required)
- `git` and the [`gh` CLI](https://cli.github.com), already authenticated (`gh auth status`)
- At least one authenticated agent CLI: `claude`, `codex`, or `cursor-agent`

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

Orca keeps its chat history in **Postgres** (`ORCA_DATABASE_URL`), so it can later be shared by more
than one Orca instance — a cloud box and a laptop, each running its own worktrees against one
database. Create it once, then point `.env` at it:

```sh
createdb orca
# .env → ORCA_DATABASE_URL=postgres://localhost:5432/orca
#        ORCA_TEST_DATABASE_URL=postgres://localhost:5432/postgres
```

`bun run check` needs `ORCA_TEST_DATABASE_URL` too: the tests run against a real Postgres (in a
throwaway schema per file) rather than a stand-in, so they prove the engine that actually ships.

**Preview integration settings.** A preview starts from a fresh clone of the repo's template
database and a copied env file, so anything set up on one preview is gone in the next. Two per-repo
config keys (in the repo's entry of the config document, which lives in Orca's database) carry it:

- `previewEnv` — env vars set on every preview service, over the bridge's own environment, e.g.
  `{ "LINEAR_API_BASE_URL": "https://api.linear.app/graphql" }`. An app whose env loader does not
  override exported variables (dotenv's default) sees these win over the worktree's `.env`; nothing
  in the target repo is edited. Base URLs and switches only: the config is shared and shown in the
  settings UI, so no secrets.
- `previewPromote` — the command that copies a preview's integration settings into the template
  database (`{db}` = that preview's database; it runs in the worktree). For a repo using
  `scripts/preview-db.sh`: `cd backend && bash '<orca>/scripts/preview-db.sh' promote-integrations {db}`.
  It upserts, by primary key, every row of every table whose name matches `_integration$`
  (override the regex with `PREVIEW_INTEGRATION_TABLES`), in every schema, into the
  `PREVIEW_TEMPLATE_DB` from the worktree `.env`. Only the columns both sides have are copied,
  nothing in the template is deleted, and it is one transaction, so a failure leaves the template
  unchanged. Activity logs, OAuth state, per-user credentials, users and projects are never touched.
  It prints table names and row counts, never values: the copied rows (API keys included) exist only
  in the two local databases.

Run it from the detail page's Preview tab (**Keep integrations for future previews**) or have the
orchestrator do it: `orca preview --repo <repo> --branch <branch> --promote-integrations`.

**Several Claude accounts** (to keep working when one hits its usage limit) are handled by
[claude-hydra](https://github.com/finnformica/claude-hydra), not by Orca. Install it, register each
login, and install its `claude` shim; from then on every `claude -p` Orca spawns is routed to the
login with the most headroom, and a `--resume` works on any of them because hydra shares sessions
between logins. The header meter reads `hydra status --json` and shows every login's 5-hour, weekly
and Fable windows, and warns if the shim has gone missing (Claude Code's updater can rewrite
`~/.local/bin/claude`; re-run `install.sh --shim`). Needs `jq` and `curl`.

```sh
git clone https://github.com/finnformica/claude-hydra ~/.local/share/claude-hydra
~/.local/share/claude-hydra/install.sh --shim
hydra add personal --existing      # the login already in ~/.claude
hydra add work                     # sign a second account in
hydra status
```

At least one agent CLI (`claude`, `codex`, `cursor-agent`) must be on the **bridge's** `$PATH`. If a CLI
lives in `~/.local/bin` (e.g. `codex`), make sure that's on the PATH of the shell you launch
`bun run dev` from, or you'll see `Executable not found in $PATH`.

## Deploy (a cloud box, reached over Tailscale)

The bridge is one Bun process plus Postgres; it needs a real disk for worktrees and long-lived
child processes, so it runs on a plain Linux box (an ARM instance with 4 GB is plenty), not on
anything serverless. The API has no auth of its own: bind it to the tailnet address and reach it
from the laptop over Tailscale. Nothing is ever exposed publicly.

```sh
# on the box, as user `orca`
git clone <this repo> /opt/orca && cd /opt/orca
bun install && bun run build
cp .env.example .env            # set ORCA_DEV_ROOT, ORCA_DATABASE_URL, ORCA_INSTANCE=cloud,
                                # ORCA_BIND=<tailscale ip>, ORCA_PREVIEW_HOST=<tailscale name>
claude login                    # paste-the-code flow works over SSH; writes ~/.claude/.credentials.json
# several Claude logins: install claude-hydra + its shim here too (see "Several Claude accounts";
# apt install jq curl). The unit's PATH already lists ~/.local/bin, where hydra and the shim live.
codex login --device-auth       # if you use Codex
gh auth login                   # or export GH_TOKEN (fine-grained PAT — it is YOUR identity, so
gh auth setup-git               # `gh pr list --author @me` still means you); setup-git lets worktrees push
sudo cp deploy/orca.service /etc/systemd/system/ && sudo systemctl enable --now orca
```

Then in the config (settings page or `orca.config.ts`) name the instance and assign repos to it:
`instances: { cloud: "http://<tailscale ip>:8787" }` and `runsOn: "cloud"` on each repo the box
should execute. The laptop keeps running its own bridge against the same database; the board on
either shows both. Pin the Claude Code version on the box (`claude --version`) and check release
notes before upgrading: `--bare` is due to become the default for `-p` and does not read OAuth
logins. `.github/workflows/check.yml` runs the test gate on Linux so a macOS-only path breaks CI
before it breaks the box.

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
