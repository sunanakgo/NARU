import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";
import { IS_MAC } from "@/lib/platform";

/** Bindable actions (PLAN §5 — keybinding customization). */
export interface ActionDef {
  id: string;
  label: string;
  default: string; // combo string (see lib/keys)
}

// macOS reserves Cmd+Tab / Cmd+Shift+Tab for the OS app-switcher, so those
// chords never reach the webview — session cycling would be dead on Mac. The
// combo system folds Ctrl and Cmd into "mod" (see lib/keys), so Ctrl+Tab can't
// be expressed distinctly either; use Cmd+Opt+Arrow on Mac (Safari-style tab
// nav) and keep the familiar Ctrl+Tab chords on Windows/Linux.
const NEXT_SESSION_DEFAULT = IS_MAC ? "mod+alt+arrowright" : "mod+tab";
const PREV_SESSION_DEFAULT = IS_MAC ? "mod+alt+arrowleft" : "mod+shift+tab";

export const ACTIONS: ActionDef[] = [
  { id: "commandPalette", label: "커맨드 팔레트", default: "mod+k" },
  { id: "globalSearch", label: "전체 검색 (모든 세션)", default: "mod+shift+f" },
  { id: "newSession", label: "새 세션", default: "mod+shift+t" },
  { id: "newTerminal", label: "새 터미널 탭", default: "mod+t" },
  { id: "newBrowser", label: "새 브라우저 탭", default: "mod+shift+b" },
  { id: "splitRight", label: "오른쪽으로 분할", default: "mod+shift+d" },
  { id: "splitDown", label: "아래로 분할", default: "mod+shift+e" },
  { id: "closePane", label: "페인 닫기", default: "mod+shift+w" },
  { id: "toggleSidebar", label: "사이드바 접기/펼치기", default: "mod+b" },
  { id: "openSettings", label: "설정 열기", default: "mod+," },
  { id: "nextSession", label: "다음 세션", default: NEXT_SESSION_DEFAULT },
  { id: "prevSession", label: "이전 세션", default: PREV_SESSION_DEFAULT },
];

const defaults = (): Record<string, string> =>
  Object.fromEntries(ACTIONS.map((a) => [a.id, a.default]));

interface KeymapState {
  bindings: Record<string, string>;
  /** Action id currently being rebound (dispatcher pauses while set). */
  recording: string | null;
  setBinding: (id: string, combo: string) => void;
  setRecording: (id: string | null) => void;
  reset: () => void;
}

export const useKeymap = create<KeymapState>()(
  persist(
    (set) => ({
      bindings: defaults(),
      recording: null,
      setBinding: (id, combo) =>
        set((s) => {
          // Enforce combo uniqueness: if another action already owns this
          // combo, clear it (swap-style) so two actions can never share one
          // chord — the displaced action shows as unbound in the UI.
          const bindings = { ...s.bindings, [id]: combo };
          for (const k of Object.keys(bindings)) {
            if (k !== id && bindings[k] === combo) bindings[k] = "";
          }
          return { bindings };
        }),
      setRecording: (recording) => set({ recording }),
      reset: () => set({ bindings: defaults() }),
    }),
    {
      name: "naru-keymap",
      storage: createJSONStorage(() => kvStorage),
      partialize: (s) => ({ bindings: s.bindings }),
      // Merge in any actions added since the saved version.
      merge: (persisted, current) => {
        const p = persisted as Partial<KeymapState> | undefined;
        const bindings = { ...defaults(), ...(p?.bindings ?? {}) };
        // One-time migration: a Mac profile saved before the Cmd+Tab fix still
        // carries the OS-swallowed chords (dead on macOS). Rewrite ONLY those
        // exact stale values to the working Mac defaults — any real user
        // customization is left untouched.
        if (IS_MAC) {
          if (bindings.nextSession === "mod+tab")
            bindings.nextSession = NEXT_SESSION_DEFAULT;
          if (bindings.prevSession === "mod+shift+tab")
            bindings.prevSession = PREV_SESSION_DEFAULT;
        }
        return { ...current, bindings };
      },
    }
  )
);
