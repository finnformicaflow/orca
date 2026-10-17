// Minimal path-based routing — no router dependency. The URL is the source of truth. Both
// the Bun server and Vite dev do SPA fallback, so these paths serve index.html.
import { useSyncExternalStore } from "react";

export type PrTab = "overview" | "chat" | "files" | "checks" | "preview";
export type LocalTab = "overview" | "chat" | "files" | "preview";
/** The console's top-level pages, in the sidebar's order. "board" is the Overview at "/". */
export const PAGES = ["agents", "previews", "repos", "github", "usage", "settings"] as const;
export type Page = (typeof PAGES)[number];
export type Route =
  | { name: "board" }
  | { name: Page }
  | { name: "orchestrator" }
  | { name: "integrations" }
  | { name: "pr"; repo: string; number: number; sub: PrTab }
  | { name: "local"; repo: string; branch: string; sub: LocalTab };

function parse(): Route {
  // overview at "/"; the console pages at /agents, /repos, /usage, /settings; the orchestrator's own
  // routed page (narrow screens) at /orchestrator; PR detail at /{repo}/prs/{n}[/files|/checks];
  // local-session detail at /{repo}/local/{branch}[/files|/preview] (branch is URI-encoded — may contain "/")
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[1] === "prs" && parts[2]) {
    return { name: "pr", repo: parts[0]!, number: Number(parts[2]), sub: (parts[3] as PrTab) ?? "overview" };
  }
  if (parts[1] === "local" && parts[2]) {
    return { name: "local", repo: parts[0]!, branch: decodeURIComponent(parts[2]), sub: (parts[3] as LocalTab) ?? "overview" };
  }
  if (parts[0] === "orchestrator" && parts.length === 1) return { name: "orchestrator" };
  if (parts[0] === "settings" && parts[1] === "integrations" && parts.length === 2) return { name: "integrations" };
  if ((PAGES as readonly string[]).includes(parts[0] ?? "") && parts.length === 1) return { name: parts[0] as Page };
  return { name: "board" };
}

const listeners = new Set<() => void>();
let current: Route = parse(); // cached so getSnapshot returns a stable reference
const update = () => { current = parse(); listeners.forEach((l) => l()); };
window.addEventListener("popstate", update);

export function navigate(path: string, replace = false) {
  if (location.pathname + location.search === path) return; // the query counts: /agents?status=running ≠ /agents
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  update();
}

export const useRoute = (): Route =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);

/** The URL's query string ("?status=attention…"), re-read on every navigation — the Agents page's
 *  quick filters live here so a filtered view is a link. */
export const useSearch = (): string =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => location.search);
