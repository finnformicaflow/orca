import * as db from "./db";
import { AGENT_PROVIDERS, type AgentProvider } from "../shared/agent";

/** Preview service: `{port}` = this service's assigned port; `{svc:name}` = another's. */
export type PreviewService = {
  name: string;
  command: string;
  open?: boolean;
  /** Command run when the preview is torn down (Discard / preview-stop), NOT on the reap-before-restart
   *  or on shutdown. `{db}` is substituted with this preview's per-worktree database name — the hook is
   *  how a per-preview Postgres DB gets dropped. Runs with the worktree as cwd, best-effort. */
  onStop?: string;
};

/** Per-repo opt-ins. Every one defaults to OFF, because each either spends money, is externally
 *  visible, or hands an agent more authority than a repo's owner might expect. A repo has to say yes.
 *
 *  (Existing repos are backfilled at migration 3 with what they were already doing, so turning this
 *  on changes nothing about a board that already works — the behaviour just becomes explicit and
 *  revocable rather than implicit.) */
export type RepoFeatures = {
  /** Post the notify/bump message to `slackChannel`. Off → the client copies it to your clipboard. */
  slack?: boolean;
  /** Let a PR's new feedback fire agent actions on its own. Spends money while you aren't looking. */
  followAutomation?: boolean;
  /** Have the agent write the PR body. Off → the repo's template, or the commit list. */
  aiPrDescription?: boolean;
  /** Offer GitHub auto-merge. */
  autoMerge?: boolean;
  /** Start preview services. Heavy: database clones, ports, disk. */
  previews?: boolean;
  /** Name and rename cards with a model. */
  aiTitles?: boolean;
};

/** How much authority a repo's agents get. Orca has always run `--permission-mode bypassPermissions`
 *  unconditionally; that's fine for your own repo and much less so for a client's, so it becomes a
 *  per-repo choice. `bypass` preserves today's behaviour. */
export type AgentPermissionMode = "bypass" | "ask";

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
  /** Channel the Slack notify/bump message names (the agent posts to it via its Slack tool). */
  slackChannel?: string;
  /** Label that triggers the deploy-preview action (added by the "Add preview" button). */
  previewLabel?: string;
  /** Labels offered as toggles in the Promote-to-PR menu; `default: true` starts checked. */
  prLabels?: { name: string; default?: boolean }[];
  /**
   * Gitignored config files to copy from the main repo into each new/adopted worktree, so
   * previews inherit local secrets a checkout can't (e.g. `backend/.env`). Repo-relative paths;
   * missing ones are skipped.
   */
  copyToWorktree?: string[];
  /**
   * Model for this repo's headless Claude agent runs, e.g. `claude-opus-5[1m]` or a shorthand like
   * `opus`. Unset → the `claude` CLI's own default (`model` in ~/.claude/settings.json), which is
   * what your interactive sessions use. Setting it here scopes the choice to Orca's agents.
   * Claude only: Codex/Cursor pick their model from their own CLI config. Does NOT affect the title
   * and PR-description one-shots — those pin haiku/sonnet deliberately (they're short, blocking calls).
   */
  agentModel?: string;
  /** Per-repo opt-ins; absent means every feature is off. See RepoFeatures. */
  features?: RepoFeatures;
  /** Agent providers this repo may use. Absent/empty = none, so a repo opts in to the models it
   *  wants — a client project need not be reachable by every CLI you happen to have installed. */
  providers?: AgentProvider[];
  /** Authority granted to this repo's agents (default `ask`, i.e. NOT bypassPermissions). */
  agentPermissionMode?: AgentPermissionMode;
  /**
   * Heavy dirs to provision from the main repo into each worktree — a fresh checkout has no
   * `node_modules`, and a real per-worktree install is slow/huge. Repo-relative paths.
   * `node_modules` is CoW-cloned (APFS clonefile) so each worktree gets an independent, block-shared
   * copy — isolated, so no worktree's install/build can corrupt another's deps (see git.ts). Other
   * paths are symlinked. Safe while the branch hasn't changed its lockfile (else install in the WT).
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
  /** Hard ceiling for one headless agent run, preventing abandoned sessions consuming quota. */
  agentTimeoutMinutes?: number;
};

/** A repo path as STORED. Paths are per-machine — once a laptop and a cloud box share one database,
 *  the same repo lives at different absolute paths on each — so a stored config keeps them as
 *  templates and each instance expands them on read. `${ORCA_DEV_ROOT}` and a leading `~` are the two
 *  forms; anything else is taken literally. */
export function expandPath(value: string): string {
  const devRoot = process.env.ORCA_DEV_ROOT ?? "";
  const home = process.env.HOME ?? "";
  return value
    .replace(/\$\{ORCA_DEV_ROOT\}/g, devRoot)
    .replace(/^~(?=\/|$)/, home);
}

