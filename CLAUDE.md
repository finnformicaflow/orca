# Orca — durable brief for Claude

Read this first. It's the context that isn't obvious from the code.

## The problem Orca exists to solve

An engineer on a fast, high-PR-volume team drives features through a manual chain:
prompt Claude → open PR → watch CI/comments → fix conflicts → Slack the reviewers →
bump if it's been a day → merge. Every transition is hand-driven. **Orca automates the
connective tissue between "managing agents" and "managing PRs."**

**Orca launches Claude headless.** On create, Orca runs `claude -p` (headless, using your
existing Claude login — no API key) in the new worktree with the feature prompt, and shows a
status badge (running/done/error). It does NOT stream output or host a chat — for that,
"Copy CLI" gives you `cd <worktree> && claude --continue` to jump into an interactive
session continuing that run. The git change-summary poll shows commits as they land. Orca
then promotes the branch to a PR and drives it to merge with buttons.

(History: earlier slices deliberately did NOT run Claude — the user reversed this. Slack
was also cut from an API integration down to a copyable prompt, since Claude has Slack
access. The principle that survives: Orca generates prompts / launches processes but hosts
no chat UI and holds no long-lived state of its own beyond the in-memory run map.)

## Architecture

- **One Bun process** (`server/index.ts`, via `Bun.serve`) serves the built React SPA *and*
  a plain-JSON API. `Vite` is dev-only (HMR + proxy). No streaming.
- **Why the process must exist:** a browser can't run `git worktree`, read a local diff, or
  start a dev server, and Slack blocks browser CORS. The bridge does *only* what the browser
  physically can't, plus proxies GitHub/Slack so tokens never touch the browser. It is not a
  "backend" in the app sense — no DB, no business state.
- **Source of truth is the LIVE system, not localStorage.** Draft column is driven by
  `GET /api/agents` (git worktrees + in-memory run status); the PR lanes by `GET /api/prs`
  (`gh pr list --author @me`). `localStorage` only **enriches** that live data with what
  git/gh can't recover — prompt, title, Slack timestamps — keyed by branch (`web/src/store.ts`).
  PRs/worktrees with no enrichment still render (backwards compat, incl. PRs not made by Orca).
- **GitHub = the `gh` CLI; Slack = a prompt Claude sends.** No OAuth app, no Slack token.

## Multi-repo (aggregated)

`orca.config.ts` holds `repos: RepoConfig[]` (each with repoPath/worktreeRoot/baseBranch/
previewServices/slackChannel) + global portRange/staleHours. Every repo-scoped API call names
its repo (`?repo=` on GET, `repo` in POST body; server resolves via `repoOf`). The board shows
**all repos aggregated** — the store polls each repo and `useWorkstreams()` builds unified
rows tagged by repo (each row carries `repo`; actions use `row.repo`). Enrichment is keyed
`repo::branch`. The New-draft box has a repo **dropdown**; cards show a repo tag.

## The one board & model

One board (`web/src/views/Board.tsx`), lanes: **Local → Draft → In Review → Mergeable → Done·today**.
A workstream is a branch; its lane (`store.laneFor`):
- **open PR, draft** → Draft. **open PR, approved** → Mergeable. **open PR, else** → In Review.
- **no PR** → Local, until Promote (local repo: sets `promoted`; then Mergeable if `git merge-tree`
  is clean, else In Review). **merged today** (server-local calendar day) → Done (`gh pr list --state merged`).

Actions (all via `ActionButton`, spinner → ✓/✗, no double-fire):
- **Promote** (Local, remote repo) = a dropdown: Create PR ready / draft, ± add preview label.
  Local repo → plain Promote (sets `promoted`).
- **Resolve conflicts / Fix CI / Follow up** = launch a headless `claude -p` in the branch's
  worktree. They **`ensureWorktree` first** (`store.ts`): use the existing worktree, else adopt one
  via `git worktree add` from the branch (incl. PRs with no Orca history) — so no action ever
  requires a manual "check out" step or a copied prompt. Follow up resumes the persisted sessionId
  when there is one. `ensureWorktree` also copies `copyToWorktree` config into the fresh worktree.
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
Conflict / CI / mergeability / "ready for review" are **badges, not lanes**. Every PR action
(Slack notify/bump, resolve conflicts, fix CI) launches a headless `claude -p` via
`POST /api/claude`; previews start N services (frontend+backend) on assigned ports via
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
