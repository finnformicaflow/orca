// Minimal path-based routing — no router dependency. The URL is the source of truth. Both
// the Bun server and Vite dev do SPA fallback, so these paths serve index.html.
import { useSyncExternalStore } from "react";

export type PrTab = "overview" | "files" | "checks";
export type Route = { name: "board" } | { name: "pr"; number: number; sub: PrTab };

function parse(): Route {
  const m = location.pathname.match(/^\/prs\/(\d+)(?:\/(files|checks))?$/);
  if (m) return { name: "pr", number: Number(m[1]), sub: (m[2] as PrTab) ?? "overview" };
  return { name: "board" };
}

const listeners = new Set<() => void>();
let current: Route = parse(); // cached so getSnapshot returns a stable reference
const update = () => { current = parse(); listeners.forEach((l) => l()); };
window.addEventListener("popstate", update);

export function navigate(path: string) {
  if (location.pathname === path) return;
  history.pushState(null, "", path);
  update();
}

export const useRoute = (): Route =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
