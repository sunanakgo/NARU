import { useEffect, useRef } from "react";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";

import { panelComponents } from "./panels";
import { PanelTab } from "./panel-tab";
import { GroupActions } from "./group-actions";
import { useWorkspace } from "@/store/workspace";
import { useTheme } from "@/store/theme";
import { useOverlay } from "@/store/overlay";
import { useOpenBrowser } from "@/store/pane-commands";
import { useWorkspaceCommand } from "@/store/workspace-command";
import { sessionDevUrl } from "@/store/session-info";

const uid = () => crypto.randomUUID();

type Disposable = { dispose: () => void };

/**
 * One session's pane area, powered by dockview (PLAN §5). Provides draggable /
 * dockable tabs, splits and the "window-arrangement" gestures. Each session
 * keeps its own dockview instance (mounted, hidden when inactive) so its PTYs
 * survive session switches; the layout is serialized to the workspace store.
 */
export function Workspace({ tabId }: { tabId: string }) {
  const theme = useTheme((s) => s.theme);
  const subs = useRef<Disposable[]>([]);
  const disposed = useRef(false);
  const apiRef = useRef<DockviewApi | null>(null);

  useEffect(
    () => () => {
      disposed.current = true;
      subs.current.forEach((d) => d.dispose());
    },
    []
  );

  // Execute keybinding-dispatched dockview commands when this is the active
  // session.
  const lastCmd = useRef(0);
  useEffect(() => {
    return useWorkspaceCommand.subscribe((state) => {
      if (state.token === lastCmd.current) return;
      lastCmd.current = state.token;
      if (useWorkspace.getState().activeTabId !== tabId) return;
      const api = apiRef.current;
      const group = api?.activeGroup;
      if (!api) return;
      // New shells inherit the active (or any) sibling terminal's cwd.
      const sibling =
        api.activePanel?.params?.kind === "terminal"
          ? api.activePanel.id
          : api.panels.find((p) => p.params?.kind === "terminal")?.id;
      const term = { kind: "terminal" as const, inheritFrom: sibling };
      switch (state.cmd) {
        case "newTerminal": {
          // `arg` (when present) is a command auto-run in the fresh shell —
          // used by SSH connect to launch `ssh …` in a dedicated pane.
          const params = state.arg ? { ...term, startupCommand: state.arg } : term;
          const title = state.arg ? "ssh" : "shell";
          api.addPanel({ id: uid(), component: "terminal", title, params, position: group ? { referenceGroup: group } : undefined });
          break;
        }
        case "newBrowser":
          // The session's running dev server (first listening port) → :3000.
          void sessionDevUrl(sibling)
            .then((url) => {
              // The dockview may have been torn down while we awaited the URL.
              if (disposed.current || apiRef.current !== api) return;
              api.addPanel({ id: uid(), component: "browser", title: "Browser", params: { kind: "browser", url }, position: group ? { referenceGroup: group } : undefined });
            })
            .catch(() => {});
          break;
        case "openProcMonitor": {
          // Singleton per session — focus the existing panel if one is open.
          const existing = api.panels.find((p) => p.params?.kind === "procmon");
          if (existing) {
            existing.api.setActive();
            break;
          }
          // Scope to THIS session (tab) so the pane shows only what this
          // session's shells — and the agent running in them — have spawned.
          api.addPanel({ id: uid(), component: "procmon", title: "Processes", params: { kind: "procmon", scopeTabId: tabId }, position: group ? { referenceGroup: group } : undefined });
          break;
        }
        case "openRunbook": {
          // Singleton — focus the existing runbook pane if one is open.
          const existing = api.panels.find((p) => p.params?.kind === "runbook");
          if (existing) {
            existing.api.setActive();
            break;
          }
          api.addPanel({ id: uid(), component: "runbook", title: "Runbook", params: { kind: "runbook" }, position: group ? { referenceGroup: group } : undefined });
          break;
        }
        case "openReplay": {
          const existing = api.panels.find((p) => p.params?.kind === "replay");
          if (existing) {
            existing.api.setActive();
            break;
          }
          api.addPanel({ id: uid(), component: "replay", title: "Replay", params: { kind: "replay" }, position: group ? { referenceGroup: group } : undefined });
          break;
        }
        case "splitRight":
          if (group) api.addPanel({ id: uid(), component: "terminal", title: "shell", params: term, position: { referenceGroup: group, direction: "right" } });
          break;
        case "splitDown":
          if (group) api.addPanel({ id: uid(), component: "terminal", title: "shell", params: term, position: { referenceGroup: group, direction: "below" } });
          break;
        case "closePane":
          api.activePanel?.api.close();
          break;
      }
    });
  }, [tabId]);

  const addShell = (api: DockviewApi) => {
    const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
    // empty-reopen → this session's own (just-closed) shell; brand-new
    // session → the previously active session's shell. Either way the new
    // shell opens in the directory the user was working in.
    const inheritFrom = tab?.panelIds[0] ?? tab?.inheritFrom;
    api.addPanel({
      id: uid(),
      component: "terminal",
      title: "shell",
      params: { kind: "terminal", inheritFrom },
    });
  };

  const onReady = (event: DockviewReadyEvent) => {
    const api: DockviewApi = event.api;
    // Guard against onReady firing twice for this instance (HMR / remount):
    // tear down any subscriptions from a prior run so we don't double-wire.
    subs.current.forEach((d) => d.dispose());
    subs.current = [];
    disposed.current = false;
    apiRef.current = api;
    const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);

    let restored = false;
    if (tab?.layout) {
      try {
        api.fromJSON(tab.layout as Parameters<typeof api.fromJSON>[0]);
        restored = api.panels.length > 0;
      } catch (e) {
        console.error(`[naru] layout restore failed for tab ${tabId}:`, e);
        restored = false;
      }
    }
    if (!restored) addShell(api);

    const persist = () => {
      // Deferred: when this dockview is DISPOSED (unmount / HMR remount) it
      // fires onDidLayoutChange for every panel it tears down. Persisting
      // those shrinking intermediate layouts corrupts the stored session,
      // and the empty-reopen below would even spawn a stray PTY mid-teardown.
      // Disposal is synchronous within the same commit, so by the time this
      // microtask runs `disposed` is set and stale events are dropped.
      queueMicrotask(() => {
        if (disposed.current || apiRef.current !== api) return;
        // Closing the last pane must not leave an empty, unusable session —
        // re-open a shell so the user can keep working.
        if (api.panels.length === 0) {
          addShell(api);
          return;
        }
        // Terminals first: consumers treat panelIds[0] as "the session's
        // shell" (sidebar git info, drawer cwd) — a browser pane there would
        // blank them out.
        const ids = [...api.panels]
          .sort((a, b) => {
            const at = a.params?.kind === "terminal" ? 0 : 1;
            const bt = b.params?.kind === "terminal" ? 0 : 1;
            return at - bt;
          })
          .map((p) => p.id);
        useWorkspace.getState().setLayout(tabId, api.toJSON(), ids);
      });
    };
    persist();
    subs.current.push(api.onDidLayoutChange(persist));

    // Hide native browser webviews while a tab/group is being dragged so they
    // don't cover dockview's drop indicators; restore on pointer release.
    const onDragStart = () => {
      useOverlay.getState().inc();
      const end = () => {
        useOverlay.getState().dec();
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
      };
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
    };
    subs.current.push(
      api.onWillDragPanel(onDragStart),
      api.onWillDragGroup(onDragStart)
    );

    // Open-browser requests targeting this session (e.g. sidebar port chips).
    const tryOpen = () => {
      const url = useOpenBrowser.getState().pending[tabId];
      if (!url || !apiRef.current) return;
      apiRef.current.addPanel({
        id: uid(),
        component: "browser",
        title: "Browser",
        params: { kind: "browser", url },
        position: apiRef.current.activeGroup
          ? { referenceGroup: apiRef.current.activeGroup }
          : undefined,
      });
      useOpenBrowser.getState().clear(tabId);
    };
    tryOpen();
    subs.current.push({ dispose: useOpenBrowser.subscribe(tryOpen) });
  };

  return (
    <DockviewReact
      className="naru-dock h-full w-full"
      theme={theme === "dark" ? themeDark : themeLight}
      // NOTE: do NOT use defaultRenderer="always" — it reparents panel content
      // into rAF-positioned overlay divs that misposition (full-size, floating
      // over every pane) when workspaces are stacked/hidden the way we do.
      onReady={onReady}
      components={panelComponents}
      defaultTabComponent={PanelTab}
      rightHeaderActionsComponent={GroupActions}
    />
  );
}
