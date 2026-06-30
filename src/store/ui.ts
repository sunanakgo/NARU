import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

/** Sidebar collapse state (shared so rows can request expand on rename). */
interface SidebarUIState {
  collapsed: boolean;
  resizing: boolean;
  layoutRevision: number;
  setCollapsed: (collapsed: boolean) => void;
  toggle: () => void;
  setResizing: (resizing: boolean) => void;
  finishResize: () => void;
}

export const useSidebarUI = create<SidebarUIState>()(
  persist(
    (set) => ({
      collapsed: false,
      resizing: false,
      layoutRevision: 0,
      setCollapsed: (collapsed) => set({ collapsed }),
      toggle: () => set((s) => ({ collapsed: !s.collapsed })),
      setResizing: (resizing) => set({ resizing }),
      finishResize: () =>
        set((s) => ({ resizing: false, layoutRevision: s.layoutRevision + 1 })),
    }),
    {
      name: "naru-sidebar",
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({ collapsed: state.collapsed }),
    }
  )
);
