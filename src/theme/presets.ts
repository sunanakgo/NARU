import { hexToTriplet, mixTriplet, readableOn } from "@/lib/color";

/**
 * Theme presets (PLAN §7). Compact palettes sourced from popular editor themes
 * (Tokyo Night, Catppuccin, Dracula, One Dark, Nord, Gruvbox, Monokai, GitHub,
 * Rose Pine, Solarized, Ayu, Everforest, Kanagawa, Cursor, …). The full NARU
 * token set is derived from each palette at runtime by `buildTokens`.
 */
export interface Palette {
  neutral: string; // base background
  ink: string; // base foreground
  primary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  syntaxKeyword: string;
  syntaxComment: string;
}

export type ThemeMode = "dark" | "light";

export interface ThemePreset {
  id: string;
  name: string;
  dark?: Palette;
  light?: Palette;
}

/** Derive the full NARU CSS token map from a compact palette. */
export function buildTokens(
  p: Palette,
  mode: ThemeMode
): Record<string, string> {
  const dark = mode === "dark";
  const t = (hex: string) => hexToTriplet(hex);
  const m = (amt: number) => mixTriplet(p.neutral, p.ink, amt); // bg → fg
  const dim = (amt: number) => mixTriplet(p.ink, p.neutral, amt); // fg → bg

  return {
    "--background": t(p.neutral),
    "--foreground": t(p.ink),
    "--card": m(0.04),
    "--card-foreground": t(p.ink),
    "--popover": m(0.05),
    "--popover-foreground": t(p.ink),
    "--muted": m(0.1),
    "--muted-foreground": dim(0.42),
    "--accent": m(0.13),
    "--accent-foreground": t(p.ink),
    "--border": m(dark ? 0.13 : 0.16),
    "--input": m(dark ? 0.17 : 0.2),
    "--primary": t(p.primary),
    "--primary-foreground": readableOn(p.primary),
    "--ring": t(p.primary),

    "--titlebar": m(0.05),
    "--sidebar": m(0.03),
    "--pane-head": m(0.065),
    "--term-bg": t(p.neutral),
    "--term-fg": t(p.ink),
    "--desktop": mixTriplet(p.neutral, "#000000", 0.25),

    "--t-green": t(p.success),
    "--t-red": t(p.error),
    "--t-blue": t(p.primary),
    "--t-yellow": t(p.warning),
    "--t-cyan": t(p.info),
    "--t-mute": t(p.syntaxComment),

    "--ok": t(p.success),
    "--warn": t(p.warning),
    "--run": t(p.info),
    "--wait": t(p.primary),

    "--sidebar-foreground": `hsl(${dim(0.18)})`,
    "--sidebar-primary": `hsl(${t(p.primary)})`,
    "--sidebar-primary-foreground": `hsl(${readableOn(p.primary)})`,
    "--sidebar-accent": `hsl(${m(0.13)})`,
    "--sidebar-accent-foreground": `hsl(${t(p.ink)})`,
    "--sidebar-border": `hsl(${m(0.13)})`,
    "--sidebar-ring": `hsl(${t(p.primary)})`,
  };
}

