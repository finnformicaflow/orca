import type { OrcaConfig } from "./server/config";

const DEV = "/Users/finnformica/Documents/dev";

// Repos Orca manages. Add/remove entries here. The first is the default.
const config: OrcaConfig = {
  repos: [
    {
      name: "branch-demo",
      repoPath: `${DEV}/branch-demo`,
      worktreeRoot: `${DEV}/branch-demo/.worktrees`,
      baseBranch: "master",
      slackChannel: "#v3-engineering",
      previewLabel: "preview",
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
        { name: "backend", command: "cd backend && { [ -f node_modules/@cspotcode/source-map-support/package.json ] || { find -E node_modules -type d -regex '.*/\\.[^/]+-[A-Za-z0-9_]+$' -prune -exec rm -rf {} + 2>/dev/null; npm install --no-audit --no-fund; }; } && { [ -x node_modules/.bin/nest ] || chmod +x node_modules/@nestjs/cli/bin/nest.js; } && { bash scripts/migrate-local.sh || { echo '[orca] migrate failed — retrying (2/3)'; sleep 3; bash scripts/migrate-local.sh; } || { echo '[orca] retrying (3/3)'; sleep 5; bash scripts/migrate-local.sh; }; } && { ( for i in $(seq 1 90); do curl -s -o /dev/null http://localhost:{port} 2>/dev/null && { for org in demo jeremiah flow electric_vehicle; do bash scripts/invite-user-local.sh test@example.com \"$org\" Test User; done; break; }; sleep 2; done ) >/dev/null 2>&1 & PORT={port} bash scripts/dev-local-watch.sh; }" },
        // Seed frontend/.env from the tracked template (the canonical local step) so vite dev bakes
        // the same VITE_*_BASE_URL values a normal run has — without it every integration shows as
        // unavailable. Copy only when absent: macOS `cp -n` exits 1 when the file exists, which
        // would short-circuit the `&&` chain and stop the frontend from ever starting. VITE_BACKEND_URL
        // pins this frontend to its own backend port (not the default :3000).
        // Same self-heal as the backend: the frontend's client-generation runs @hey-api/openapi-ts;
        // if the source tree was missing it at clone time, repair. Cheap resolve check → repair only if broken.
        { name: "frontend", command: "cd frontend && { [ -f node_modules/@hey-api/openapi-ts/package.json ] || npm install --no-audit --no-fund; } && { [ -f .env ] || cp .env.template .env; } && VITE_BACKEND_URL=http://localhost:{svc:backend} FRONTEND_PORT={port} bash scripts/dev-local-test.sh", open: true },
      ],
      // Gitignored config a fresh worktree checkout lacks — without it the backend boots with no
      // provider/AWS keys. Copied on create + checkout.
      copyToWorktree: ["backend/.env"],
      // A fresh checkout has no node_modules; CoW-clone the main repo's (APFS clonefile, see git.ts) so
      // nest/vite/ts-node resolve without a slow install, and each worktree's tree is isolated — no
      // cross-worktree corruption. (Re-install in the worktree if a branch bumps deps.)
      linkToWorktree: ["backend/node_modules", "frontend/node_modules"],
    },
    {
      name: "orca",
      repoPath: `${DEV}/orca`,
      worktreeRoot: `${DEV}/orca/.worktrees`,
      baseBranch: "main",
      slackChannel: "#v3-engineering",
      previewServices: [
        { name: "web", command: "cd web && bunx --bun vite --port {port}", open: true },
      ],
    },
  ],
  portRange: [10_000, 65_000], // previews pick a random free port in here (TCP max is 65535)
  staleHours: 24,
};

export default config;
