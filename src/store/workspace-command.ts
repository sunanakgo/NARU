import { create } from "zustand";

/**
 * One-shot dockview commands targeted at the *active* session's Workspace
 * (from keybindings). The Workspace whose tab is active consumes the latest
 * token once.
 */
export type WorkspaceCmd =
  | "splitRight"
  | "splitDown"
  | "newTerminal"
  | "newBrowser"
  | "openProcMonitor"
  | "openRunbook"
  | "openReplay"
  | "closePane";

interface WorkspaceCommandState {
  token: number;
  cmd: WorkspaceCmd | null;
  /** Optional payload — e.g. an `ssh` command line for `newTerminal`. */
  arg?: string;
  dispatch: (cmd: WorkspaceCmd, arg?: string) => void;
}

export const useWorkspaceCommand = create<WorkspaceCommandState>((set) => ({
  token: 0,
  cmd: null,
  arg: undefined,
  dispatch: (cmd, arg) => set((s) => ({ token: s.token + 1, cmd, arg })),
}));
