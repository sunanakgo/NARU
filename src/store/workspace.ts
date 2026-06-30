import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";
import { useStatusStore } from "@/store/status";

/**
 * Workspace state (PLAN §5/§6 — `src/store`).
 *
 * Each sidebar entry is a "session" (Tab). The in-session pane layout is owned
 * by a dockview instance (tabs, groups, splits, drag-docking). We keep a
 * serialized dockview layout for persistence plus the flat list of panel ids
 * so the sidebar/titlebar can roll up agent statuses without parsing the
 * layout. A panel id doubles as the PTY session id for terminal panels.
 */

export type PaneKind = "terminal" | "browser" | "procmon" | "runbook" | "replay";

export interface Tab {
  id: string;
  title: string;
  /** Stable sidebar icon background used to distinguish sessions. */
  iconBg?: string;
  /** Pinned sessions sort to the top of the sidebar. */
  pinned?: boolean;
  /**
   * Shell pane id whose cwd this session's FIRST shell should inherit —
   * set at creation to the then-active session's shell, so a new session
   * opens where the user currently is.
   */
  inheritFrom?: string;
  /** All panel ids currently in this session (terminal + browser). */
  panelIds: string[];
  /** Serialized dockview layout (api.toJSON()); restored on load. */
  layout?: unknown;
}

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string;

  setActiveTab: (tabId: string) => void;
  newTab: () => void;
  closeTab: (tabId: string) => void;
  renameTab: (tabId: string, title: string) => void;
  setTabIconBg: (tabId: string, iconBg: string) => void;
  togglePin: (tabId: string) => void;
  /** Persist a session's dockview layout + its current panel ids. */
  setLayout: (tabId: string, layout: unknown, panelIds: string[]) => void;
}

const uid = () => crypto.randomUUID();
export const SESSION_ICON_BACKGROUNDS = [
  "#173ea5",
  "#065f46",
  "#92400e",
  "#991b1b",
  "#5b21b6",
  "#155e75",
  "#9d174d",
  "#3730a3",
];
const LEGACY_MUTED_BACKGROUNDS = [
  "#536170",
  "#5f6658",
  "#6b6356",
  "#6a5a5f",
  "#5d586d",
  "#4f6668",
  "#665861",
  "#58626a",
];

// Next "session N" number derived from live titles — survives restarts
// (a module counter would reset and collide with persisted tabs).
const nextSessionNumber = (tabs: Tab[]): number => {
  let max = 0;
  for (const t of tabs) {
    const m = /^session (\d+)$/.exec(t.title);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
};

const makeTab = (n: number): Tab => ({
  id: uid(),
  title: `session ${n}`,
  iconBg: SESSION_ICON_BACKGROUNDS[(n - 1) % SESSION_ICON_BACKGROUNDS.length],
  panelIds: [],
  layout: undefined,
});

const initialTab = makeTab(1);

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      tabs: [initialTab],
      activeTabId: initialTab.id,

      setActiveTab: (tabId) => set({ activeTabId: tabId }),

      newTab: () =>
        set((s) => {
          const active = s.tabs.find((t) => t.id === s.activeTabId);
          const tab = {
            ...makeTab(nextSessionNumber(s.tabs)),
            inheritFrom: active?.panelIds[0],
          };
          return { tabs: [...s.tabs, tab], activeTabId: tab.id };
        }),

      closeTab: (tabId) =>
        set((s) => {
          if (s.tabs.length <= 1) return s;
          const idx = s.tabs.findIndex((t) => t.id === tabId);
          const tabs = s.tabs.filter((t) => t.id !== tabId);
          let activeTabId = s.activeTabId;
          if (activeTabId === tabId) {
            activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id;
          }
          // GC any per-pane status left behind by the closed session's panes
          // (their terminal-pane unmount clears them, but prune defensively in
          // case a pane never disposed cleanly).
          useStatusStore
            .getState()
            .pruneExcept(tabs.flatMap((t) => t.panelIds));
          return { tabs, activeTabId };
        }),

      togglePin: (tabId) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, pinned: !t.pinned } : t
          ),
        })),

      renameTab: (tabId, title) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, title: title.trim() || t.title } : t
          ),
        })),

      setTabIconBg: (tabId, iconBg) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, iconBg } : t
          ),
        })),

      setLayout: (tabId, layout, panelIds) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, layout, panelIds } : t
          ),
        })),
    }),
    {
      // New key (v1 used a split-tree layout that's incompatible with dockview).
      name: "naru-workspace-v2",
      storage: createJSONStorage(() => kvStorage),
      partialize: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId }),
      merge: (persisted, current) => {
        const p = persisted as Partial<WorkspaceState> | undefined;
        // Defensive against schema drift in persisted KV data: only trust tab
        // entries with the right shape (string id, array panelIds); drop the
        // rest rather than handing malformed tabs to the UI.
        const validTabs = Array.isArray(p?.tabs)
          ? p!.tabs.filter(
              (tab): tab is Tab =>
                !!tab &&
                typeof tab.id === "string" &&
                Array.isArray(tab.panelIds)
            )
          : [];
        const tabs =
          validTabs.length > 0
            ? validTabs.map((tab, index) => {
                const legacyIndex = LEGACY_MUTED_BACKGROUNDS.indexOf(
                  tab.iconBg ?? ""
                );
                return {
                  ...tab,
                  iconBg:
                    legacyIndex >= 0
                      ? SESSION_ICON_BACKGROUNDS[legacyIndex]
                      : tab.iconBg ??
                        SESSION_ICON_BACKGROUNDS[
                          index % SESSION_ICON_BACKGROUNDS.length
                        ],
                };
              })
            : current.tabs;
        // If the persisted activeTabId no longer matches a surviving tab,
        // fall back to the first tab (or the default state if none survived).
        const activeTabId =
          tabs.some((t) => t.id === p?.activeTabId)
            ? (p!.activeTabId as string)
            : tabs[0]?.id ?? current.activeTabId;
        return {
          ...current,
          ...p,
          tabs,
          activeTabId,
        } as WorkspaceState;
      },
    }
  )
);
