import { useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  ArrowDownAZ,
  Clock,
  GitBranch,
  ListFilter,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SwatchBook,
  Trash2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolButton } from "@/components/common/tool-button";
import { BrandIcon } from "@/components/sidebar/brand-icon";
import {
  SESSION_ICON_BACKGROUNDS,
  useWorkspace,
  type Tab,
} from "@/store/workspace";
import {
  useStatusStore,
  aggregateStatus,
  hasUnackedAttention,
  useStableRunning,
} from "@/store/status";
import { useSessionInfo } from "@/store/session-info";
import { useSidebarUI } from "@/store/ui";
import { useOpenBrowser } from "@/store/pane-commands";
import { useWorkspaceCommand } from "@/store/workspace-command";

type SortMode = "recent" | "name";

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * cmux-style session list. Rows show the running agent's brand icon (with a
 * "running" dot), title (right-click → rename), working directory and git
 * branch + diff. Collapses to an icon rail with a framer-motion width spring.
 */
export function AppSidebar() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);
  const newTab = useWorkspace((s) => s.newTab);
  const collapsed = useSidebarUI((s) => s.collapsed);
  const setSidebarResizing = useSidebarUI((s) => s.setResizing);
  const finishSidebarResize = useSidebarUI((s) => s.finishResize);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");

  let list = query.trim()
    ? tabs.filter((t) => t.title.toLowerCase().includes(query.toLowerCase()))
    : tabs.slice();
  if (sort === "name") {
    list = list.slice().sort((a, b) => a.title.localeCompare(b.title));
  }
  // Pinned sessions float to the top (stable, preserving the order above).
  list = list
    .slice()
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 312 }}
      onAnimationStart={() => setSidebarResizing(true)}
      onAnimationComplete={() => finishSidebarResize()}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      className="flex h-full shrink-0 flex-col overflow-hidden bg-sidebar"
    >
      {/* header */}
      {collapsed ? (
        <div className="flex h-[49px] shrink-0 items-center justify-center border-b border-border/60">
          <ToolButton
            tip="새 세션"
            tipSide="right"
            size="icon-sm"
            onClick={newTab}
          >
            <Plus />
          </ToolButton>
        </div>
      ) : (
        <div className="flex items-center gap-[7px] border-b border-border/60 px-2.5 py-[9px]">
          <div className="relative flex-1">
            <ListFilter className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="세션 검색..."
              className="h-[30px] rounded-md bg-background pl-8 text-[12.5px]"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ToolButton tip="세션 정렬" size="icon-sm" className="h-[30px] w-8">
                {sort === "name" ? <ArrowDownAZ /> : <Clock />}
              </ToolButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(v) => setSort(v as SortMode)}
              >
                <DropdownMenuRadioItem value="recent">
                  최근 사용
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="name">이름</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <ToolButton
            tip="새 세션"
            size="icon-sm"
            className="h-[30px] w-8"
            onClick={newTab}
          >
            <Plus />
          </ToolButton>
        </div>
      )}

      {/* session list */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-2 py-2">
        {list.map((tab) => (
          <SessionRow
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            collapsed={collapsed}
            onSelect={() => setActiveTab(tab.id)}
          />
        ))}
      </div>
    </motion.aside>
  );
}

