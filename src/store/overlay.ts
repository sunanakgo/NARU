import { create } from "zustand";

/**
 * Tracks how many DOM modals (command palette, settings) are open. Native
 * browser webviews float above the DOM, so they must hide while a modal is up.
 */
interface OverlayState {
  count: number;
  inc: () => void;
  dec: () => void;
}

export const useOverlay = create<OverlayState>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
  dec: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}));

/** Convenience for modal components: hide-webviews-while-open lifecycle. */
export function overlayOpen(): boolean {
  return useOverlay.getState().count > 0;
}
