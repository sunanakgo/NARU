import { useEffect } from "react";
import type { IDockviewPanelProps } from "dockview-react";

import { cn } from "@/lib/utils";
import { TerminalPane } from "@/components/pane/terminal-pane";
import { BrowserPane } from "@/components/browser/browser-pane";
import { ProcessMonitorPane } from "@/components/procmon/process-monitor-pane";
import { RunbookPane } from "@/components/pane/runbook-pane";
import { ReplayPane } from "@/components/pane/replay-pane";
import { NotificationRing } from "@/components/pane/notification-ring";
import { isAttention, useStatusStore, useWindowFocus } from "@/store/status";
import { useWorkspace, type PaneKind } from "@/store/workspace";

export interface PanelParams {
  kind: PaneKind;
  url?: string;
  /** Sibling PTY id whose current cwd a new terminal should start in. */
  inheritFrom?: string;
  /** Command auto-run on a new terminal (e.g. an SSH connect). */
  startupCommand?: string;
  /** Initial runbook to open (runbook panes). */
  runbookId?: string;
  /** Tab to scope a Process Monitor pane to (show only that session's tree). */
  scopeTabId?: string;
}

function PanelBody({
  id,
  browser,
  children,
}: {
  id: string;
  browser?: boolean;
  children: React.ReactNode;
}) {
  const status = useStatusStore((s) => s.statuses[id] ?? "idle");
  const acked = useStatusStore((s) => s.acked[id]);
  const attention = isAttention(status) && acked !== status;

  // cmux unread model: looking at the pane (its tab active + native window
  // focused) for a beat acknowledges the state — the ring stops pulling
  // attention without erasing the status itself.
  const tabActive = useWorkspace((s) => {
    const tab = s.tabs.find((t) => t.panelIds.includes(id));
    return tab?.id === s.activeTabId;
  });
  const winFocused = useWindowFocus((s) => s.focused);
  useEffect(() => {
    if (!attention || !tabActive || !winFocused) return;
    const t = window.setTimeout(
      () => useStatusStore.getState().ack(id),
      1500
    );
    return () => window.clearTimeout(t);
  }, [attention, tabActive, winFocused, id, status]);

  return (
    <div className={cn("relative h-full w-full", browser ? "bg-card" : "bg-term-bg")}>
      {children}
      <NotificationRing status={status} attention={attention} />
    </div>
  );
}

function TerminalPanel(props: IDockviewPanelProps<PanelParams>) {
  const id = props.api.id;
  return (
    <PanelBody id={id}>
      <div className="h-full w-full px-3 py-2">
        <TerminalPane
          sessionId={id}
          inheritFrom={props.params.inheritFrom}
          startupCommand={props.params.startupCommand}
        />
      </div>
    </PanelBody>
  );
}

function BrowserPanel(props: IDockviewPanelProps<PanelParams>) {
  const id = props.api.id;
  return (
    <PanelBody id={id} browser>
      <BrowserPane
        panelId={id}
        url={props.params.url}
        onNavigate={(url) =>
          props.api.updateParameters({ kind: "browser", url })
        }
      />
    </PanelBody>
  );
}

function ProcMonitorPanel(props: IDockviewPanelProps<PanelParams>) {
  return <ProcessMonitorPane scopeTabId={props.params.scopeTabId} />;
}

function RunbookPanel(props: IDockviewPanelProps<PanelParams>) {
  return <RunbookPane initialRunbookId={props.params.runbookId} />;
}

function ReplayPanel() {
  return <ReplayPane />;
}

/** dockview component registry (panel `component` name → React component). */
export const panelComponents = {
  terminal: TerminalPanel,
  browser: BrowserPanel,
  procmon: ProcMonitorPanel,
  runbook: RunbookPanel,
  replay: ReplayPanel,
};
