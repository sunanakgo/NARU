import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import { cn } from "@/lib/utils";
import { useSettings, DEFAULT_UI_FONT } from "@/store/settings";
import { Titlebar } from "@/components/chrome/titlebar";
import { AppSidebar } from "@/components/sidebar/sidebar";
import { SideDrawer } from "@/components/drawer/side-drawer";
import { FileViewer } from "@/components/viewer/file-viewer";
import { Workspace } from "@/components/workspace/workspace";
import { NotificationManager } from "@/components/notification-manager";
import { TriggerManager } from "@/components/trigger-manager";
import { CommandPalette } from "@/components/command-palette";
import { GlobalSearch } from "@/components/global-search";
import { SnippetRunDialog } from "@/components/snippet-run-dialog";
import { LinkContextMenu } from "@/components/link-context-menu";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { Keybindings } from "@/components/keybindings";
import { useWorkspace } from "@/store/workspace";
import { useDrawer, type DrawerPanel } from "@/store/drawer";
import { useViewer } from "@/store/viewer";
import { useUpdater } from "@/store/updater";

/**
 * NARU window shell (design naru-workspace.html):
 *   titlebar  ·  [ sidebar | dockview workspace ]
 *
 * Every session's Workspace stays mounted (inactive ones display:none) so its
 * dockview panels / PTYs survive session switches.
 */
function App() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const uiFont = useSettings((s) => s.uiFont);
  const windowBlur = useSettings((s) => s.windowBlur);

  useEffect(() => {
    document.documentElement.classList.toggle("naru-blur", windowBlur);
    void invoke("set_window_blur", { enable: windowBlur }).catch(() => {});
  }, [windowBlur]);

  // Per-session drawer + file preview: the explorer/git drawer and the file
  // viewer are single app-level panels, so without scoping they bled across
  // sessions (stayed open when you switched). Snapshot the outgoing tab's
  // panels and restore the incoming tab's, giving each session its own.
  const perTabPanels = useRef<
    Record<string, { drawer: DrawerPanel | null; viewer: string | null }>
  >({});
  const prevTab = useRef<string | null>(null);
  useEffect(() => {
    const drawer = useDrawer.getState();
    const viewer = useViewer.getState();
    if (prevTab.current === null) {
      // First run: the persisted/global panels belong to the initial tab.
      perTabPanels.current[activeTabId] = {
        drawer: drawer.open,
        viewer: viewer.path,
      };
      prevTab.current = activeTabId;
      return;
    }
    if (prevTab.current === activeTabId) return;
    perTabPanels.current[prevTab.current] = {
      drawer: drawer.open,
      viewer: viewer.path,
    };
    const saved = perTabPanels.current[activeTabId] ?? {
      drawer: null,
      viewer: null,
    };
    useDrawer.setState({ open: saved.drawer });
    useViewer.setState({ path: saved.viewer });
    prevTab.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    const f = uiFont.trim();
    document.documentElement.style.setProperty(
      "--app-font",
      f ? `${f}, ${DEFAULT_UI_FONT}` : DEFAULT_UI_FONT
    );
  }, [uiFont]);

  // Block the webview's native context menu globally; our own Radix
  // ContextMenus still open (they handle the event on their triggers first).
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  // NO native (OS) tooltips anywhere — `title` attributes (ours and those set
  // by xterm/dockview/3rd-party DOM) are stripped the moment the pointer
  // enters, well before the ~1s tooltip delay. CSS can't disable them, so the
  // value moves to data-title to stay inspectable.
  useEffect(() => {
    const strip = (e: Event) => {
      let el = e.target instanceof Element ? e.target : null;
      while (el && el !== document.body) {
        if (el.hasAttribute("title")) {
          el.setAttribute("data-title", el.getAttribute("title")!);
          el.removeAttribute("title");
        }
        el = el.parentElement;
      }
    };
    window.addEventListener("mouseover", strip, true);
    return () => window.removeEventListener("mouseover", strip, true);
  }, []);

  // Check GitHub Releases for a newer version on startup, then every 6h. A hit
  // flips the updater store to "available", which reveals the titlebar's
  // download button. No-ops outside the Tauri runtime.
  useEffect(() => {
    const check = () => void useUpdater.getState().checkForUpdate();
    check();
    const id = setInterval(check, 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Orchestrator API requested a new session.
  useEffect(() => {
    let cancelled = false;
    const p = listen("orchestrator://spawn", () => {
      if (!cancelled) useWorkspace.getState().newTab();
    });
    return () => {
      cancelled = true;
      void p.then((un) => un()).catch(() => {});
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <NotificationManager />
      <TriggerManager />
      <CommandPalette />
      <GlobalSearch />
      <SnippetRunDialog />
      <LinkContextMenu />
      <SettingsDialog />
      <Keybindings />
      <Titlebar />

      <div className="flex min-h-0 flex-1 bg-sidebar">
        <AppSidebar />
        <SideDrawer />

        {/* Rounded inset workspace — the curved left edge reads against the
            sidebar background instead of a hard divider line. */}
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-l-2xl bg-background">
          {/* Inactive sessions use visibility:hidden (NOT display:none): they
              keep their real layout size, so terminals never pass through a
              0×0 fit → bogus PTY resize → ConPTY re-wrap that garbles the
              screen when switching sessions. */}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "absolute inset-0",
                tab.id === activeTabId ? "" : "naru-session-hidden"
              )}
            >
              <Workspace tabId={tab.id} />
            </div>
          ))}
        </main>

        {/* right-side document viewer (explorer clicks, terminal path links) */}
        <FileViewer />
      </div>
    </div>
  );
}

export default App;
