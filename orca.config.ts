import { join } from "path";
import type { OrcaConfig } from "./server/config";

// Base directory holding the managed repos. REQUIRED — set ORCA_DEV_ROOT per-machine (e.g.
// ~/Documents/dev) so this file needs no editing on a new laptop. Fail loudly if unset rather
// than silently resolving repo paths against a wrong default.
const DEV = process.env.ORCA_DEV_ROOT;
if (!DEV) throw new Error("ORCA_DEV_ROOT is not set — point it at the base dir holding your managed repos (see README)");

// Per-preview Postgres helper, hosted in THIS (Orca) repo — not the app repo — so previews work on
// any branch without the app carrying the script. Absolute path resolved from this config's own
// location, so it's laptop-portable. See scripts/preview-db.sh.
const previewDb = join(import.meta.dir, "scripts/preview-db.sh");
const previewDeps = join(import.meta.dir, "scripts/preview-deps.sh"); // reinstall a worktree's node_modules iff drifted from its lockfile (stale CoW clone)

// Repos Orca manages. Add/remove entries here. The first is the default.
const config: OrcaConfig = {
  repos: [
    {
      name: "branch-demo",
      repoPath: `${DEV}/branch-demo`,
      worktreeRoot: `${DEV}/branch-demo/.worktrees`,
      baseBranch: "master",
      slackChannel: "#engineering",
      previewLabel: "preview",
      // Labels the Promote-to-PR menu offers as toggles; `preview` starts checked.
      prLabels: [{ name: "preview", default: true }],
      // Uses the repo's own dev scripts (test-auth, shared local Postgres on :5432 — must be
      // running, and backend/.env present). Each service gets its OWN assigned port: the backend
      // must not fall back to :3000 (it would collide with your main dev backend / other previews,
      // crash on bind, and the frontend would silently talk to the wrong backend — so branch
      // changes wouldn't show). The frontend is pointed at THIS preview's backend via {svc:backend}.
      previewServices: [
        // Migrate the shared local DB to this branch's schema first (idempotent — applies only
        // pending migrations), mirroring a coworker's `mup && rbe`. Without it, DB-backed features
        // (e.g. integrations) break when the previewed branch adds migrations master lacks.
        //
        // Then RE-SEED the test-auth user in the background: the test user + its org memberships are
        // manual seed data (scripts/invite-user-local.sh), and any previewed branch whose migrations
        // rebuild the public user/permissions tables wipes it — so access to orgs kept regressing.
        // Re-inviting on every start makes it self-heal — idempotent, best-effort per org (a
        // not-yet-provisioned tenant like `flow` fails harmlessly), and deferred until the backend
        // is actually answering so the invite's MikroORM/cache work doesn't race the backend's own
        // boot (a concurrent metadata regen breaks MikroORM init — see invite-user-aws.sh). Edit the
        // org list to match the tenants you test.
        // The reseed poll is BOUNDED (~90×2s ≈ 3min) not `until` — an unbounded loop orphaned by a
        // backend that never boots (or a hard bridge kill) polls a dead port forever (a 23h "sleep 2"
        // leak we hit). It gives up if the backend doesn't come up in time. (Orca also reaps the whole
        // preview subtree on stop via killTree — this is the belt to that suspenders.)
        //
        // SELF-HEAL node_modules: each worktree gets its OWN CoW clone of backend/node_modules
        // (linkToWorktree → git.ts), so worktrees no longer corrupt each other. But the clone
        // inherits whatever state the SOURCE tree was in — if an interrupted `npm install` left the
        // source missing @cspotcode/source-map-support (breaks ts-node) or with orphaned
        // `.<pkg>-<random>` staging dirs, every clone carries that. The `-f package.json` check is an
        // instant no-op when healthy (a plain file test — not `require.resolve`, which false-negatives
        // on ESM-`exports` packages); only when the fragile dep is missing does it sweep the staging
        // dirs and run a non-destructive `npm install`. The sweep is safe: the install right after
        // restores anything real. `find -E` = BSD extended regex (/usr/bin/find defaults to basic,
        // where `+` is a literal, so the pattern would match nothing without it).
        // Second self-heal: an `npm install` sometimes lands @nestjs/cli's bin/nest.js without its
        // execute bit, so `npx nest` dies with "Permission denied". `[ -x .bin/nest ]` tests it; chmod repairs.
        // RETRY migrate: migrate-local.sh is idempotent but `set -e`, so any transient hiccup during
        // boot would kill the whole preview. Retry up to 3× with backoff as cheap insurance; a genuine
        // failure (DB down, real migration error) still fails all 3 and surfaces in the preview log.
        // Per-preview DATABASE: each preview gets its OWN Postgres database (Orca's {db}) — a clone of
        // your local branch_demo (public registry + every seeded tenant schema) that then runs THIS
        // branch's migrations, instead of sharing branch_demo. So a branch's migration (e.g. views
        // storage) runs against a real copy of your data without touching your dev DB, all on the same
        // :5432. `export DB_NAME={db}` points MikroORM (backend), the migrator, and the reseed invites
        // at that database. The Orca-hosted preview-db.sh (see `previewDb` above) clones (WITH TEMPLATE)
        // + migrates; retried 3× (idempotent) as cheap insurance. onStop drops the DB on teardown.
        // Hosting the script in Orca (not the app repo) is deliberate: it needs nothing from the branch
        // but the worktree's own .env + scripts/migrate-local.sh, so previews work on ANY branch.
        // Note: the clone briefly disconnects branch_demo (WITH TEMPLATE needs it free of sessions);
        // your dev backend's pool reconnects.
        { name: "backend", command: `export DB_NAME={db} && cd backend && bash '${previewDeps}' . && { [ -x node_modules/.bin/nest ] || chmod +x node_modules/@nestjs/cli/bin/nest.js; } && { bash '${previewDb}' create {db} || { echo '[orca] preview DB setup failed — retrying (2/3)'; sleep 3; bash '${previewDb}' create {db}; } || { echo '[orca] retrying (3/3)'; sleep 5; bash '${previewDb}' create {db}; }; } && { ( for i in $(seq 1 90); do curl -s -o /dev/null http://localhost:{port} 2>/dev/null && { for org in demo jeremiah flow electric_vehicle; do bash scripts/invite-user-local.sh test@example.com "$org" Test User; done; break; }; sleep 2; done ) >/dev/null 2>&1 & PORT={port} bash scripts/dev-local-watch.sh; }`, onStop: `cd backend && bash '${previewDb}' drop {db}` },
        // Seed frontend/.env from the tracked template (the canonical local step) so vite dev bakes
        // the same VITE_*_BASE_URL values a normal run has — without it every integration shows as
        // unavailable. Copy only when absent: macOS `cp -n` exits 1 when the file exists, which
        // would short-circuit the `&&` chain and stop the frontend from ever starting. VITE_BACKEND_URL
        // pins this frontend to its own backend port (not the default :3000).
        // Same self-heal as the backend (preview-deps.sh): reinstall only when the CoW-cloned tree has
        // drifted from the lockfile — so a dep the branch added (incl. the client-gen @hey-api/openapi-ts)
        // is present, without a full install on every start.
        { name: "frontend", command: `cd frontend && bash '${previewDeps}' . && { [ -f .env ] || cp .env.template .env; } && VITE_BACKEND_URL=http://localhost:{svc:backend} FRONTEND_PORT={port} bash scripts/dev-local-test.sh`, open: true },
      ],
      // Gitignored config a fresh worktree checkout lacks — without it the backend boots with no
      // provider/AWS keys. Copied on create + checkout. (The per-preview DB scripts now live in the
      // Orca repo — see `previewDb` — so they no longer need copying into each worktree.)
      copyToWorktree: ["backend/.env"],
      // A fresh checkout has no node_modules; CoW-clone the main repo's (APFS clonefile, see git.ts) so
      // nest/vite/ts-node resolve without a slow install, and each worktree's tree is isolated — no
      // cross-worktree corruption. (Re-install in the worktree if a branch bumps deps.)
      // shared/node_modules too: backend imports @shared/* as TS source (tsconfig path → ../shared/src),
      // so shared's OWN runtime deps (platejs, @platejs/*) must resolve from shared/node_modules — a
      // missing clone here is a MODULE_NOT_FOUND at backend start. Needs `npm install` in the main
      // repo's shared/ so there's a tree to clone (mirrors the backend/frontend assumption).
      linkToWorktree: ["backend/node_modules", "frontend/node_modules", "shared/node_modules"],
    },
    {
      name: "orca",
      repoPath: `${DEV}/orca`,
      worktreeRoot: `${DEV}/orca/.worktrees`,
      baseBranch: "main",
      slackChannel: "#engineering",
      previewServices: [
        { name: "web", command: "cd web && bunx --bun vite --port {port}", open: true },
      ],
    },
  ],
  portRange: [10_000, 65_000], // previews pick a random free port in here (TCP max is 65535)
  staleHours: 24,
  agentTimeoutMinutes: 45,
};

export default config;
