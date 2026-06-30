import { useEffect } from "react";

import { eventToCombo } from "@/lib/keys";
import { useKeymap } from "@/store/keymap";
import { useWorkspace } from "@/store/workspace";
import { useSidebarUI } from "@/store/ui";
import { useCommandPalette } from "@/store/command";
import { useGlobalSearch } from "@/store/global-search";
import { useWorkspaceCommand } from "@/store/workspace-command";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

function cycleSession(dir: 1 | -1) {
  const ws = useWorkspace.getState();
  const n = ws.tabs.length;
  if (n === 0) return;
  const i = ws.tabs.findIndex((t) => t.id === ws.activeTabId);
  const next = ws.tabs[(i + dir + n) % n];
  if (next) ws.setActiveTab(next.id);
}

function runAction(id: string) {
  switch (id) {
    case "commandPalette":
      useCommandPalette.getState().toggle();
      break;
    case "globalSearch":
      useGlobalSearch.getState().toggle();
      break;
    case "newSession":
      useWorkspace.getState().newTab();
      break;
    case "toggleSidebar":
      useSidebarUI.getState().toggle();
      break;
    case "openSettings":
      useSettingsDialog.getState().setOpen(true);
      break;
    case "nextSession":
      cycleSession(1);
      break;
    case "prevSession":
      cycleSession(-1);
      break;
    case "newTerminal":
      useWorkspaceCommand.getState().dispatch("newTerminal");
      break;
    case "newBrowser":
      useWorkspaceCommand.getState().dispatch("newBrowser");
      break;
    case "splitRight":
      useWorkspaceCommand.getState().dispatch("splitRight");
      break;
    case "splitDown":
      useWorkspaceCommand.getState().dispatch("splitDown");
      break;
    case "closePane":
      useWorkspaceCommand.getState().dispatch("closePane");
      break;
  }
}

/**
 * Global keybinding dispatcher (PLAN §5). Capture-phase so app shortcuts beat
 * the terminal. Renders nothing.
 */
export function Keybindings() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const combo = eventToCombo(e);
      if (!combo) return;
      const state = useKeymap.getState();
      if (state.recording) return; // a rebind is in progress
      const bindings = state.bindings;
      // setBinding enforces combo uniqueness (it clears any other action that
      // shares a chord), so this first-match lookup is deterministic — at most
      // one action can own `combo`.
      const id = Object.keys(bindings).find((k) => bindings[k] === combo);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      runAction(id);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  return null;
}
