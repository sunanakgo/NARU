import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

export interface RecentCommand {
  id: string;
  sessionId: string;
  command: string;
  cwd: string | null;
  at: number;
}

interface CommandHistoryState {
  recent: RecentCommand[];
  record: (entry: Omit<RecentCommand, "id" | "at">) => void;
}

const MAX_RECENT = 30;

export const useCommandHistory = create<CommandHistoryState>()(
  persist(
    (set) => ({
      recent: [],
      record: (entry) =>
        set((state) => {
          const command = entry.command.trim();
          if (!command) return state;
          const recent = state.recent.filter(
            (item) =>
              item.sessionId !== entry.sessionId || item.command !== command
          );
          recent.unshift({
            ...entry,
            command,
            id: crypto.randomUUID(),
            at: Date.now(),
          });
          return { recent: recent.slice(0, MAX_RECENT) };
        }),
    }),
    {
      name: "naru-command-history",
      storage: createJSONStorage(() => kvStorage),
      partialize: (s) => ({ recent: s.recent.slice(0, MAX_RECENT) }),
    }
  )
);
