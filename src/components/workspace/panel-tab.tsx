import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { IDockviewPanelHeaderProps } from "dockview-react";

import { cn } from "@/lib/utils";
import {
  useStatusStore,
  isAttention,
  useStableRunning,
  type SessionStatus,
} from "@/store/status";
import type { PanelParams } from "./panels";

/**
 * Custom dockview tab: an ON/OFF status dot + title + close. Green = a
 * command/process is RUNNING (lit); idle & done read "off" (dim). Failure
 * (red) and agent-waiting (purple) keep their alert colors so the tab still
 * flags them, with a notification-ring pulse in the same color.
 */
const DOT_COLOR: Record<SessionStatus, string> = {
  running: "bg-ok", // green = ON (lit)
  error: "bg-t-red",
  waiting: "bg-wait",
  done: "bg-muted-foreground/40", // finished → off
  idle: "bg-muted-foreground/40", // off
};

export function PanelTab(props: IDockviewPanelHeaderProps<PanelParams>) {
  const id = props.api.id;
  const isBrowser = props.params?.kind === "browser";
  const status = useStatusStore((s) => s.statuses[id] ?? "idle");
  const acked = useStatusStore((s) => s.acked[id]);
  const attention = !isBrowser && isAttention(status) && acked !== status;
  // "On" = a command/process is actively running. Debounced so a resize/redraw
  // (sidebar toggle, adding a pane) — which makes the shell repaint its prompt,
  // a brief burst read as "running" — doesn't flicker the LED. An unconfirmed
  // running blip reads as the idle/off state for the dot.
  const runningStable = useStableRunning(!isBrowser && status === "running");
  const effective: SessionStatus =
    !isBrowser && status === "running" && !runningStable ? "idle" : status;
  const on = !isBrowser && effective === "running";
  const dotColor = isBrowser ? "bg-primary" : DOT_COLOR[effective];

  const [title, setTitle] = useState(props.api.title ?? "");
  useEffect(() => {
    setTitle(props.api.title ?? "");
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ""));
    return () => d.dispose();
  }, [props.api]);

  return (
    <div className="flex h-full items-center gap-2 px-2 text-xs">
      <span className="relative flex size-1.5 items-center justify-center">
        {attention && (
          <span
            className={cn(
              "absolute -inset-1 rounded-full opacity-35 blur-[2px]",
              dotColor
            )}
          />
        )}
        <span
          className={cn(
            "size-1.5 rounded-full transition-shadow",
            dotColor,
            on && "naru-tab-dot-on"
          )}
        />
      </span>
      <span
        className={cn(
          "max-w-[160px] truncate font-medium",
          !isBrowser && "font-mono"
        )}
      >
        {title || (isBrowser ? "Browser" : "shell")}
      </span>
      <button
        title="닫기"
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
        className="grid size-5 place-items-center rounded opacity-50 hover:bg-accent hover:opacity-100 [&_svg]:size-3.5"
      >
        <X />
      </button>
    </div>
  );
}
