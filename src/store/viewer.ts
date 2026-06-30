import { create } from "zustand";

/** Right-side file viewer panel (open from the explorer or terminal links). */
interface ViewerState {
  /** Absolute path of the open file, or null when closed. */
  path: string | null;
  open: (path: string) => void;
  close: () => void;
}

export const useViewer = create<ViewerState>((set) => ({
  path: null,
  open: (path) => set({ path }),
  close: () => set({ path: null }),
}));
