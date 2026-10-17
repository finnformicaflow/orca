// The console's keyboard shortcuts: one table, one matcher (pure, so it's tested without a DOM),
// one listener (components/Shortcuts.tsx). The table also feeds the ? help sheet, the palette's
// hints and the tooltips, so a key can't be documented in one place and bound to another.
//
// Letters (A, C, F, N, O, G chords, ?) and ⌘B never fire while you type in a field or inside a modal dialog —
// they would eat a keystroke of the message. ⌘K and Esc work everywhere.
//
// Why O for the orchestrator, not ⌘J: ⌘J / Ctrl+J is the browser's Downloads in Chrome on Windows
// and Linux and in Firefox, and ⌘-chords are what a composer's text editing reaches for. A plain
// letter sits with C (new agent) and F (find), can't clash with any browser binding, and from inside
// a text field ⌘K → "Open orchestrator" is one more key.
//
// G then a letter goes to a page (Linear's / GitHub's chords): G arms a short pending state in the
// listener, and the next key is read ONLY as a page — G O is Overview, never the orchestrator.
export type ShortcutId = "palette" | "sidebar" | "new" | "orchestrator" | "quickAsk" | "find" | "notifications" | "help" | "escape" | "send"
  | "goOverview" | "goAgents" | "goPreviews" | "goRepos" | "goGithub" | "goHandoffs" | "goUsage" | "goSettings";
/** What a keydown can be: a shortcut, or "go" — the G that arms a page chord. */
export type ShortcutMatch = ShortcutId | "go";

export type KeyLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export type Shortcut = {
  id: ShortcutId; label: string; mod?: true; key: string;
  /** A two-key chord's first key (G), pressed and released before `key`. */
  chord?: "G";
  /** A page chord's destination. */
  to?: string;
  group?: "Navigation";
};

/** How long after G the next key still counts as the chord's second key. */
export const CHORD_TIMEOUT_MS = 1000;

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", label: "Command palette", mod: true, key: "K" },
  { id: "new", label: "New agent", key: "C" },
  { id: "orchestrator", label: "Ask the orchestrator", key: "O" },
  { id: "quickAsk", label: "Quick ask (one message, no history)", key: "A" },
  { id: "find", label: "Find agents", key: "F" },
  { id: "notifications", label: "Notifications", key: "N" },
  { id: "sidebar", label: "Collapse / expand the sidebar", mod: true, key: "B" },
  { id: "help", label: "Keyboard shortcuts", key: "?" },
  { id: "escape", label: "Close the open overlay", key: "Esc" },
  // Not a global binding (matchShortcut never returns it): the composers' own key, listed so its hint
  // and the ? sheet come from this table like every other.
  { id: "send", label: "Send a message (Shift+Enter for a new line)", key: "Enter" },
  { id: "goOverview", label: "Go to Overview", chord: "G", key: "O", to: "/", group: "Navigation" },
  { id: "goAgents", label: "Go to Agents", chord: "G", key: "A", to: "/agents", group: "Navigation" },
  { id: "goPreviews", label: "Go to Previews", chord: "G", key: "P", to: "/previews", group: "Navigation" },
  { id: "goRepos", label: "Go to Repos", chord: "G", key: "R", to: "/repos", group: "Navigation" },
  { id: "goGithub", label: "Go to GitHub", chord: "G", key: "H", to: "/github", group: "Navigation" },
  { id: "goHandoffs", label: "Go to Handoffs", chord: "G", key: "K", to: "/handoffs", group: "Navigation" },
  { id: "goUsage", label: "Go to Usage", chord: "G", key: "U", to: "/usage", group: "Navigation" },
  { id: "goSettings", label: "Go to Settings", chord: "G", key: "S", to: "/settings", group: "Navigation" },
];

/** The page chord that goes to `to`, if there is one (the sidebar's and the palette's hints). */
export const pageShortcut = (to: string): ShortcutId | undefined => SHORTCUTS.find((s) => s.to === to)?.id;

export const isMacPlatform = (nav: { platform?: string; userAgent?: string } = typeof navigator === "undefined" ? {} : navigator): boolean =>
  /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent || "");

/** How a shortcut is written for this platform: "⌘K" on a Mac, "Ctrl+K" elsewhere, "C" for a letter,
 *  "G then O" for a chord. */
export function shortcutLabel(id: ShortcutId, mac = isMacPlatform()): string {
  const s = SHORTCUTS.find((x) => x.id === id)!;
  if (s.chord) return `${s.chord} then ${s.key}`;
  return s.mod ? (mac ? `⌘${s.key}` : `Ctrl+${s.key}`) : s.key;
}

/** The same shortcut as separate keycaps, for <Shortcut> (components/ui/kbd): ["⌘", "K"] on a Mac,
 *  ["Ctrl", "K"] elsewhere, ["C"] for a letter, ["G", "O"] for a chord. */
export function shortcutKeys(id: ShortcutId, mac = isMacPlatform()): string[] {
  const s = SHORTCUTS.find((x) => x.id === id)!;
  if (s.chord) return [s.chord, s.key];
  return s.mod ? [mac ? "⌘" : "Ctrl", s.key] : [s.key];
}

/** Is focus somewhere a keystroke is text: a field, an editable region, or a modal dialog's contents. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target && typeof (target as Element).closest === "function" ? (target as Element) : null;
  return !!el?.closest("input, textarea, select, [contenteditable=''], [contenteditable=true], dialog");
}

/** The text field an Esc nothing else wanted should blur: an input you type into, a textarea or an
 *  editable region — not a checkbox or a select — and never one inside a native <dialog>, whose Esc
 *  closes the dialog (and returns focus) itself. Null when Esc has no field to leave. */
export function escapeBlurTarget(target: EventTarget | null): HTMLElement | null {
  const el = target && typeof (target as Element).closest === "function" ? (target as HTMLElement) : null;
  if (!el || el.closest("dialog")) return null;
  const tag = el.tagName;
  const text = tag === "TEXTAREA" || el.isContentEditable || el.getAttribute?.("contenteditable") === "true" || el.getAttribute?.("contenteditable") === ""
    || (tag === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|range|color|image|hidden)$/i.test((el as HTMLInputElement).type));
  return text ? el : null;
}

/** Which shortcut a keydown is, or null. `typing` = the target is a text field (isTypingTarget).
 *  `pendingG` = a G was pressed within CHORD_TIMEOUT_MS: a bare letter is then a page chord or
 *  nothing — never also the single-letter shortcut (G O is Overview, not the orchestrator). */
export function matchShortcut(e: KeyLike, typing: boolean, mac = isMacPlatform(), pendingG = false): ShortcutMatch | null {
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;
  const otherMod = mac ? !!e.ctrlKey : !!e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "Escape") return "escape";
  if (mod && !otherMod && !e.altKey && !e.shiftKey && key === "k") return "palette";
  if (typing) return null;
  if (mod && !otherMod && !e.altKey && !e.shiftKey && key === "b") return "sidebar";
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (key === "?") return "help";
  if (e.shiftKey) return null;
  if (pendingG) return SHORTCUTS.find((s) => s.chord === "G" && s.key.toLowerCase() === key)?.id ?? null;
  if (key === "g") return "go";
  return key === "c" ? "new" : key === "o" ? "orchestrator" : key === "a" ? "quickAsk" : key === "f" ? "find" : key === "n" ? "notifications" : null;
}
