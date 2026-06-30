import { create } from "zustand";

import type { Snippet } from "@/store/snippets";

/** A snippet awaiting parameter input before it runs in `sessionId`. */
interface PendingRun {
  snippet: Snippet;
  sessionId: string | undefined;
}

interface SnippetRunState {
  pending: PendingRun | null;
  open: (snippet: Snippet, sessionId: string | undefined) => void;
  close: () => void;
}

export const useSnippetRun = create<SnippetRunState>((set) => ({
  pending: null,
  open: (snippet, sessionId) => set({ pending: { snippet, sessionId } }),
  close: () => set({ pending: null }),
}));
