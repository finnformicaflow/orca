// The models a card or chat can be pinned to. A model implies its provider (which CLI runs it), so
// picking one replaces picking a provider. Every choice is a real id passed as --model (there is no
// "CLI default" entry: the default is Fable 5.1). Pure; shared by the server (argv) and the web (picker).
import { agentLabel, type AgentProvider } from "./agent";

export type AgentModel = { id: string; label: string; provider: AgentProvider };

// Curated, not exhaustive: the ids each CLI accepts today. Claude aliases/ids per `claude --help`;
// Codex's `-m` (gpt-5.5 verified); Cursor's `--model` examples from its own help (its full list is
// per-account: `cursor-agent models`). An id outside this list still works — the picker just shows it raw.
export const MODELS: AgentModel[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1", provider: "claude" },
  { id: "claude-opus-5", label: "Opus 5", provider: "claude" },
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", provider: "claude" },
  { id: "gpt-5.5", label: "GPT-5.5", provider: "codex" },
  { id: "gpt-5", label: "GPT-5", provider: "cursor" },
  { id: "sonnet-4-thinking", label: "Sonnet 4 thinking", provider: "cursor" },
];

/** The model a provider runs on when nothing is pinned: the first catalog entry (Claude → Fable 5.1). */
export const defaultModelOf = (provider: AgentProvider): string => MODELS.find((m) => m.provider === provider)!.id;

/** A model id → a friendly name: `claude-opus-4-8[1m]` → "Opus 4.8", `claude-fable-5-1` → "Fable 5.1". */
export function prettyModel(id: string): string {
  const core = id.replace(/^claude-/, "").replace(/\[[^\]]*\]$/, "").replace(/-\d{6,8}$/, "");
  const [family, ...ver] = core.split("-");
  const cap = (s: string | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  return ver.length ? `${cap(family)} ${ver.join(".")}` : cap(core) || id;
}

/** Which CLI runs a model id. Catalog first; then Claude's own aliases/ids by shape; else unknown. */
export function providerOfModel(id: string | undefined): AgentProvider | undefined {
  if (!id) return undefined;
  const known = MODELS.find((m) => m.id === id);
  if (known) return known.provider;
  if (/^claude-/.test(id) || ["fable", "opus", "sonnet", "haiku"].includes(id)) return "claude";
  return undefined;
}

/** What the picker shows for an id: "Claude · Fable 5.1", or the prettified raw id for one off-catalog. */
export function modelLabel(id: string): string {
  const provider = providerOfModel(id) ?? "claude";
  const known = MODELS.find((m) => m.id === id);
  return `${agentLabel(provider)} · ${known?.label ?? prettyModel(id)}`;
}

/** The picker's choices: the catalog models of the providers installed here, in provider order. */
export const modelChoices = (providers: readonly AgentProvider[]): AgentModel[] => MODELS.filter((m) => providers.includes(m.provider));
