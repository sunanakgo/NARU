import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

/** Side drawer next to the session sidebar: file explorer / git changes. */
export type DrawerPanel = "files" | "git";

interface DrawerState {
  open: DrawerPanel | null;
  toggle: (panel: DrawerPanel) => void;
  openPanel: (panel: DrawerPanel) => void;
  close: () => void;
}

export const useDrawer = create<DrawerState>()(
  persist(
    (set) => ({
      open: null,
      toggle: (panel) =>
        set((s) => ({ open: s.open === panel ? null : panel })),
      openPanel: (panel) => set({ open: panel }),
      close: () => set({ open: null }),
    }),
    { name: "naru-drawer", storage: createJSONStorage(() => kvStorage) }
  )
);
