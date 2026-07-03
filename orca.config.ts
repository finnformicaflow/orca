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
      // running, and backend/.env present). Backend runs on its default port; only the frontend
      // gets an assigned port (the one we open).
      previewServices: [
        { name: "backend", command: "cd backend && bash scripts/dev-local-watch.sh" },
        { name: "frontend", command: "cd frontend && FRONTEND_PORT={port} bash scripts/dev-local-test.sh", open: true },
      ],
      // Gitignored config a fresh worktree checkout lacks — without it the backend boots with no
      // OPENAI/AWS keys ("AI agent unavailable", "no integrations"). Copied on create + checkout.
      copyToWorktree: ["backend/.env"],
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
  portRange: [4173, 4272],
  staleHours: 24,
};

export default config;
