import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, RefreshCw, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NaruLogo } from "@/components/common/naru-logo";
import { useWorkspace } from "@/store/workspace";
import { isTauriRuntime } from "@/lib/tauri";

interface ProcessEntry {
  pid: number;
  parentPid: number | null;
  name: string;
  command: string;
  cwd: string | null;
  /** CPU usage as % of the whole machine (already core-normalized). */
  cpu: number;
  /** Resident memory in bytes. */
  memory: number;
  ports: number[];
  /** PTY session id (== terminal panel id) that owns this process tree. */
  sessionId: string | null;
  isShell: boolean;
}

interface ProcessList {
  entries: ProcessEntry[];
  /** Whole-machine CPU %, 0 on the very first sample. */
  cpuTotal: number;
  memUsed: number;
  memTotal: number;
}

const REFRESH_MS = 5_000;

/**
 * One grid template shared by the header and every row, so columns always
 * line up. Every track is FIXED or fr — never `auto`/content-sized: each row
 * is its own grid, so a content-sized track would resolve differently per
 * row and break column alignment (long PIDs, varying port lists).
 *
 * Classic process-monitor behavior in a dockview pane: the table never
 * restructures — columns just drop as the PANE narrows (container queries):
 * CWD needs @3xl, 세션 @xl, MEM @lg; PID/Command/CPU/Port/kill always show.
 */
const GRID =
  "grid items-center gap-x-3 " +
  "grid-cols-[3.6rem_minmax(0,1fr)_2.8rem_4.5rem_1.75rem] " +
  "@lg:grid-cols-[3.6rem_minmax(0,1fr)_2.8rem_3.8rem_4.5rem_1.75rem] " +
  "@xl:grid-cols-[3.6rem_minmax(0,1fr)_2.8rem_3.8rem_4.5rem_7rem_1.75rem] " +
  "@3xl:grid-cols-[3.6rem_minmax(0,1.6fr)_2.8rem_3.8rem_minmax(0,1fr)_4.5rem_7rem_1.75rem]";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function ProcessMonitorPane({ scopeTabId }: { scopeTabId?: string }) {
  // Runtime guard lives in a hook-free wrapper so the inner component's
  // hooks are unconditional (Rules of Hooks).
  if (!isTauriRuntime()) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Process Monitor runs inside the Tauri desktop app.
      </div>
    );
  }
  return <ProcessMonitorPaneImpl scopeTabId={scopeTabId} />;
}