/** The inverse, used when seeding the database from the checked-in file: store the portable form so
 *  another machine reading the same row resolves it against its own ORCA_DEV_ROOT. */
export function templatePath(value: string): string {
  const devRoot = process.env.ORCA_DEV_ROOT;
  if (devRoot && value.startsWith(devRoot)) return `\${ORCA_DEV_ROOT}${value.slice(devRoot.length)}`;
  return value;
}

const PATH_FIELDS = ["repoPath", "worktreeRoot"] as const;

/** Validate a pasted configuration document. Returns the parsed config or a list of problems — the
 *  point of a paste-a-document flow is that a bad paste is REJECTED with reasons, not half-applied.
 *  Pure, so the rules are testable without a database. */
export function parseConfigDocument(doc: unknown): { config?: OrcaConfig; errors: string[] } {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { errors: ["config must be an object"] };
  const d = doc as Record<string, unknown>;
  const repos = d.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    errors.push("repos must be a non-empty array");
    return { errors };
  }
  const seen = new Set<string>();
  for (const [i, raw] of repos.entries()) {
    const where = `repos[${i}]`;
    if (!raw || typeof raw !== "object") { errors.push(`${where} must be an object`); continue; }
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) errors.push(`${where}.name is required`);
    else if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) errors.push(`${where}.name must be a slug (letters, digits, dashes)`);
    else if (seen.has(name)) errors.push(`${where}.name "${name}" is duplicated`);
    else seen.add(name);
    for (const f of ["repoPath", "worktreeRoot", "baseBranch"] as const) {
      if (typeof r[f] !== "string" || !(r[f] as string).trim()) errors.push(`${where}.${f} is required`);
    }
    if (r.providers !== undefined) {
      const bad = Array.isArray(r.providers)
        ? (r.providers as unknown[]).filter((v) => !AGENT_PROVIDERS.includes(v as AgentProvider))
        : ["(not an array)"];
      if (bad.length) errors.push(`${where}.providers must contain only ${AGENT_PROVIDERS.join(", ")}`);
    }
    if (r.agentPermissionMode !== undefined && !["bypass", "ask"].includes(r.agentPermissionMode as string)) {
      errors.push(`${where}.agentPermissionMode must be "bypass" or "ask"`);
    }
    if (r.features !== undefined) {
      if (!r.features || typeof r.features !== "object" || Array.isArray(r.features)) {
        errors.push(`${where}.features must be an object`);
      } else {
        const known = ["slack", "followAutomation", "aiPrDescription", "autoMerge", "previews", "aiTitles"];
        for (const [k, v] of Object.entries(r.features as Record<string, unknown>)) {
          // An unknown key is almost always a typo, and a silently-ignored typo here means a feature
          // you believe you enabled is off.
          if (!known.includes(k)) errors.push(`${where}.features.${k} is not a known feature (${known.join(", ")})`);
          else if (typeof v !== "boolean") errors.push(`${where}.features.${k} must be true or false`);
        }
      }
    }
    if (r.previewServices !== undefined && !Array.isArray(r.previewServices)) {
      errors.push(`${where}.previewServices must be an array`);
    }
    for (const [j, svc] of ((r.previewServices as unknown[]) ?? []).entries()) {
      const s = svc as Record<string, unknown> | null;
      if (!s || typeof s !== "object") { errors.push(`${where}.previewServices[${j}] must be an object`); continue; }
      if (typeof s.name !== "string" || !s.name.trim()) errors.push(`${where}.previewServices[${j}].name is required`);
      if (typeof s.command !== "string" || !s.command.trim()) errors.push(`${where}.previewServices[${j}].command is required`);
    }
  }
  const portRange = d.portRange;
  if (portRange !== undefined) {
    const ok = Array.isArray(portRange) && portRange.length === 2
      && portRange.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65536)
      && (portRange[0] as number) <= (portRange[1] as number);
    if (!ok) errors.push("portRange must be [min, max] port numbers with min <= max");
  }
  if (d.staleHours !== undefined && (typeof d.staleHours !== "number" || d.staleHours < 0)) {
    errors.push("staleHours must be a non-negative number");
  }
  if (d.agentTimeoutMinutes !== undefined && (typeof d.agentTimeoutMinutes !== "number" || d.agentTimeoutMinutes <= 0)) {
    errors.push("agentTimeoutMinutes must be a positive number");
  }
  if (errors.length) return { errors };
  return {
    errors: [],
    config: {
      repos: repos as RepoConfig[],
      portRange: (portRange as [number, number]) ?? [30000, 40000],
      staleHours: (d.staleHours as number) ?? 24,
      agentTimeoutMinutes: d.agentTimeoutMinutes as number | undefined,
    },
  };
}

/** Look up a repo by name, defaulting to the first configured repo. */
export const repoOf = (cfg: OrcaConfig, name?: string): RepoConfig =>
  cfg.repos.find((r) => r.name === name) ?? cfg.repos[0]!;

