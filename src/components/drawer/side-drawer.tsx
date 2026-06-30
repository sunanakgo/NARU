import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { motion } from "motion/react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderTree,
  FolderSearch,
  GitBranch,
  GitCompareArrows,
  RefreshCw,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { ToolButton } from "@/components/common/tool-button";
import { FileIcon } from "@/components/drawer/file-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FILE_MANAGER } from "@/lib/platform";
import { useDrawer, type DrawerPanel } from "@/store/drawer";
import { useViewer } from "@/store/viewer";
import { useWorkspace } from "@/store/workspace";
import { useSessionInfo } from "@/store/session-info";

/**
 * Drawer docked right next to the session sidebar (Warp-absorption goal):
 * a file explorer with real file-type icons, and a git changes panel with
 * per-file diffs. Rooted at the ACTIVE session's cwd.
 */
export function SideDrawer() {
  const open = useDrawer((s) => s.open);
  // While the drawer animates closed (open → null) keep rendering the panel
  // that WAS open, so closing the Git panel doesn't briefly flash the Explorer
  // (the `shown === "git" ? … : explorer` fallback). Width still tracks `open`.
  const lastPanel = useRef<DrawerPanel>("files");
  if (open) lastPanel.current = open;
  const shown = open ?? lastPanel.current;
  const close = useDrawer((s) => s.close);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const info = useSessionInfo(activeTab?.panelIds[0], open !== null);
  const cwd = info?.cwd ?? null;

  return (
    <motion.div
      animate={{ width: open ? 288 : 0 }}
      initial={false}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      className="h-full shrink-0 overflow-hidden bg-sidebar"
    >
      <div className="flex h-full w-[288px] flex-col">
        <div className="flex h-[49px] shrink-0 items-center justify-between border-b border-border/60 pr-1.5 pl-3">
          <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
            {shown === "git" ? (
              <GitCompareArrows className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FolderTree className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">
              {shown === "git" ? "Git 변경 사항" : "탐색기"}
            </span>
          </span>
          <ToolButton tip="닫기" size="icon-xs" onClick={close}>
            <X />
          </ToolButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {!cwd ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              활성 세션의 작업 폴더를 찾는 중...
            </p>
          ) : shown === "git" ? (
            <GitPanel cwd={cwd} />
          ) : (
            <ExplorerPanel cwd={cwd} />
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ── file explorer ────────────────────────────────────────────────────────────

interface FsEntry {
  name: string;
  is_dir: boolean;
}

// Cap entries rendered per directory so a huge folder can't lock up the UI.
const MAX_ENTRIES = 500;

function ExplorerPanel({ cwd }: { cwd: string }) {
  return (
    <div>
      <div className="truncate px-2 pb-1.5 font-mono text-[10.5px] text-muted-foreground">
        {cwd}
      </div>
      <DirNode path={cwd} depth={0} defaultOpen />
    </div>
  );
}

function DirNode({
  path,
  depth,
  defaultOpen = false,
}: {
  path: string;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [entries, setEntries] = useState<FsEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    void invoke<FsEntry[]>("fs_list", { path })
      .then((r) => {
        if (alive) setEntries(r);
      })
      .catch(() => {
        if (alive) setEntries([]);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (!defaultOpen) return null; // children are rendered by EntryRow when open
  if (!entries)
    return <p className="px-2 py-1 text-xs text-muted-foreground">로딩 중...</p>;
  const shown = entries.slice(0, MAX_ENTRIES);
  const hidden = entries.length - shown.length;
  return (
    <div>
      {shown.map((e) => (
        <EntryRow key={e.name} parent={path} entry={e} depth={depth} />
      ))}
      {hidden > 0 && (
        <p
          className="px-2 py-1 text-[11px] text-muted-foreground"
          style={{ paddingLeft: `${22 + depth * 14}px` }}
        >
          +{hidden}개 더 있음
        </p>
      )}
    </div>
  );
}

function EntryRow({
  parent,
  entry,
  depth,
}: {
  parent: string;
  entry: FsEntry;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const openViewer = useViewer((s) => s.open);
  const sep = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  const full = parent.endsWith(sep) ? parent + entry.name : parent + sep + entry.name;

  const row = (
    <button
      onClick={() => {
        if (entry.is_dir) setOpen((o) => !o);
        else openViewer(full); // documents open in the in-app viewer
      }}
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-[3px] text-left text-[12.5px] hover:bg-accent/60"
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      title={entry.name}
    >
      {entry.is_dir ? (
        open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <FileIcon name={entry.name} isDir={entry.is_dir} open={open} />
      <span className="truncate">{entry.name}</span>
    </button>
  );

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {!entry.is_dir && (
            <ContextMenuItem onSelect={() => openViewer(full)}>
              <FileText />앱에서 열기
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void openPath(full).catch(() => {})}>
            <ExternalLink />기본 앱으로 열기
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => void revealItemInDir(full).catch(() => {})}
          >
            <FolderSearch />
            {FILE_MANAGER}에서 보기
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {entry.is_dir && open && <SubDir path={full} depth={depth + 1} />}
    </div>
  );
}

function SubDir({ path, depth }: { path: string; depth: number }) {
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    void invoke<FsEntry[]>("fs_list", { path })
      .then((r) => alive && setEntries(r))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [path]);
  if (!entries)
    return (
      <p
        className="py-0.5 text-[11px] text-muted-foreground"
        style={{ paddingLeft: `${22 + depth * 14}px` }}
      >
        로딩 중...
      </p>
    );
  const shown = entries.slice(0, MAX_ENTRIES);
  const hidden = entries.length - shown.length;
  return (
    <div>
      {shown.map((e) => (
        <EntryRow key={e.name} parent={path} entry={e} depth={depth} />
      ))}
      {hidden > 0 && (
        <p
          className="py-0.5 text-[11px] text-muted-foreground"
          style={{ paddingLeft: `${22 + depth * 14}px` }}
        >
          +{hidden}개 더 있음
        </p>
      )}
    </div>
  );
}

// ── git changes ──────────────────────────────────────────────────────────────

interface ChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
}
interface GitChanges {
  branch: string | null;
  files: ChangedFile[];
  /** git binary missing from PATH — distinct from "not a repository". */
  gitMissing: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  M: "text-amber-400",
  A: "text-emerald-400",
  U: "text-emerald-400",
  D: "text-red-400",
  R: "text-sky-400",
};

function GitPanel({ cwd }: { cwd: string }) {
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void invoke<GitChanges>("git_changes", { cwd })
      .then(setChanges)
      .catch(() => setChanges(null));
  }, [cwd]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(() => {
      // Don't poll git while the window/tab is backgrounded.
      if (document.visibilityState !== "visible") return;
      refresh();
    }, 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  if (!changes) {
    return (
      <p className="px-2 py-4 text-xs text-muted-foreground">
        git 정보를 읽는 중...
      </p>
    );
  }
  if (changes.gitMissing) {
    return (
      <p className="px-2 py-4 text-xs text-muted-foreground">
        git을 찾을 수 없습니다 — PATH에 git이 설치되어 있는지 확인하세요.
      </p>
    );
  }
  if (!changes.branch) {
    return (
      <p className="px-2 py-4 text-xs text-muted-foreground">
        git 저장소가 아닙니다.
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">
            {changes.branch}
          </span>
        </span>
        <ToolButton tip="새로고침" size="icon-xs" onClick={refresh}>
          <RefreshCw />
        </ToolButton>
      </div>
      {changes.files.length === 0 ? (
        <p className="px-2 py-4 text-xs text-muted-foreground">
          변경 사항 없음 — 워킹 트리가 깨끗합니다.
        </p>
      ) : (
        changes.files.map((f) => (
          <ChangedFileRow
            key={f.path}
            cwd={cwd}
            file={f}
            open={openFile === f.path}
            onToggle={() =>
              setOpenFile((cur) => (cur === f.path ? null : f.path))
            }
          />
        ))
      )}
    </div>
  );
}

function ChangedFileRow({
  cwd,
  file,
  open,
  onToggle,
}: {
  cwd: string;
  file: ChangedFile;
  open: boolean;
  onToggle: () => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDiff(null);
    void invoke<string>("git_diff_file", { cwd, path: file.path })
      .then(setDiff)
      .catch(() => setDiff(""));
  }, [open, cwd, file.path]);

  const base = file.path.split(/[\\/]/).pop() ?? file.path;

  return (
    <div className="mb-0.5">
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-accent/60",
          open && "bg-accent/40"
        )}
        title={file.path}
      >
        <span
          className={cn(
            "w-3 shrink-0 text-center font-mono text-[11px] font-bold",
            STATUS_STYLE[file.status] ?? "text-muted-foreground"
          )}
        >
          {file.status}
        </span>
        <FileIcon name={base} isDir={false} size={14} />
        <span className="min-w-0 flex-1 truncate">{file.path}</span>
        {(file.added > 0 || file.removed > 0) && (
          <span className="shrink-0 font-mono text-[10.5px]">
            <span className="text-t-green">+{file.added}</span>{" "}
            <span className="text-t-red">-{file.removed}</span>
          </span>
        )}
      </button>
      {open && (
        // Grows to full height (the drawer body scrolls vertically);
        // only long lines scroll, horizontally, inside the box.
        <div className="mt-1 mb-2 overflow-x-auto rounded-md border border-border bg-term-bg px-2 py-1.5">
          {diff === null ? (
            <p className="text-[11px] text-muted-foreground">diff 로딩 중...</p>
          ) : diff === "" ? (
            <p className="text-[11px] text-muted-foreground">표시할 diff가 없습니다.</p>
          ) : (
            <DiffBody diff={diff} />
          )}
        </div>
      )}
    </div>
  );
}

// Render a unified diff, capping rendered rows so a massive diff can't freeze
// the renderer; a trailing row notes how many lines were omitted.
const MAX_DIFF_LINES = 3000;

function DiffBody({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const hidden = lines.length - shown.length;
  return (
    <pre className="font-mono text-[11px] leading-[1.5] whitespace-pre">
      {shown.map((line, i) => (
        <div
          key={i}
          className={cn(
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-emerald-500/10 text-emerald-300"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-red-500/10 text-red-300"
                : line.startsWith("@@")
                  ? "text-sky-400"
                  : "text-muted-foreground"
          )}
        >
          {line || " "}
        </div>
      ))}
      {hidden > 0 && (
        <div className="text-muted-foreground/70 italic">
          … {hidden.toLocaleString()}줄 더 (생략됨)
        </div>
      )}
    </pre>
  );
}
