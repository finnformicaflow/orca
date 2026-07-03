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

## The one board & model

One board (`web/src/views/Board.tsx`), three lanes: **Draft → In Review → Mergeable**.
A draft is a pre-PR worktree (created + agent launched in the Draft column); Promote runs
`gh pr create` and the card slides to In Review. Routing: `/` = board, `/prs/:n[/files|/checks]`
= detail.

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

## Run & test

```
bun install
bun run dev      # bridge + Vite (edit orca.config.ts / env first — see README)
bun run check    # tsc --noEmit + bun test — the gate; keep it green on every change
```

`tests/workflow.test.ts` encodes the core problem as W1–W7. **It is the north star: if a
change breaks a W-test, the change is wrong, not the test** (unless the problem itself
changed). See `QA.md` for the manual equivalent against real GitHub/Slack.
