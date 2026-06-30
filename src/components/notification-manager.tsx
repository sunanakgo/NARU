import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onAction } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { sendNativeNotification } from "@/lib/notify";
import {
  useStatusStore,
  useWindowFocus,
  type SessionStatus,
} from "@/store/status";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { isTauriRuntime } from "@/lib/tauri";

let windowFocused = true;
let pendingFocus: { id: string; at: number } | null = null;
const PENDING_FOCUS_TTL_MS = 5 * 60_000;

function jumpToSession(id: string) {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.panelIds.includes(id));
  if (tab && tab.id !== ws.activeTabId) ws.setActiveTab(tab.id);
}

function focusMainWindow() {
  void invoke("focus_main_window").catch(() => {});
}

function notificationId(id: string, status: SessionStatus): number {
  let hash = 0x811c9dc5;
  const key = `${id}:${status}`;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1;
}

export function NotificationManager() {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload }) => {
      windowFocused = payload;
      useWindowFocus.setState({ focused: payload });
      if (payload && pendingFocus) {
        const { id, at } = pendingFocus;
        pendingFocus = null;
        if (Date.now() - at < PENDING_FOCUS_TTL_MS) jumpToSession(id);
      }
    });

    const unlistenAction = onAction((notification) => {
      const id = notification.extra?.naruSessionId;
      if (typeof id === "string") {
        pendingFocus = null;
        jumpToSession(id);
      }
      focusMainWindow();
    });

    let prev = useStatusStore.getState().statuses;
    const unsub = useStatusStore.subscribe((state) => {
      const cur = state.statuses;
      for (const [id, status] of Object.entries(cur)) {
        if (prev[id] === status) continue;
        void notifyIfUnattended(id, status, prev[id]);
      }
      for (const id of notifiedAttention.keys()) {
        if (!(id in cur)) notifiedAttention.delete(id);
      }
      prev = cur;
    });

    return () => {
      unsub();
      void unlistenFocus.then((un) => un());
      void unlistenAction.then((un) => un.unregister());
    };
  }, []);

  return null;
}

const BODY: Partial<Record<SessionStatus, string>> = {
  waiting: "에이전트가 입력을 기다리고 있습니다.",
  error: "명령이 실패했습니다.",
  done: "작업이 완료되었습니다.",
};

const notifiedAttention = new Map<string, SessionStatus>();

async function notifyIfUnattended(
  id: string,
  status: SessionStatus,
  prevStatus: SessionStatus | undefined
) {
  if (status === "idle" || status === "running") {
    notifiedAttention.delete(id);
    return;
  }

  const s = useSettings.getState();
  if (!s.notificationsEnabled) return;

  const enabled =
    (status === "waiting" && s.notifyWaiting) ||
    (status === "error" && s.notifyError) ||
    (status === "done" && s.notifyDone);
  if (!enabled) return;

  if (status === "waiting" && prevStatus !== "running") return;
  if (status === "done" && prevStatus !== "running") return;

  try {
    windowFocused = await getCurrentWindow().isFocused();
    useWindowFocus.setState({ focused: windowFocused });
  } catch {
    // Keep the most recent native focus event value.
  }

  // OS notifications should only interrupt when the user is in another app.
  if (windowFocused) return;

  if (notifiedAttention.get(id) === status) return;
  notifiedAttention.set(id, status);

  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.panelIds.includes(id));
  pendingFocus = { id, at: Date.now() };

  void sendNativeNotification({
    id: notificationId(id, status),
    title: `NARU - ${tab?.title ?? "session"}`,
    body: BODY[status] ?? "",
    sound: s.notifySound ? "default" : undefined,
    extra: { naruSessionId: id, naruStatus: status },
  });
}
