/** Preview service: `{port}` = this service's assigned port; `{svc:name}` = another's. */
export type PreviewService = { name: string; command: string; open?: boolean };

export type RepoConfig = {
  /** Short id used in the URL and repo switcher, e.g. "orca". */
  name: string;
  /** Absolute path to the git repo. */
  repoPath: string;
  /** Directory under which per-workstream worktrees are created. */
  worktreeRoot: string;
  /** Branch PRs target and change summaries diff against. */
  baseBranch: string;
  /** Services started per workstream preview. `open` marks the one to open in the browser. */
  previewServices: PreviewService[];
  /** Channel named in the Slack prompt (Orca doesn't post — Claude does). */
  slackChannel?: string;
  /** Label that triggers the deploy-preview action (added by the "Add preview" button). */
  previewLabel?: string;
  /**
   * Gitignored config files to copy from the main repo into each new/adopted worktree, so
   * previews inherit local secrets a checkout can't (e.g. `backend/.env`). Repo-relative paths;
   * missing ones are skipped.
   */
  copyToWorktree?: string[];
  /**
   * Heavy shared dirs to symlink (not copy) from the main repo into each worktree — a fresh
   * checkout has no `node_modules`, and installing per-worktree is slow/huge. Repo-relative paths.
   * Deps resolve through the link as if in the main repo; safe as long as the branch hasn't
   * changed its lockfile (else run a real install in the worktree).
   */
  linkToWorktree?: string[];
};

export type OrcaConfig = {
  /** Repos Orca manages; the first is the default. */
  repos: RepoConfig[];
  /** Inclusive [min, max] port range for preview services (shared across repos). */
  portRange: [number, number];
  /** Hours a PR's Slack message may sit before a bump is allowed. */
  staleHours: number;
};

/** Look up a repo by name, defaulting to the first configured repo. */
export const repoOf = (cfg: OrcaConfig, name?: string): RepoConfig =>
  cfg.repos.find((r) => r.name === name) ?? cfg.repos[0]!;

/** API server port (the local bridge). Defined in a leaf module so the Vite proxy can import it
 *  without dragging orca.config into Vite's config-dependency graph — see server/ports.ts. */
export { API_PORT } from "./ports";

// Loaded lazily so tests can exercise adapters without a config file.
export async function loadConfig(): Promise<OrcaConfig> {
  const mod = await import("../orca.config.ts");
  return mod.default as OrcaConfig;
}
