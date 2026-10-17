// Settings > Integrations (docs/research/integrations.md §6.1): the page's data shape and its pure
// decisions — a card's health tone, the subscription presets, what a row reads as, and the checks a
// form runs before it posts. Pure: the server (server/integrations/admin.ts), the page
// (web/src/views/Integrations.tsx) and the tests import it as is.
import { secretRefRefusal, type AdapterMeta, type DeliveryTarget, type Level, type Subscription, type TargetKind } from "./integrations";

/** One integration as the page shows it: the row, its health and what it ran last. */
export type IntegrationCard = {
  id: string; kind: string; name: string; instance: string; enabled: boolean;
  config: Record<string, unknown>; secretRef?: string;
  /** Whether the variable `secretRef` names is set — known only on the instance that runs it
   *  (undefined elsewhere, until that instance's Test records it). Never the value. */
  secretSet?: boolean;
  /** `running` = this bridge runs it now; `health` = its last live check (here, or the status row). */
  running: boolean;
  health?: { ok: boolean; detail?: string; at?: number; startedAt?: number; error?: string };
  lastEventAt?: number;
};

export type LinkRow = { id: string; integrationId: string; externalId: string; label?: string; level: Exclude<Level, "full">; repos: string[]; requireMention: boolean };
export type PersonRow = { id: string; name: string; maxLevel: Exclude<Level, "full">; identities: { adapter: string; externalId: string }[] };

/** A pending pairing code (the core's server/integrations/store.ts `Pairing`): an unknown sender
 *  wrote to a link; you approve or deny them here. */
export type Pairing = {
  code: string; integrationId: string; adapter: string; externalId: string; name?: string; linkId?: string;
  createdAt: number; expiresAt: number; state: "pending" | "approved" | "denied"; principalId?: string;
};

export type DeadRow = { id: number; eventId: string; target: DeliveryTarget; attempts: number; lastError?: string; topic: string; key: string; title?: string; at?: number };

export type IntegrationsOverview = {
  instance: string;
  kinds: AdapterMeta[];
  integrations: IntegrationCard[];
  links: LinkRow[];
  people: PersonRow[];
  pairings: Pairing[];
  subscriptions: Subscription[];
  dead: DeadRow[];
};

export type Tone = "ready" | "warning" | "error" | "neutral";

/** A card's dot: off is gray; a failed start or check is red; a row with no live check yet, or one
 *  last seen on another instance more than 10 minutes ago, is amber; else green. */
export function healthTone(c: Pick<IntegrationCard, "enabled" | "running" | "health" | "secretSet">, now = Date.now()): Tone {
  if (!c.enabled) return "neutral";
  if (c.secretSet === false) return "error";
  if (!c.health) return "warning";
  if (!c.health.ok) return "error";
  if (!c.running && c.health.at && now - c.health.at > 10 * 60_000) return "warning";
  return "ready";
}

/** A compact duration: "now", "4m", "3h", "2d". */
export function span(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
const ago = (ms: number): string => (span(ms) === "now" ? "just now" : `${span(ms)} ago`);

/** The one line under a card's name: off, the error, or "Connected 2h · last event 3m ago". */
export function healthLine(c: IntegrationCard, now = Date.now()): string {
  if (!c.enabled) return "Disconnected";
  if (c.secretSet === false) return `${c.secretRef ?? "The token variable"} is not set on ${c.instance}`;
  const parts: string[] = [];
  if (!c.health) parts.push(c.running ? "Starting" : `Not checked yet on ${c.instance}`);
  else if (!c.health.ok) parts.push(c.health.error ?? c.health.detail ?? "Not healthy");
  else parts.push(c.health.startedAt ? `Connected ${span(now - c.health.startedAt)}` : c.health.detail ?? "Connected");
  parts.push(c.lastEventAt ? `last event ${ago(now - c.lastEventAt)}` : "no events yet");
  return parts.join(" · ");
}

/** §6.1's presets: one click adds the subscription to a link. */
export const SUBSCRIPTION_PRESETS: { id: string; label: string; topicPattern: string; digestSeconds?: number }[] = [
  { id: "pr", label: "PR events", topicPattern: "orca.pr.*" },
  { id: "done", label: "Worker done", topicPattern: "orca.run.finished" },
  { id: "questions", label: "Questions for me", topicPattern: "orca.question" },
  { id: "ci", label: "CI failures (digest 10 min)", topicPattern: "orca.pr.ci_failed", digestSeconds: 600 },
];

export const TARGET_KINDS: TargetKind[] = ["link", "orchestrator", "workstream", "web"];

/** A subscription's target as words: "#eng (Work Slack)", "the orchestrator", "orca::main", "this web app". */
export function targetLabel(s: Pick<Subscription, "targetKind" | "targetId">, links: LinkRow[], cards: Pick<IntegrationCard, "id" | "name">[]): string {
  if (s.targetKind === "orchestrator") return "the orchestrator";
  if (s.targetKind === "web") return "the web app";
  if (s.targetKind === "workstream") return s.targetId ?? "?";
  const l = links.find((x) => x.id === s.targetId);
  if (!l) return `link ${s.targetId ?? "?"} (removed)`;
  const card = cards.find((c) => c.id === l.integrationId);
  return `${l.label ?? l.externalId}${card ? ` · ${card.name}` : ""}`;
}

export const filterText = (f: Record<string, string>): string =>
  Object.entries(f).map(([k, v]) => `${k}=${v}`).join(", ");

/** "repo=orca, adapter=slack" → {repo: "orca", adapter: "slack"}; undefined when malformed. */
export function parseFilter(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z]+)\s*=\s*(\S+)$/);
    if (!m || !["repo", "branch", "adapter"].includes(m[1]!)) return undefined;
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** Where a dead delivery went, as words. */
export const deadTargetLabel = (t: DeliveryTarget): string =>
  t.kind === "link" ? `${t.adapter} ${t.externalId}` : t.kind === "workstream" ? `${t.repo}::${t.branch}` : t.kind;

const ID = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/** Why a Connect form cannot be saved, or undefined. Server and page run the same check. */
export function integrationProblem(i: { id?: string; kind?: string; name?: string; instance?: string; secretRef?: string }, kinds: string[], stripped: readonly string[]): string | undefined {
  if (!i.id || !ID.test(i.id)) return "id: use lower-case letters, digits, '-', '_' or '.'";
  if (!i.kind || !kinds.includes(i.kind)) return `kind: one of ${kinds.join(", ")}`;
  if (!i.name?.trim()) return "name is required";
  if (!i.instance?.trim()) return "instance is required";
  return secretRefRefusal(i.secretRef || undefined, stripped);
}

export function linkProblem(l: { id?: string; integrationId?: string; externalId?: string; level?: string; repos?: string[] }): string | undefined {
  if (!l.id || !ID.test(l.id)) return "id: use lower-case letters, digits, '-', '_' or '.'";
  if (!l.integrationId) return "integration is required";
  if (!l.externalId?.trim()) return "the external place is required";
  if (!["notify", "ask", "work"].includes(l.level ?? "")) return "level: notify, ask or work";
  if (l.level === "work" && !l.repos?.length) return "a work link needs at least one repo";
  return undefined;
}
