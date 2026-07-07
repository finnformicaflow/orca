import { atom, useAtom } from "jotai";

// Theme preference: an explicit light/dark override, or "system" to follow the OS. Persisted in
// localStorage and applied by toggling the `.dark` class on <html> (see styles.css `.dark { … }`).
export type Theme = "light" | "dark" | "system";
const KEY = "orca.theme";

const read = (): Theme => (localStorage.getItem(KEY) as Theme) || "system";
const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)");

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && prefersDark().matches);
  document.documentElement.classList.toggle("dark", dark);
}

const themeAtom = atom<Theme>(read());

// Apply at module load (before React paints, so no flash of the wrong theme), and keep "system"
// in sync when the OS preference flips.
apply(read());
prefersDark().addEventListener("change", () => { if (read() === "system") apply(read()); });

export function useTheme() {
  const [theme, set] = useAtom(themeAtom);
  const setTheme = (t: Theme) => { localStorage.setItem(KEY, t); apply(t); set(t); };
  return [theme, setTheme] as const;
}
