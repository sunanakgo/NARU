import { create } from "zustand";

/**
 * Cross-component request to open a URL as a browser pane in a specific
 * session's dockview (e.g. clicking a detected port chip in the sidebar).
 * The session's Workspace consumes and clears the request.
 */
interface OpenBrowserState {
  pending: Record<string, string | undefined>;
  open: (tabId: string, url: string) => void;
  clear: (tabId: string) => void;
}

export const useOpenBrowser = create<OpenBrowserState>((set) => ({
  pending: {},
  open: (tabId, url) =>
    set((s) => ({ pending: { ...s.pending, [tabId]: url } })),
  clear: (tabId) =>
    set((s) => {
      const pending = { ...s.pending };
      delete pending[tabId];
      return { pending };
    }),
}));
