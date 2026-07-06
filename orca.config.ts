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
        { name: "backend", command: "cd backend && bash scripts/migrate-local.sh && { ( until curl -s -o /dev/null http://localhost:{port} 2>/dev/null; do sleep 2; done; for org in demo jeremiah flow; do bash scripts/invite-user-local.sh test@example.com \"$org\" Test User; done ) >/dev/null 2>&1 & PORT={port} bash scripts/dev-local-watch.sh; }" },
        // Seed frontend/.env from the tracked template (the canonical local step) so vite dev bakes
        // the same VITE_*_BASE_URL values a normal run has — without it every integration shows as
        // unavailable. Copy only when absent: macOS `cp -n` exits 1 when the file exists, which
        // would short-circuit the `&&` chain and stop the frontend from ever starting. VITE_BACKEND_URL
        // pins this frontend to its own backend port (not the default :3000).
        { name: "frontend", command: "cd frontend && { [ -f .env ] || cp .env.template .env; } && VITE_BACKEND_URL=http://localhost:{svc:backend} FRONTEND_PORT={port} bash scripts/dev-local-test.sh", open: true },
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
