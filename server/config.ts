export type OrcaConfig = {
  /** Absolute path to the git repo Orca manages. */
  repoPath: string;
  /** Directory under which per-workstream worktrees are created. */
  worktreeRoot: string;
  /** Branch PRs target and change summaries diff against. */
  baseBranch: string;
  /** Inclusive [min, max] port range for per-workstream dev servers. */
  portRange: [number, number];
  /** Preview services started per workstream. `{port}` = this service's assigned port;
   *  `{svc:name}` = another service's port. `open` marks the one to open in the browser. */
  previewServices: { name: string; command: string; open?: boolean }[];
  /** Hours a PR's Slack message may sit before a bump is allowed. */
  staleHours: number;
  /** Channel named in the Slack prompt (Orca doesn't post — it hands you a prompt). */
  slackChannel?: string;
};

/** API server port (the local bridge). */
export const API_PORT = Number(process.env.ORCA_API_PORT ?? 8787);

// Loaded lazily so tests can exercise adapters without a config file.
export async function loadConfig(): Promise<OrcaConfig> {
  const mod = await import("../orca.config.ts");
  return mod.default as OrcaConfig;
}
