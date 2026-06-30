import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  Bell,
  ChevronDown,
  FolderTree,
  GitCompareArrows,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Square,
  Sun,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolButton } from "@/components/common/tool-button";
import { UpdateButton } from "@/components/chrome/update-button";
import {
  ExplorerFolderIcon,
  GitBashIcon,
  VSCodeIcon,
  WinTerminalIcon,
} from "@/components/common/app-icons";
import { useSessionInfo } from "@/store/session-info";
import { useSettings } from "@/store/settings";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { useTheme } from "@/store/theme";
import { useWorkspace } from "@/store/workspace";
import { useSidebarUI } from "@/store/ui";
import { useDrawer } from "@/store/drawer";
import { useCommandPalette } from "@/store/command";
import { useStatusStore, hasUnackedAttention } from "@/store/status";

import { IS_MAC } from "@/lib/platform";
import { isTauriRuntime } from "@/lib/tauri";

/**
 * Custom titlebar (decorations off). Platform-aware chrome:
 *   macOS  → traffic lights on the LEFT
 *   others → minimize/maximize/close on the RIGHT (Windows order)
 * The center is a Warp-style search pill that opens the command palette.
 */
export function Titlebar() {
  const theme = useTheme((s) => s.theme);
  const setMode = useTheme((s) => s.setMode);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const collapsed = useSidebarUI((s) => s.collapsed);
  const toggleSidebar = useSidebarUI((s) => s.toggle);
  const drawerOpen = useDrawer((s) => s.open);
  const toggleDrawer = useDrawer((s) => s.toggle);
  // Primitive-returning selector — subscribing to the whole statuses/acked
  // maps re-rendered the titlebar on every status flip of any pane.
  const attentionCount = useStatusStore(
    (s) =>
      tabs.filter((t) => hasUnackedAttention(t.panelIds, s.statuses, s.acked))
        .length
  );

  // The git drawer only makes sense inside a repo — gate its toggle on the
  // active session's branch (null = cwd is not a git repository).
  const activePanelId = tabs.find((t) => t.id === activeTabId)?.panelIds[0];
  const activeInfo = useSessionInfo(activePanelId);
  const isGitRepo = !!activeInfo?.branch;

  const win = isTauriRuntime() ? getCurrentWindow() : null;

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-[38px] shrink-0 items-center gap-3 border-b border-border bg-titlebar select-none",
        // macOS uses NATIVE traffic lights (titleBarStyle: Overlay) sitting at
        // the top-left — reserve room so our chrome doesn't slide under them.
        // Windows/Linux draw their own controls on the right, so keep the tight
        // left pad there.
        IS_MAC ? "pl-[78px]" : "pl-3"
      )}
    >
      <span className="relative inline-flex">
        <ToolButton tip="알림" className="h-7 w-8">
          <Bell />
        </ToolButton>
        {attentionCount > 0 && (
          <Badge className="pointer-events-none absolute -top-1 -right-1 h-3.5 min-w-3.5 justify-center rounded-full border-[1.5px] border-titlebar px-1 text-[9px] leading-none">
            {attentionCount}
          </Badge>
        )}
      </span>

      <ToolButton
        tip="사이드바 접기/펼치기"
        className="h-7 w-8"
        onClick={toggleSidebar}
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </ToolButton>

      {/* self-update: only renders when a newer release is available */}
      <UpdateButton />

      {/* center: Warp-style search (opens the command palette) */}
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center justify-center"
      >
        <button
          onClick={() => useCommandPalette.getState().setOpen(true)}
          className="flex h-[26px] w-72 max-w-[40vw] items-center gap-2 rounded-md border border-border/70 bg-background/50 px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="flex-1 truncate text-left">검색...</span>
        </button>
      </div>

      {/* open the active session's cwd in an external app */}
      <OpenInMenu panelId={activePanelId} />

      {/* drawer toggles: explorer / git changes (open next to the sidebar) */}
      <ToolButton
        tip="탐색기"
        className="h-7 w-8"
        active={drawerOpen === "files"}
        onClick={() => toggleDrawer("files")}
      >
        <FolderTree />
      </ToolButton>
      <ToolButton
        tip={isGitRepo ? "Git 변경 사항" : "Git 저장소가 아닙니다"}
        className="h-7 w-8"
        active={drawerOpen === "git"}
        disabled={!isGitRepo}
        onClick={() => toggleDrawer("git")}
      >
        <GitCompareArrows />
      </ToolButton>

      <ToolButton
        tip="설정"
        className="h-7 w-8"
        onClick={() => useSettingsDialog.getState().setOpen(true)}
      >
        <Settings />
      </ToolButton>

      <div className={cn("inline-flex rounded-md bg-muted p-0.5", !IS_MAC && "mr-1")}>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setMode("light")}
          className={cn(
            "w-[26px] text-muted-foreground hover:bg-transparent",
            theme === "light" &&
              "bg-background text-foreground shadow-[0_1px_2px_hsl(0_0%_0%/0.12)] hover:bg-background"
          )}
        >
          <Sun />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setMode("dark")}
          className={cn(
            "w-[26px] text-muted-foreground hover:bg-transparent",
            theme === "dark" &&
              "bg-background text-foreground shadow-[0_1px_2px_hsl(0_0%_0%/0.12)] hover:bg-background"
          )}
        >
          <Moon />
        </Button>
      </div>

      {!IS_MAC && (
        <div className="flex h-full items-stretch self-start">
          <button
            onClick={() => void win?.minimize()}
            aria-label="minimize"
            className="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            onClick={() => void win?.toggleMaximize()}
            aria-label="maximize"
            className="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Square className="size-3" />
          </button>
          <button
            onClick={() => void win?.close()}
            aria-label="close"
            className="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-red-500 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

type OpenInApp = "explorer" | "vscode" | "terminal" | "gitbash";

const OPEN_IN_APPS: {
  app: OpenInApp;
  label: string;
  Icon: (p: { size?: number }) => React.ReactNode;
}[] = [
  { app: "vscode", label: "VS Code", Icon: VSCodeIcon },
  {
    app: "explorer",
    label: IS_MAC ? "Finder" : "File Explorer",
    Icon: ExplorerFolderIcon,
  },
  {
    app: "terminal",
    label: IS_MAC ? "Terminal" : "Windows Terminal",
    Icon: WinTerminalIcon,
  },
  ...(IS_MAC
    ? []
    : [{ app: "gitbash" as const, label: "Git Bash", Icon: GitBashIcon }]),
];

/**
 * "현재 폴더를 …에서 열기" — VS Code-style SPLIT button: the main button
 * opens the active session's live (OSC 7) cwd in the selected app (its real
 * icon shows there; default File Explorer), the chevron picks another app
 * which runs immediately and becomes the new default.
 */
function OpenInMenu({ panelId }: { panelId?: string }) {
  const info = useSessionInfo(panelId);
  const cwd = info?.cwd ?? null;
  const selected = useSettings((s) => s.openInApp);
  const setSettings = useSettings((s) => s.set);
  const current =
    OPEN_IN_APPS.find((a) => a.app === selected) ?? OPEN_IN_APPS[1];

  const openIn = (app: OpenInApp) => {
    if (cwd) void invoke("open_dir_in", { app, cwd }).catch(() => {});
  };

  return (
    <div className="flex items-center">
      <ToolButton
        tip={`${current.label}에서 열기`}
        className="h-7 w-8 rounded-r-none"
        onClick={() => openIn(current.app)}
      >
        <current.Icon size={16} />
      </ToolButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="폴더를 열 앱 선택"
            title={cwd ?? undefined}
            className="grid h-7 w-3.5 place-items-center rounded-r-md text-muted-foreground hover:bg-accent hover:text-accent-foreground [&_svg]:size-3"
          >
            <ChevronDown />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {OPEN_IN_APPS.map(({ app, label, Icon }) => (
            <DropdownMenuItem
              key={app}
              disabled={!cwd}
              onSelect={() => {
                setSettings({ openInApp: app });
                openIn(app);
              }}
            >
              <Icon size={15} />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
