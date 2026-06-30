import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

import { buildTokens, getPreset, type ThemeMode } from "@/theme/presets";

/**
 * UI theme (PLAN §7). A theme = a preset (Tokyo Night, Dracula, …) + a color
 * mode. `mode` is the user's preference (system/light/dark); `theme` is the
 * resolved appearance (dark|light) that the rest of the app consumes. Applying
 * injects the derived NARU token set as inline CSS vars on <html>.
 */
export type ColorMode = "system" | "light" | "dark";

interface ThemeState {
  mode: ColorMode;
  /** Resolved appearance — what components actually render against. */
  theme: ThemeMode;
  presetId: string;
  setMode: (mode: ColorMode) => void;
  toggle: () => void;
  setPreset: (presetId: string) => void;
}

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function resolve(mode: ColorMode): ThemeMode {
  return mode === "system" ? (systemDark() ? "dark" : "light") : mode;
}

function apply(presetId: string, theme: ThemeMode) {
  const preset = getPreset(presetId);
  const palette = preset[theme] ?? preset.dark ?? preset.light;
  if (!palette) return;
  const effective: ThemeMode = preset[theme] ? theme : preset.dark ? "dark" : "light";
  const tokens = buildTokens(palette, effective);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  root.dataset.theme = effective;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: "dark",
      theme: "dark",
      presetId: "naru",
      setMode: (mode) => {
        const theme = resolve(mode);
        apply(get().presetId, theme);
        set({ mode, theme });
      },
      toggle: () => {
        const theme = get().theme === "dark" ? "light" : "dark";
        apply(get().presetId, theme);
        set({ mode: theme, theme });
      },
      setPreset: (presetId) => {
        apply(presetId, get().theme);
        set({ presetId });
      },
    }),
    {
      name: "naru-theme-v3",
      storage: createJSONStorage(() => kvStorage),
      partialize: (s) => ({ mode: s.mode, presetId: s.presetId }),
    }
  )
);

// Module-scope guard so HMR / repeated module eval doesn't stack matchMedia
// listeners (each stale registration would keep firing forever).
let mediaListenerRegistered = false;

// Resolve + apply on load (the kv cache rehydrates synchronously — filled by
// preloadKvStorage before this module evaluates), and react to OS theme
// changes while in "system" mode.
{
  const { mode, presetId } = useTheme.getState();
  // Validate the persisted preset id — if it's unknown/stale (schema drift,
  // a removed preset), getPreset returns the default; persist that back so the
  // rest of the app sees a known id.
  const validPresetId = getPreset(presetId).id;
  if (validPresetId !== presetId) {
    useTheme.setState({ presetId: validPresetId });
  }
  const theme = resolve(mode);
  useTheme.setState({ theme });
  apply(validPresetId, theme);

  if (typeof window !== "undefined" && !mediaListenerRegistered) {
    mediaListenerRegistered = true;
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        const s = useTheme.getState();
        if (s.mode === "system") {
          const t = resolve("system");
          apply(s.presetId, t);
          useTheme.setState({ theme: t });
        }
      });
  }
}
