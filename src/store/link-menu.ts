import { create } from "zustand";

/**
 * Right-click context menu for links in terminal output (PLAN — Warp/cmux
 * parity). A terminal contextmenu handler resolves the URL / file / folder
 * under the pointer and opens this menu; the menu component renders the
 * kind-appropriate actions (system default app, open in NARU, reveal, copy).
 */
export type LinkKind = "url" | "file" | "dir";

export interface LinkMenu {
  x: number;
  y: number;
  kind: LinkKind;
  /** Resolved absolute path (file/dir) or full URL. */
  value: string;
  /** The session the link came from (for "open in NARU" targeting). */
  sessionId: string;
}

interface LinkMenuState {
  menu: LinkMenu | null;
  openMenu: (menu: LinkMenu) => void;
  close: () => void;
}

export const useLinkMenu = create<LinkMenuState>((set) => ({
  menu: null,
  openMenu: (menu) => set({ menu }),
  close: () => set({ menu: null }),
}));
