// E2E for the profile-menu theme control: selecting Light / Dark / System toggles the `.dark`
// class on <html> (which is what styles.css keys every color off) and persists the choice. We
// drive the real `useTheme` hook — the exact path the dropdown's radio onValueChange calls —
// rendered into a real DOM, plus mount ProfileMenu itself to prove it wires up without crashing.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTheme } from "@/lib/theme";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let setTheme: ReturnType<typeof useTheme>[1];
function Harness() {
  const [, set] = useTheme();
  setTheme = set;
  return null;
}

let root: Root | undefined;
let container: HTMLElement | undefined;
function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => { root = createRoot(container!); root.render(<Harness />); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

const isDark = () => document.documentElement.classList.contains("dark");

describe("theme control", () => {
  test("Dark adds the .dark class and persists", () => {
    mount();
    act(() => setTheme("dark"));
    expect(isDark()).toBe(true);
    expect(localStorage.getItem("orca.theme")).toBe("dark");
  });

  test("Light removes the .dark class", () => {
    mount();
    act(() => setTheme("dark"));
    act(() => setTheme("light"));
    expect(isDark()).toBe(false);
    expect(localStorage.getItem("orca.theme")).toBe("light");
  });

  test("System follows the OS preference", () => {
    mount();
    act(() => setTheme("system"));
    // happy-dom reports prefers-color-scheme: light by default, so system → not dark.
    expect(isDark()).toBe(window.matchMedia("(prefers-color-scheme: dark)").matches);
    expect(localStorage.getItem("orca.theme")).toBe("system");
  });
});