function ProcessMonitorPaneImpl({ scopeTabId }: { scopeTabId?: string }) {
  const [entries, setEntries] = useState<ProcessEntry[]>([]);
  const [summary, setSummary] = useState<Omit<ProcessList, "entries"> | null>(
    null
  );
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ProcessEntry | null>(null);
  const [killing, setKilling] = useState(false);
  const tabs = useWorkspace((s) => s.tabs);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await invoke<ProcessList>("process_list");
      if (!alive.current) return;
      setEntries(list.entries);
      setSummary(list);
      setError(null);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) {
        setLoaded(true);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      // full-machine process scan — skip while minimized/hidden
      if (document.visibilityState !== "visible") return;
      void refresh();
    }, REFRESH_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const sessionTitle = (sessionId: string | null) =>
    sessionId
      ? tabs.find((t) => t.panelIds.includes(sessionId))?.title ?? sessionId
      : null;

  const confirmKill = async () => {
    if (!target) return;
    setKilling(true);
    try {
      await invoke("process_kill", { pid: target.pid });
      setTarget(null);
    } catch (e) {
      setError(String(e));
      setTarget(null);
    } finally {
      setKilling(false);
      void refresh();
    }
  };

  // Scoped to one session (tab): show only processes owned by that tab's
  // shells. Orphaned port-holders (sessionId === null) aren't attributable to
  // this session, so they only appear in the global (unscoped) view.
  const scopeTab = scopeTabId ? tabs.find((t) => t.id === scopeTabId) : undefined;
  const scopeIds = scopeTab ? new Set(scopeTab.panelIds) : null;
  const owned = entries.filter(
    (e) => e.sessionId !== null && (!scopeIds || scopeIds.has(e.sessionId))
  );
  const external = scopeIds ? [] : entries.filter((e) => e.sessionId === null);
  const shown = owned.length + external.length;

  return (
    <div className="@container flex h-full w-full flex-col bg-card">
      {/* toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Activity className="size-3.5 text-muted-foreground" />
        <span className="truncate text-xs font-medium">
          {scopeTab ? `${scopeTab.title} · 프로세스` : "Process Monitor"}
        </span>
        {loaded && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {shown}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          {summary && summary.memTotal > 0 && (
            <span className="hidden font-mono text-[10.5px] tabular-nums text-muted-foreground @sm:inline">
              CPU {summary.cpuTotal.toFixed(0)}% · MEM{" "}
              {formatBytes(summary.memUsed)} / {formatBytes(summary.memTotal)}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1.5 px-2 text-[11px] text-muted-foreground"
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
            <span className="hidden @md:inline">새로고침</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b border-border/60 bg-destructive/10 px-3 py-1.5 text-[11.5px] text-destructive">
          {error}
        </div>
      )}

      {/* column header */}
      <div
        className={cn(
          GRID,
          "shrink-0 border-b border-border/60 px-3 py-1.5",
          "text-[10.5px] font-medium text-muted-foreground"
        )}
      >
        <span className="text-right">PID</span>
        <span>Command</span>
        <span className="text-right">CPU</span>
        <span className="hidden text-right @lg:block">MEM</span>
        <span className="hidden @3xl:block">CWD</span>
        <span>Port</span>
        <span className="hidden @xl:block">세션</span>
        <span />
      </div>

      {/* rows */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {!loaded ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            프로세스를 읽는 중…
          </div>
        ) : shown === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-muted-foreground">
            {scopeTab ? (
              <>
                이 세션이 백그라운드에서
                <br />
                돌리는 프로세스가 없습니다.
              </>
            ) : (
              <>
                남아 있는 PTY 자식 프로세스나
                <br />
                포트를 점유한 dev server가 없습니다.
              </>
            )}
          </div>
        ) : (
          <>
            {owned.length > 0 && (
              <Group
                label={
                  <>
                    <NaruLogo className="size-3 opacity-80" />
                    세션
                  </>
                }
              >
                {owned.map((entry) => (
                  <Row
                    key={entry.pid}
                    entry={entry}
                    session={sessionTitle(entry.sessionId)}
                    onKill={() => setTarget(entry)}
                  />
                ))}
              </Group>
            )}
            {external.length > 0 && (
              <Group label="외부 · 포트 점유">
                {external.map((entry) => (
                  <Row
                    key={entry.pid}
                    entry={entry}
                    session={null}
                    onKill={() => setTarget(entry)}
                  />
                ))}
              </Group>
            )}
          </>
        )}
      </div>

      {/* confirm-kill dialog */}
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              프로세스 종료 — {target?.name}{" "}
              <span className="font-mono text-[12px] font-normal text-muted-foreground">
                (PID {target?.pid})
              </span>
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 pt-1">
                <div className="max-h-20 overflow-hidden break-all rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {target?.command}
                </div>
                <div className="text-[12.5px]">
                  {target?.isShell && (
                    <>
                      NARU 세션의 셸 프로세스입니다 — 해당 pane의 셸이
                      종료됩니다.{" "}
                    </>
                  )}
                  하위 프로세스 트리까지 함께 강제 종료됩니다.
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={killing}
              onClick={() => setTarget(null)}
            >
              취소
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={killing}
              onClick={() => void confirmKill()}
            >
              {killing ? "종료 중…" : "강제 종료"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Group({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-1.5 bg-muted/30 px-3 py-1 text-[10.5px] font-medium text-muted-foreground">
        {label}
      </div>
      <div className="divide-y divide-border/30">{children}</div>
    </section>
  );
}

function Row({
  entry,
  session,
  onKill,
}: {
  entry: ProcessEntry;
  session: string | null;
  onKill: () => void;
}) {
  return (
    <div
      className={cn(GRID, "px-3 py-[5px] transition-colors hover:bg-accent/40")}
    >
      <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {entry.pid}
      </span>
      <span
        className="truncate font-mono text-[11.5px]"
        title={entry.command}
      >
        <span className="text-foreground/90">{entry.name}</span>
        {entry.command !== entry.name && (
          <span className="text-muted-foreground"> {entry.command}</span>
        )}
      </span>
      <span
        className={cn(
          "text-right font-mono text-[11px] tabular-nums",
          entry.cpu >= 50
            ? "text-destructive"
            : entry.cpu >= 20
              ? "text-foreground/90"
              : "text-muted-foreground"
        )}
      >
        {entry.cpu.toFixed(entry.cpu >= 10 ? 0 : 1)}%
      </span>
      <span className="hidden text-right font-mono text-[11px] tabular-nums text-muted-foreground @lg:block">
        {formatBytes(entry.memory)}
      </span>
      <span
        className="hidden truncate font-mono text-[11px] text-muted-foreground @3xl:block"
        title={entry.cwd ?? undefined}
      >
        {entry.cwd ?? "—"}
      </span>
      <span
        className="truncate font-mono text-[11px]"
        title={
          entry.ports.length > 0
            ? entry.ports.map((p) => `:${p}`).join(" ")
            : undefined
        }
      >
        {entry.ports.length > 0 ? (
          <span className="text-primary">
            {entry.ports.map((p) => `:${p}`).join(" ")}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </span>
      <span
        className="hidden truncate text-[11px] text-muted-foreground @xl:block"
        title={session ?? undefined}
      >
        {session ? (entry.isShell ? `${session} (셸)` : session) : "외부"}
      </span>
      <button
        title="프로세스 종료"
        onClick={onKill}
        className="grid size-5 place-items-center justify-self-end rounded text-muted-foreground/50 transition-colors hover:bg-destructive/15 hover:text-destructive [&_svg]:size-3"
      >
        <X />
      </button>
    </div>
  );
}