function SessionRow({
  tab,
  active,
  collapsed,
  onSelect,
}: {
  tab: Tab;
  active: boolean;
  collapsed: boolean;
  onSelect: () => void;
}) {
  const closeTab = useWorkspace((s) => s.closeTab);
  const renameTab = useWorkspace((s) => s.renameTab);
  const setTabIconBg = useWorkspace((s) => s.setTabIconBg);
  const togglePin = useWorkspace((s) => s.togglePin);
  const canClose = useWorkspace((s) => s.tabs.length > 1);
  const setCollapsed = useSidebarUI((s) => s.setCollapsed);
  // Narrowed selectors returning primitives — subscribing to the whole
  // statuses/acked maps re-rendered every row on every status flip.
  const status = useStatusStore((s) => aggregateStatus(tab.panelIds, s.statuses));
  const attention = useStatusStore((s) =>
    hasUnackedAttention(tab.panelIds, s.statuses, s.acked)
  );
  // Debounced so a resize/redraw's brief "running" blip (shell prompt repaint
  // on sidebar toggle, adding a pane…) doesn't flicker the dot.
  const running = useStableRunning(status === "running");
  // The agent pane's OWN status (not the tab aggregate) — the spinner must mean
  // "this agent is generating a response", not "some pane in the tab is busy".
  const primaryStatus = useStatusStore(
    (s) => s.statuses[tab.panelIds[0]] ?? "idle"
  );

  const info = useSessionInfo(tab.panelIds[0]);
  const brand = info?.brand ?? "shell";
  const isAgent =
    brand === "claude" || brand === "codex" || brand === "opencode";
  // Only while an agent (claude/codex/opencode) is actively generating: a
  // ring that sweeps the icon box border. A plain running shell keeps the dot.
  // Debounced so a resize blip doesn't flicker the spinner on an idle agent.
  const primaryRunning = useStableRunning(primaryStatus === "running");
  const agentRunning = isAgent && primaryRunning;
  const iconBg =
    tab.iconBg ??
    SESSION_ICON_BACKGROUNDS[
      Math.abs(hashString(tab.id)) % SESSION_ICON_BACKGROUNDS.length
    ];

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);

  // Renaming always needs the expanded inline input, so expand first.
  const startRename = () => {
    setCollapsed(false);
    setDraft(tab.title);
    setEditing(true);
  };
  const commitRename = () => {
    renameTab(tab.id, draft);
    setEditing(false);
  };

  const icon = (
    <div
      className={cn(
        "relative grid place-items-center rounded-lg border border-white/15 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]",
        collapsed ? "size-9" : "size-7"
      )}
      style={{ backgroundColor: iconBg }}
    >
      <BrandIcon brand={brand} size={collapsed ? 20 : 18} />
      {agentRunning ? (
        <span aria-hidden className="naru-agent-spinner" />
      ) : running ? (
        <span className="absolute right-1 bottom-1 size-1.5 rounded-full bg-run ring-2 ring-sidebar" />
      ) : null}
    </div>
  );

  const menuItems = (
    <>
      <ContextMenuItem onSelect={() => togglePin(tab.id)}>
        {tab.pinned ? <PinOff /> : <Pin />}
        {tab.pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <ContextMenuItem onSelect={startRename}>
        <Pencil />
        Rename
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          // The workspace-command bus targets the ACTIVE session — activate
          // this row's session first (zustand set is synchronous).
          useWorkspace.getState().setActiveTab(tab.id);
          useWorkspaceCommand.getState().dispatch("openProcMonitor");
        }}
      >
        <Activity />
        Process monitor
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <SwatchBook />
          Icon color
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44">
          <ContextMenuRadioGroup
            value={iconBg}
            onValueChange={(v) => setTabIconBg(tab.id, v)}
          >
            {SESSION_ICON_BACKGROUNDS.map((color) => (
              <ContextMenuRadioItem key={color} value={color}>
                <span
                  className="size-3.5 shrink-0 rounded-full border border-white/20"
                  style={{ backgroundColor: color }}
                />
                {color}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {canClose && (
        <ContextMenuItem
          variant="destructive"
          onSelect={() => closeTab(tab.id)}
        >
          <Trash2 />
          Delete
        </ContextMenuItem>
      )}
    </>
  );

  if (collapsed) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={onSelect}
            aria-label={tab.title}
            className={cn(
              "relative mx-auto flex items-center justify-center rounded-xl p-1 transition-colors",
              active ? "bg-accent" : "hover:bg-accent/50",
              attention && "ring-1 ring-primary/60"
            )}
          >
            {icon}
            {tab.pinned && (
              <Pin className="absolute -top-0.5 -left-0.5 size-2.5 fill-muted-foreground text-muted-foreground" />
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">{menuItems}</ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={onSelect}
          className={cn(
            "group relative cursor-default rounded-lg px-2.5 py-2 transition-colors",
            active ? "bg-accent" : "hover:bg-accent/50",
            attention && "ring-1 ring-primary/60"
          )}
        >
          <div className="flex items-start gap-2.5">
            {icon}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {tab.pinned && !editing && (
                  <Pin className="size-3 shrink-0 fill-muted-foreground text-muted-foreground" />
                )}
                {editing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditing(false);
                    }}
                    className="w-full rounded border border-input bg-background px-1 py-0.5 text-[13px] font-semibold outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                ) : (
                  <span
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRename();
                    }}
                    className="truncate text-[13px] font-semibold"
                  >
                    {tab.title}
                  </span>
                )}
                {!editing && canClose && (
                  <button
                    title="세션 닫기"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="ml-auto grid size-5 shrink-0 place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-background/70 [&_svg]:size-3.5"
                  >
                    <X />
                  </button>
                )}
              </div>

              {info?.cwd && (
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {info.cwd}
                </div>
              )}

              {info?.branch && (
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <GitBranch className="size-3" />
                    {info.branch}
                  </span>
                  {(info.added > 0 || info.removed > 0) && (
                    <span className="font-medium">
                      <span className="text-t-green">+{info.added}</span>{" "}
                      <span className="text-t-red">-{info.removed}</span>
                    </span>
                  )}
                </div>
              )}

              {info?.ports && info.ports.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {info.ports.slice(0, 5).map((p) => (
                    <button
                      key={p}
                      title={`localhost:${p} 열기`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect();
                        useOpenBrowser
                          .getState()
                          .open(tab.id, `http://localhost:${p}`);
                      }}
                      className="rounded bg-primary/10 px-1.5 font-mono text-[10.5px] font-medium text-primary hover:bg-primary/20"
                    >
                      :{p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">{menuItems}</ContextMenuContent>
    </ContextMenu>
  );
}
