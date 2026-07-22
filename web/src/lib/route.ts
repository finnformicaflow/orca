// Minimal path-based routing — no router dependency. The URL is the source of truth. Both
// the Bun server and Vite dev do SPA fallback, so these paths serve index.html.
import { useSyncExternalStore } from "react";

export type PrTab = "overview" | "chat" | "files" | "checks" | "preview";
export type LocalTab = "overview" | "chat" | "files" | "preview";
export type Route =
  | { name: "board" }
  | { name: "pr"; repo: string; number: number; sub: PrTab }
  | { name: "local"; repo: string; branch: string; sub: LocalTab };

function parse(): Route {
  // board at "/" (all repos); PR detail at /{repo}/prs/{n}[/files|/checks];
  // local-session detail at /{repo}/local/{branch}[/files|/preview] (branch is URI-encoded — may contain "/")
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[1] === "prs" && parts[2]) {
    return { name: "pr", repo: parts[0]!, number: Number(parts[2]), sub: (parts[3] as PrTab) ?? "overview" };
  }
  if (parts[1] === "local" && parts[2]) {
    return { name: "local", repo: parts[0]!, branch: decodeURIComponent(parts[2]), sub: (parts[3] as LocalTab) ?? "overview" };
  }
  return { name: "board" };
}

const listeners = new Set<() => void>();
let current: Route = parse(); // cached so getSnapshot returns a stable reference
const update = () => { current = parse(); listeners.forEach((l) => l()); };
window.addEventListener("popstate", update);

export function navigate(path: string, replace = false) {
  if (location.pathname === path) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  update();
}

export const useRoute = (): Route =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
