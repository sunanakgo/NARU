import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Zap, X } from "lucide-react";

import { isTauriRuntime } from "@/lib/tauri";
import { sendNativeNotification } from "@/lib/notify";
import { useTriggers, type TriggerRule } from "@/store/triggers";
import { useWorkspace } from "@/store/workspace";

/**
 * Drives the user-defined trigger rules (PLAN §5 generalization). Two jobs,
 * no visible chrome of its own beyond a transient toast stack:
 *
 *  1. Push the rule set to the Rust `TriggerEngine` (which owns regex
 *     compilation + matching) whenever it changes, and feed back compile
 *     errors so the settings UI can flag a bad pattern inline.
 *  2. React to `naru://trigger` events the engine emits on a match — an OS
 *     notification when the user is away, plus an in-app toast so a focused
 *     user still sees it (OS banners are suppressed for the foreground app).
 */

interface TriggerError {
  id: string;
  error: string;
}

interface TriggerFired {
  ruleId: string;
  ruleName: string;
  sessionId: string;
  line: string;
  notify: boolean;
  sound: boolean;
  command: string | null;
}

interface Toast extends TriggerFired {
  key: number;
}

let toastSeq = 0;

export function TriggerManager() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Push rules → Rust (debounced); stash compile errors back in the store.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let timer: number | undefined;
    const push = (rules: TriggerRule[]) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void invoke<TriggerError[]>("set_triggers", { rules })
          .then((errs) => {
            const map: Record<string, string> = {};
            for (const e of errs) map[e.id] = e.error;
            useTriggers.getState().setErrors(map);
          })
          .catch(() => {});
      }, 200);
    };
    push(useTriggers.getState().rules);
    // Only re-push when the rules array changes — `setErrors` writes back into
    // the same store and must not loop us.
    const unsub = useTriggers.subscribe((s, prev) => {
      if (s.rules !== prev.rules) push(s.rules);
    });
    return () => {
      unsub();
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // React to matches.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const p = listen<TriggerFired>("naru://trigger", (e) => {
      const f = e.payload;
      if (f.notify) {
        void sendNativeNotification({
          title: `트리거 — ${f.ruleName}`,
          body: f.line,
          sound: f.sound ? "default" : undefined,
        });
      }
      const key = ++toastSeq;
      setToasts((cur) => [...cur, { ...f, key }].slice(-4));
      window.setTimeout(
        () => setToasts((cur) => cur.filter((t) => t.key !== key)),
        6000
      );
    });
    return () => void p.then((un) => un()).catch(() => {});
  }, []);

  const dismiss = (key: number) =>
    setToasts((cur) => cur.filter((t) => t.key !== key));

  // Clicking a toast jumps to the tab holding the pane that matched.
  const jump = (sessionId: string) => {
    const ws = useWorkspace.getState();
    const tab = ws.tabs.find((t) => t.panelIds.includes(sessionId));
    if (tab) ws.setActiveTab(tab.id);
  };

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.key}
          onClick={() => jump(t.sessionId)}
          className="animate-in fade-in slide-in-from-bottom-2 pointer-events-auto cursor-pointer rounded-lg border border-border bg-card/95 p-3 shadow-lg backdrop-blur"
        >
          <div className="flex items-center gap-2">
            <Zap className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">
              {t.ruleName}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.key);
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="닫기"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {t.line}
          </div>
          {t.command && (
            <div className="mt-1 truncate font-mono text-[11px] text-primary/80">
              ↵ {t.command}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
