import type { OrcaConfig } from "./server/config";

// Edit these to point Orca at the repo you want to manage.
const config: OrcaConfig = {
  repoPath: process.env.ORCA_REPO_PATH ?? "/Users/finnformica/Documents/dev/branch-demo",
  worktreeRoot: process.env.ORCA_WORKTREE_ROOT ?? "/Users/finnformica/Documents/dev/branch-demo/.worktrees",
  baseBranch: process.env.ORCA_BASE_BRANCH ?? "master",
  portRange: [4173, 4272],
  // Each preview spins up these services on assigned ports (frontend wired to its backend).
  // Tweak the commands/env to match your repo (e.g. how the backend reads its port).
  previewServices: [
    { name: "backend", command: process.env.ORCA_BACKEND_CMD ?? "PORT={port} npm --prefix backend run dev" },
    {
      name: "frontend",
      command: process.env.ORCA_FRONTEND_CMD ?? "VITE_BACKEND_URL=http://localhost:{svc:backend} npm --prefix frontend run dev -- --port {port}",
      open: true,
    },
  ],
  staleHours: 24,
  // Orca hands you a prompt to post to Slack (Claude already has Slack access);
  // it never posts directly. This channel just gets named in that prompt.
  slackChannel: process.env.SLACK_CHANNEL ?? "#v3-engineering",
};

export default config;
