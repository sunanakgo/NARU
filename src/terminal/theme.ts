import type { ITheme } from "@xterm/xterm";

/*
 * Terminal palette built from the live CSS variables (PLAN §7). It reads the
 * `--term-*` / `--t-*` tokens so the terminal automatically follows the active
 * UI theme (dark/light, and future custom themes) while staying a SEPARATE
 * palette from the muted UI chrome.
 */
function readVar(name: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  // xterm's color parser only understands #hex / rgb() — `hsl(...)` strings
  // are silently DROPPED (the terminal then runs on its default palette).
  // Resolve through the browser so every theme color actually lands.
  const probe = document.createElement("span");
  probe.style.color = `hsl(${v})`;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb || "#000000";
}

/** Resolve a theme token (e.g. "--t-yellow") to a concrete rgb() string —
 * for consumers that can't read CSS vars (xterm search decorations). */
export function resolveThemeColor(name: string): string {
  return readVar(name);
}

export function buildTerminalTheme(): ITheme {
  return {
    background: readVar("--term-bg"),
    foreground: readVar("--term-fg"),
    cursor: readVar("--term-fg"),
    cursorAccent: readVar("--term-bg"),
    selectionBackground: readVar("--primary"),

    black: readVar("--term-bg"),
    red: readVar("--t-red"),
    green: readVar("--t-green"),
    yellow: readVar("--t-yellow"),
    blue: readVar("--t-blue"),
    magenta: readVar("--primary"),
    cyan: readVar("--t-cyan"),
    white: readVar("--term-fg"),

    brightBlack: readVar("--t-mute"),
    brightRed: readVar("--t-red"),
    brightGreen: readVar("--t-green"),
    brightYellow: readVar("--t-yellow"),
    brightBlue: readVar("--t-blue"),
    brightMagenta: readVar("--primary"),
    brightCyan: readVar("--t-cyan"),
    brightWhite: readVar("--foreground"),
  };
}
