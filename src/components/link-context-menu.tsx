import { useEffect, useRef, useState } from "react";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Copy,
  ExternalLink,
  Eye,
  FolderOpen,
  FolderSearch,
  Globe,
  SquareTerminal,
} from "lucide-react";

import { FILE_MANAGER } from "@/lib/platform";
import { useLinkMenu, type LinkMenu } from "@/store/link-menu";
import { useViewer } from "@/store/viewer";
import { useOpenBrowser } from "@/store/pane-commands";
import { useWorkspace } from "@/store/workspace";
import { useWorkspaceCommand } from "@/store/workspace-command";

interface Item {
  icon: typeof Copy;
  label: string;
  run: () => void;
}

/**
 * Right-click menu for terminal links (registered per terminal in path-links).
 * Renders kind-appropriate actions at the click point; dismisses on the next
 * click, scroll, resize or Escape. Mounted once at the app root.
 */
export function LinkContextMenu() {
  const menu = useLinkMenu((s) => s.menu);
  const close = useLinkMenu((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  // Clamp into the viewport once measured.
  useEffect(() => {
    if (!menu) return;
    const el = ref.current;
    const w = el?.offsetWidth ?? 220;
    const h = el?.offsetHeight ?? 200;
    setPos({
      left: Math.min(menu.x, window.innerWidth - w - 8),
      top: Math.min(menu.y, window.innerHeight - h - 8),
    });
  }, [menu]);

  // Dismiss on the next interaction outside the menu.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Defer so the opening contextmenu event doesn't immediately close it.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("contextmenu", onDown, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("wheel", close, true);
      window.addEventListener("resize", close);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu, close]);

  if (!menu) return null;

  const items = buildItems(menu);

  return (
    <div
      ref={ref}
      className="fixed z-[300] min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="truncate px-2 py-1 font-mono text-[10.5px] text-muted-foreground">
        {menu.value}
      </div>
      <div className="my-1 h-px bg-border" />
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <button
            key={i}
            onClick={() => {
              it.run();
              close();
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => {});
}

function openInNaruBrowser(sessionId: string, url: string) {
  const ws = useWorkspace.getState();
  const tab =
    ws.tabs.find((t) => t.panelIds.includes(sessionId)) ??
    ws.tabs.find((t) => t.id === ws.activeTabId);
  if (tab) useOpenBrowser.getState().open(tab.id, url);
}

function buildItems(menu: LinkMenu): Item[] {
  const { kind, value, sessionId } = menu;
  if (kind === "url") {
    return [
      {
        icon: ExternalLink,
        label: "기본 브라우저로 열기",
        run: () => void openUrl(value).catch(() => {}),
      },
      {
        icon: Globe,
        label: "NARU 브라우저로 열기",
        run: () => openInNaruBrowser(sessionId, value),
      },
      { icon: Copy, label: "URL 복사", run: () => copy(value) },
    ];
  }
  if (kind === "dir") {
    return [
      {
        icon: FolderOpen,
        label: "탐색기에서 열기",
        run: () => void openPath(value).catch(() => {}),
      },
      {
        icon: SquareTerminal,
        label: "NARU 터미널에서 열기",
        run: () =>
          useWorkspaceCommand.getState().dispatch("newTerminal", `cd "${value}"`),
      },
      {
        icon: FolderSearch,
        label: `${FILE_MANAGER}에서 위치 보기`,
        run: () => void revealItemInDir(value).catch(() => {}),
      },
      { icon: Copy, label: "경로 복사", run: () => copy(value) },
    ];
  }
  // file
  return [
    {
      icon: ExternalLink,
      label: "기본 앱으로 열기",
      run: () => void openPath(value).catch(() => {}),
    },
    {
      icon: Eye,
      label: "NARU 뷰어로 열기",
      run: () => useViewer.getState().open(value),
    },
    {
      icon: FolderSearch,
      label: `${FILE_MANAGER}에서 보기`,
      run: () => void revealItemInDir(value).catch(() => {}),
    },
    { icon: Copy, label: "경로 복사", run: () => copy(value) },
  ];
}
