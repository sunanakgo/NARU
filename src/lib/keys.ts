/** Keyboard combo helpers for the keybinding system (PLAN §5). */

/** Serialize a KeyboardEvent to a normalized combo string ("mod+shift+t"). */
export function eventToCombo(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return null; // modifier pressed alone
  }
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  let k = key.toLowerCase();
  if (k === " ") k = "space";
  parts.push(k);
  return parts.join("+");
}

const isMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** Human-readable combo, e.g. "mod+shift+t" → "⌘⇧T" / "Ctrl+Shift+T". */
export function comboLabel(combo: string): string {
  return combo
    .split("+")
    .map((p) => {
      switch (p) {
        case "mod":
          return isMac ? "⌘" : "Ctrl";
        case "shift":
          return isMac ? "⇧" : "Shift";
        case "alt":
          return isMac ? "⌥" : "Alt";
        case "space":
          return "Space";
        case "tab":
          return "Tab";
        case "arrowleft":
          return "←";
        case "arrowright":
          return "→";
        case "arrowup":
          return "↑";
        case "arrowdown":
          return "↓";
        default:
          return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
      }
    })
    .join(isMac ? "" : "+");
}