/** API server port (the local bridge). Defined in a leaf module so the Vite proxy can import it
 *  without dragging orca.config into Vite's config-dependency graph — see server/ports.ts. */
export { API_PORT } from "./ports";

// The configuration lives in the DATABASE, so adding a project is a paste rather than an edit-and-
// restart — and so a second Orca instance sharing the database inherits it. `orca.config.ts` remains
// only as the seed for a database that has never been configured, and as the escape hatch if you'd
// rather keep editing a file.
//
// Cached in memory because the board polls constantly; `invalidateConfig()` clears it on write, so a
// paste takes effect on the next request with no restart.
let cached: OrcaConfig | null = null;

export function invalidateConfig(): void {
  cached = null;
}

/** The checked-in file, or undefined when there isn't one (a fresh install, or ORCA_DEV_ROOT unset). */
async function fileConfig(): Promise<OrcaConfig | undefined> {
  try {
    const mod = await import("../orca.config.ts");
    return mod.default as OrcaConfig;
  } catch {
    return undefined;
  }
}

/** Store the checked-in file as the initial rows, with machine-specific path prefixes turned back
 *  into `${ORCA_DEV_ROOT}` templates so another machine resolves them against its own root. */
async function seedFromFile(file: OrcaConfig): Promise<void> {
  await db.saveConfig({
    repos: file.repos.map(({ name, ...rest }) => ({
      name,
      config: {
        ...rest,
        repoPath: templatePath(rest.repoPath),
        worktreeRoot: templatePath(rest.worktreeRoot),
      } as unknown as db.Fields,
    })),
    app: {
      portRange: file.portRange,
      staleHours: file.staleHours,
      ...(file.agentTimeoutMinutes === undefined ? {} : { agentTimeoutMinutes: file.agentTimeoutMinutes }),
    },
  });
}

/** The effective configuration: database rows, seeded once from the file if the database is empty. */
export async function loadConfig(): Promise<OrcaConfig> {
  if (cached) return cached;
  let rows = await db.repoConfigs();
  if (!rows.length) {
    const file = await fileConfig();
    if (file?.repos.length) {
      await seedFromFile(file);
      rows = await db.repoConfigs();
    }
  }
  const app = await db.appConfig();
  const config: OrcaConfig = {
    repos: rows.map((r) => {
      const c = r.config as unknown as RepoConfig;
      return { ...c, name: r.name, repoPath: expandPath(c.repoPath ?? ""), worktreeRoot: expandPath(c.worktreeRoot ?? "") };
    }),
    portRange: (app.portRange as [number, number]) ?? [30000, 40000],
    staleHours: (app.staleHours as number) ?? 24,
    agentTimeoutMinutes: app.agentTimeoutMinutes as number | undefined,
  };
  cached = config;
  return config;
}

/** Persist a validated document, storing paths in their portable form. Invalidates the cache, so the
 *  next request sees it — no restart. */
export async function saveConfigDocument(config: OrcaConfig): Promise<void> {
  await db.saveConfig({
    repos: config.repos.map(({ name, ...rest }) => ({
      name,
      config: {
        ...rest,
        repoPath: templatePath(rest.repoPath),
        worktreeRoot: templatePath(rest.worktreeRoot),
      } as unknown as db.Fields,
    })),
    app: {
      portRange: config.portRange,
      staleHours: config.staleHours,
      ...(config.agentTimeoutMinutes === undefined ? {} : { agentTimeoutMinutes: config.agentTimeoutMinutes }),
    },
  });
  invalidateConfig();
}

/** The document as stored (paths still templated) — what the settings UI shows you to edit. */
export async function configDocument(): Promise<Record<string, unknown>> {
  const rows = await db.repoConfigs();
  const app = await db.appConfig();
  return { repos: rows.map((r) => ({ name: r.name, ...r.config })), ...app };
}


/** A repo's opt-ins with every default applied — the single place "off unless asked" is decided. */
export function featuresOf(repo: RepoConfig): Required<RepoFeatures> {
  const f = repo.features ?? {};
  return {
    slack: f.slack === true,
    followAutomation: f.followAutomation === true,
    aiPrDescription: f.aiPrDescription === true,
    autoMerge: f.autoMerge === true,
    previews: f.previews === true,
    aiTitles: f.aiTitles === true,
  };
}

/** The providers a repo may launch, intersected with what's actually installed on THIS machine — a
 *  repo can opt into Codex without every instance having the binary. */
export function providersFor(repo: RepoConfig, available: readonly AgentProvider[]): AgentProvider[] {
  const allowed = repo.providers?.length ? repo.providers : [];
  return AGENT_PROVIDERS.filter((p) => allowed.includes(p) && available.includes(p));
}

/** Whether a repo may run this provider — the check every launch path goes through. */
export function providerAllowed(repo: RepoConfig, provider: AgentProvider): boolean {
  return (repo.providers ?? []).includes(provider);
}
