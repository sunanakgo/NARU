import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

/** User-tunable settings (PLAN §7 — Warp-inspired customization surface). */
export type CursorStyle = "bar" | "block" | "underline";
export type AgentCli = "claude" | "codex" | "opencode";

interface SettingsState {
  /** App/UI font family. */
  uiFont: string;
  /** Terminal (monospace) font family. */
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  /** Warp-style command input bar under the grid (replaces the shell prompt). */
  inputBar: boolean;
  /** Which agent CLI the input bar's launch button runs. */
  agentCli: AgentCli;
  /** Default app of the titlebar "open folder in…" split button. */
  openInApp: "explorer" | "vscode" | "terminal" | "gitbash";
  notificationsEnabled: boolean;
  notifyWaiting: boolean;
  notifyError: boolean;
  notifyDone: boolean;
  notifySound: boolean;
  windowBlur: boolean;
  set: (patch: Partial<SettingsState>) => void;
}

// Korean fallbacks matter: the Latin coding fonts have no Hangul glyphs, so
// without an explicit CJK monospace the browser picks a random system font per
// glyph — and at proportional width inside xterm's reserved 2-cell slots that
// leaves a gap after every Hangul character. "Nanum Gothic Coding" is bundled
// (self-hosted, see main.tsx) and draws Hangul at exactly 2 cells, so it must
// come first among the CJK fonts — it's the only one guaranteed present on
// macOS. D2Coding / Malgun Gothic stay as native fallbacks for users who have
// them (e.g. Windows). Latin stays JetBrains Mono (it owns those glyphs).
const FONT_STACK_V3 =
  '"JetBrains Mono", ui-monospace, "Cascadia Code", Menlo, Consolas, "D2Coding", "Malgun Gothic", monospace';

export const DEFAULT_FONT =
  '"JetBrains Mono", "Nanum Gothic Coding", ui-monospace, "Cascadia Code", Menlo, Consolas, "D2Coding", "Malgun Gothic", monospace';

export const DEFAULT_UI_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", sans-serif';

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      uiFont: "",
      fontFamily: DEFAULT_FONT,
      fontSize: 15,
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: 10_000,
      inputBar: true,
      agentCli: "claude",
      openInApp: "explorer",
      notificationsEnabled: true,
      notifyWaiting: true,
      notifyError: true,
      notifyDone: true,
      notifySound: false,
      windowBlur: false,
      set: (patch) => set(patch),
    }),
    {
      name: "naru-settings",
      storage: createJSONStorage(() => kvStorage),
      version: 4,
      // Stored values that still equal an OLD default follow the new default.
      // v0 → v1: terminal font stack gained Korean fallbacks.
      // v1 → v2: default font size 13 → 15.
      // v2 → v3: done notifications default ON (agent answer-complete alerts
      //          only became detectable now, so a stored `false` is the old
      //          default, not a user choice).
      // v3 → v4: font stack gained the self-hosted "Nanum Gothic Coding" so
      //          Hangul renders at the right width on macOS (no system Korean
      //          monospace existed there).
      migrate: (state, version) => {
        const s = state as Partial<SettingsState>;
        if (
          version < 1 &&
          s.fontFamily ===
            '"JetBrains Mono", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace'
        ) {
          s.fontFamily = DEFAULT_FONT;
        }
        if (version < 2 && s.fontSize === 13) {
          s.fontSize = 15;
        }
        if (version < 3 && s.notifyDone === false) {
          s.notifyDone = true;
        }
        if (version < 4 && s.fontFamily === FONT_STACK_V3) {
          s.fontFamily = DEFAULT_FONT;
        }
        return s as SettingsState;
      },
    }
  )
);
