import { create } from "zustand";

/** Open/close state for the cross-pane search overlay (PLAN §"글로벌 검색"). */
interface GlobalSearchState {
  open: boolean;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

export const useGlobalSearch = create<GlobalSearchState>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
}));
