import { invoke } from "@tauri-apps/api/core";

/**
 * Native OS notifications via the Rust plugin commands DIRECTLY.
 *
 * The @tauri-apps/plugin-notification JS wrapper routes everything through
 * `window.Notification` — and WebView2 reports that web-API permission as
 * "denied", so `isPermissionGranted()` returns false and `sendNotification`
 * silently no-ops. Every NARU notification on Windows was dropped this way.
 * The Rust-side commands check the plugin's own (granted) permission state
 * and show a real WinRT/NSUserNotification toast.
 */

let granted: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  // Only a positive result is cached — a transient invoke failure (page
  // mid-reload, IPC hiccup) must not poison the cache and permanently
  // silence every future notification.
  if (granted === true) return true;
  try {
    let ok = await invoke<boolean>("plugin:notification|is_permission_granted");
    if (!ok) {
      const p = await invoke<string>("plugin:notification|request_permission");
      ok = p === "granted";
    }
    granted = ok ? true : null;
    return ok;
  } catch {
    granted = null;
    return false;
  }
}

export interface NativeNotification {
  id?: number;
  title: string;
  body?: string;
  sound?: string;
  extra?: Record<string, unknown>;
}

export async function sendNativeNotification(
  options: NativeNotification
): Promise<void> {
  if (!(await ensurePermission())) return;
  await invoke("plugin:notification|notify", { options }).catch(() => {});
}