export const PRESETS: ThemePreset[] = [
  {
    id: "naru",
    name: "NARU",
    dark: {
      neutral: "#0b0c12", ink: "#f2f2f5", primary: "#a78bfa", accent: "#f0a868",
      success: "#4ade80", warning: "#fbbf24", error: "#f87171", info: "#60a5fa",
      syntaxKeyword: "#c4b5fd", syntaxComment: "#6b7280",
    },
    light: {
      neutral: "#ffffff", ink: "#18181b", primary: "#7c3aed", accent: "#d97706",
      success: "#16a34a", warning: "#d97706", error: "#dc2626", info: "#2563eb",
      syntaxKeyword: "#9333ea", syntaxComment: "#6b7280",
    },
  },
  {
    id: "tokyonight", name: "Tokyo Night",
    dark: { neutral: "#1a1b26", ink: "#c0caf5", primary: "#7aa2f7", accent: "#ff9e64", success: "#9ece6a", warning: "#e0af68", error: "#f7768e", info: "#7dcfff", syntaxKeyword: "#bb9af7", syntaxComment: "#565f89" },
    light: { neutral: "#e1e2e7", ink: "#273153", primary: "#2e7de9", accent: "#b15c00", success: "#587539", warning: "#8c6c3e", error: "#c94060", info: "#007197", syntaxKeyword: "#9854f1", syntaxComment: "#6b6f7a" },
  },
  {
    id: "catppuccin", name: "Catppuccin",
    dark: { neutral: "#1e1e2e", ink: "#cdd6f4", primary: "#b4befe", accent: "#f38ba8", success: "#a6d189", warning: "#f4b8e4", error: "#f38ba8", info: "#89dceb", syntaxKeyword: "#cba6f7", syntaxComment: "#6c7086" },
    light: { neutral: "#f5e0dc", ink: "#4c4f69", primary: "#7287fd", accent: "#d20f39", success: "#40a02b", warning: "#df8e1d", error: "#d20f39", info: "#04a5e5", syntaxKeyword: "#8839ef", syntaxComment: "#6c7086" },
  },
  {
    id: "dracula", name: "Dracula",
    dark: { neutral: "#1d1e28", ink: "#f8f8f2", primary: "#bd93f9", accent: "#ff79c6", success: "#50fa7b", warning: "#ffb86c", error: "#ff5555", info: "#8be9fd", syntaxKeyword: "#ff79c6", syntaxComment: "#6272a4" },
    light: { neutral: "#f8f8f2", ink: "#1f1f2f", primary: "#7c6bf5", accent: "#d16090", success: "#2fbf71", warning: "#f7a14d", error: "#d9536f", info: "#1d7fc5", syntaxKeyword: "#d16090", syntaxComment: "#7d7f97" },
  },
  {
    id: "one-dark", name: "One Dark",
    dark: { neutral: "#282c34", ink: "#abb2bf", primary: "#61afef", accent: "#56b6c2", success: "#98c379", warning: "#e5c07b", error: "#e06c75", info: "#d19a66", syntaxKeyword: "#c678dd", syntaxComment: "#5c6370" },
    light: { neutral: "#fafafa", ink: "#383a42", primary: "#4078f2", accent: "#0184bc", success: "#50a14f", warning: "#c18401", error: "#e45649", info: "#986801", syntaxKeyword: "#a626a4", syntaxComment: "#a0a1a7" },
  },
  {
    id: "nord", name: "Nord",
    dark: { neutral: "#2e3440", ink: "#e5e9f0", primary: "#88c0d0", accent: "#d57780", success: "#a3be8c", warning: "#d08770", error: "#bf616a", info: "#81a1c1", syntaxKeyword: "#81a1c1", syntaxComment: "#616e88" },
    light: { neutral: "#eceff4", ink: "#2e3440", primary: "#5e81ac", accent: "#bf616a", success: "#8fbcbb", warning: "#d08770", error: "#bf616a", info: "#81a1c1", syntaxKeyword: "#5e81ac", syntaxComment: "#6b7282" },
  },
  {
    id: "gruvbox", name: "Gruvbox",
    dark: { neutral: "#282828", ink: "#ebdbb2", primary: "#83a598", accent: "#fb4934", success: "#b8bb26", warning: "#fabd2f", error: "#fb4934", info: "#d3869b", syntaxKeyword: "#fb4934", syntaxComment: "#928374" },
    light: { neutral: "#fbf1c7", ink: "#3c3836", primary: "#076678", accent: "#9d0006", success: "#79740e", warning: "#b57614", error: "#9d0006", info: "#8f3f71", syntaxKeyword: "#9d0006", syntaxComment: "#928374" },
  },
  {
    id: "monokai", name: "Monokai",
    dark: { neutral: "#272822", ink: "#f8f8f2", primary: "#ae81ff", accent: "#f92672", success: "#a6e22e", warning: "#fd971f", error: "#f92672", info: "#66d9ef", syntaxKeyword: "#f92672", syntaxComment: "#75715e" },
    light: { neutral: "#fdf8ec", ink: "#292318", primary: "#bf7bff", accent: "#d9487c", success: "#4fb54b", warning: "#f1a948", error: "#e54b4b", info: "#2d9ad7", syntaxKeyword: "#d9487c", syntaxComment: "#8a816f" },
  },
  {
    id: "github", name: "GitHub",
    dark: { neutral: "#0d1117", ink: "#c9d1d9", primary: "#58a6ff", accent: "#39c5cf", success: "#3fb950", warning: "#e3b341", error: "#f85149", info: "#d29922", syntaxKeyword: "#ff7b72", syntaxComment: "#8b949e" },
    light: { neutral: "#ffffff", ink: "#24292f", primary: "#0969da", accent: "#1b7c83", success: "#1a7f37", warning: "#9a6700", error: "#cf222e", info: "#bc4c00", syntaxKeyword: "#cf222e", syntaxComment: "#57606a" },
  },
  {
    id: "rosepine", name: "Rose Pine",
    dark: { neutral: "#191724", ink: "#e0def4", primary: "#9ccfd8", accent: "#ebbcba", success: "#31748f", warning: "#f6c177", error: "#eb6f92", info: "#9ccfd8", syntaxKeyword: "#31748f", syntaxComment: "#6e6a86" },
    light: { neutral: "#faf4ed", ink: "#575279", primary: "#31748f", accent: "#d7827e", success: "#286983", warning: "#ea9d34", error: "#b4637a", info: "#56949f", syntaxKeyword: "#286983", syntaxComment: "#9893a5" },
  },
  {
    id: "solarized", name: "Solarized",
    dark: { neutral: "#002b36", ink: "#93a1a1", primary: "#6c71c4", accent: "#d33682", success: "#859900", warning: "#b58900", error: "#dc322f", info: "#2aa198", syntaxKeyword: "#859900", syntaxComment: "#586e75" },
    light: { neutral: "#fdf6e3", ink: "#586e75", primary: "#268bd2", accent: "#d33682", success: "#859900", warning: "#b58900", error: "#dc322f", info: "#2aa198", syntaxKeyword: "#728600", syntaxComment: "#657b83" },
  },
  {
    id: "ayu", name: "Ayu",
    dark: { neutral: "#0f1419", ink: "#d6dae0", primary: "#3fb7e3", accent: "#f2856f", success: "#78d05c", warning: "#e4a75c", error: "#f58572", info: "#66c6f1", syntaxKeyword: "#ff8f40", syntaxComment: "#5a6673" },
    light: { neutral: "#fdfaf4", ink: "#4f5964", primary: "#4aa8c8", accent: "#ef7d71", success: "#5fb978", warning: "#ea9f41", error: "#e6656a", info: "#2f9bce", syntaxKeyword: "#c76a1a", syntaxComment: "#6e7681" },
  },
  {
    id: "everforest", name: "Everforest",
    dark: { neutral: "#2d353b", ink: "#d3c6aa", primary: "#a7c080", accent: "#d699b6", success: "#a7c080", warning: "#e69875", error: "#e67e80", info: "#83c092", syntaxKeyword: "#d699b6", syntaxComment: "#7a8478" },
    light: { neutral: "#fdf6e3", ink: "#5c6a72", primary: "#8da101", accent: "#df69ba", success: "#8da101", warning: "#f57d26", error: "#f85552", info: "#35a77c", syntaxKeyword: "#df69ba", syntaxComment: "#a6b0a0" },
  },
  {
    id: "kanagawa", name: "Kanagawa",
    dark: { neutral: "#1f1f28", ink: "#dcd7ba", primary: "#7e9cd8", accent: "#d27e99", success: "#98bb6c", warning: "#d7a657", error: "#e82424", info: "#76946a", syntaxKeyword: "#957fb8", syntaxComment: "#727169" },
    light: { neutral: "#f2e9de", ink: "#54433a", primary: "#2d4f67", accent: "#d27e99", success: "#98bb6c", warning: "#d7a657", error: "#e82424", info: "#76946a", syntaxKeyword: "#957fb8", syntaxComment: "#9e9389" },
  },
  {
    id: "cursor", name: "Cursor",
    dark: { neutral: "#181818", ink: "#e4e4e4", primary: "#88c0d0", accent: "#88c0d0", success: "#3fa266", warning: "#f1b467", error: "#e34671", info: "#81a1c1", syntaxKeyword: "#82d2ce", syntaxComment: "#8a8a8a" },
    light: { neutral: "#fcfcfc", ink: "#141414", primary: "#6f9ba6", accent: "#6f9ba6", success: "#1f8a65", warning: "#db704b", error: "#cf2d56", info: "#3c7cab", syntaxKeyword: "#b3003f", syntaxComment: "#6e6e6e" },
  },
  {
    id: "vesper", name: "Vesper",
    dark: { neutral: "#101010", ink: "#ffffff", primary: "#ffc799", accent: "#ff8080", success: "#99ffe4", warning: "#ffc799", error: "#ff8080", info: "#ffc799", syntaxKeyword: "#a0a0a0", syntaxComment: "#8b8b8b" },
    light: { neutral: "#f0f0f0", ink: "#101010", primary: "#c2410c", accent: "#b30000", success: "#0f766e", warning: "#b45309", error: "#b30000", info: "#b45309", syntaxKeyword: "#6e6e6e", syntaxComment: "#7a7a7a" },
  },
  {
    id: "vercel", name: "Vercel",
    dark: { neutral: "#000000", ink: "#ededed", primary: "#0070f3", accent: "#8e4ec6", success: "#46a758", warning: "#ffb224", error: "#e5484d", info: "#52a8ff", syntaxKeyword: "#f75590", syntaxComment: "#878787" },
    light: { neutral: "#ffffff", ink: "#171717", primary: "#0070f3", accent: "#8e4ec6", success: "#388e3c", warning: "#ff9500", error: "#dc3545", info: "#0070f3", syntaxKeyword: "#e93d82", syntaxComment: "#888888" },
  },
];

export function getPreset(id: string): ThemePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
