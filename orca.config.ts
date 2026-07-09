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
        // SELF-HEAL node_modules: every worktree symlinks the one shared backend/node_modules, so an
        // interrupted `npm install` anywhere (an agent adding a dep, a manual Ctrl-C) leaves a staging
        // dir and breaks ts-node ("Cannot find module @cspotcode/source-map-support") for EVERY
        // preview. The `-f package.json` check is an instant no-op when healthy (a plain file test —
        // not `require.resolve`, which false-negatives on ESM-`exports` packages); only when the
        // fragile dep is actually missing does it run a non-destructive `npm install` before booting.
        // That reinstall first sweeps leftover `.<pkg>-<random>` staging dirs (npm's atomic-rename
        // scratch, orphaned when an install is killed — they had piled up to 1600+ and are what
        // strands entity decorators mid-install → mikro-orm's "only abstract entities discovered").
        // The sweep is safe: the `npm install` right after restores anything real it might touch.
        // `find -E` = BSD extended regex (/usr/bin/find defaults to basic, where `+` is a literal, so
        // the pattern would match nothing without it).
        // Second self-heal: an `npm install` into the shared tree sometimes lands @nestjs/cli's
        // bin/nest.js without its execute bit, so `npx nest` dies with "Permission denied" in EVERY
        // worktree. `[ -x .bin/nest ]` follows the symlink to test the target's bit; chmod repairs it.
        // RETRY migrate: `cache:generate` inside migrate-local.sh intermittently throws mikro-orm's
        // "only abstract entities discovered" — a transient race when a preview boots against the
        // node_modules that 4+ other preview/agent processes are concurrently reading/mutating (the
        // decorators momentarily fail to register). It's idempotent and clears on a re-run, but
        // migrate-local.sh is `set -e`, so a single hiccup would kill the whole preview. Retry up to
        // 3× with backoff; a genuine failure (DB down, real migration error) still fails all 3 and
        // surfaces in the preview log.
        { name: "backend", command: "cd backend && { [ -f node_modules/@cspotcode/source-map-support/package.json ] || { find -E node_modules -type d -regex '.*/\\.[^/]+-[A-Za-z0-9_]+$' -prune -exec rm -rf {} + 2>/dev/null; npm install --no-audit --no-fund; }; } && { [ -x node_modules/.bin/nest ] || chmod +x node_modules/@nestjs/cli/bin/nest.js; } && { bash scripts/migrate-local.sh || { echo '[orca] migrate failed — transient shared-node_modules race? retrying (2/3)'; sleep 3; bash scripts/migrate-local.sh; } || { echo '[orca] retrying (3/3)'; sleep 5; bash scripts/migrate-local.sh; }; } && { ( for i in $(seq 1 90); do curl -s -o /dev/null http://localhost:{port} 2>/dev/null && { for org in demo jeremiah flow electric_vehicle; do bash scripts/invite-user-local.sh test@example.com \"$org\" Test User; done; break; }; sleep 2; done ) >/dev/null 2>&1 & PORT={port} bash scripts/dev-local-watch.sh; }" },
        // Seed frontend/.env from the tracked template (the canonical local step) so vite dev bakes
        // the same VITE_*_BASE_URL values a normal run has — without it every integration shows as
        // unavailable. Copy only when absent: macOS `cp -n` exits 1 when the file exists, which
        // would short-circuit the `&&` chain and stop the frontend from ever starting. VITE_BACKEND_URL
        // pins this frontend to its own backend port (not the default :3000).
        // Same self-heal as the backend: the frontend's client-generation runs @hey-api/openapi-ts,
        // which the shared-node_modules corruption also strands. Cheap resolve check → repair only if broken.
        { name: "frontend", command: "cd frontend && { [ -f node_modules/@hey-api/openapi-ts/package.json ] || npm install --no-audit --no-fund; } && { [ -f .env ] || cp .env.template .env; } && VITE_BACKEND_URL=http://localhost:{svc:backend} FRONTEND_PORT={port} bash scripts/dev-local-test.sh", open: true },
      ],
      // Gitignored config a fresh worktree checkout lacks — without it the backend boots with no
      // provider/AWS keys. Copied on create + checkout.
      copyToWorktree: ["backend/.env"],
      // A fresh checkout has no node_modules; symlink the main repo's so nest/vite/ts-node resolve
      // without a slow per-worktree install. (Re-install in the worktree if a branch bumps deps.)
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
