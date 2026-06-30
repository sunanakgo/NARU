import { invoke } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";

import { isTauriRuntime } from "@/lib/tauri";

/**
 * Disk-backed storage for zustand `persist` (replaces localStorage).
 *
 * WHY: WebView2 flushes localStorage lazily — a hard kill (Ctrl+C on
 * `tauri dev`, crash) loses everything since the last flush, resetting
 * tabs/settings between dev runs. Values live in app_data/kv/*.json via the
 * Rust kv commands instead.
 *
 * `preloadKvStorage()` MUST resolve before any store module is imported
 * (main.tsx dynamic-imports App after it) so `getItem` is synchronous from
 * the in-memory cache and hydration needs no async gate. Writes go through
 * the cache immediately and flush to disk debounced per key.
 */

const cache = new Map<string, string>();
const timers = new Map<string, number>();
// Latest debounced value per key, so a flush-on-quit fires the newest write.
const pending = new Map<string, string>();
// Canary for the import-order invariant the whole design rests on: a store
// hydrating before the preload would read defaults and then overwrite good
// kv data on its first write.
let preloaded = false;

// Version-renamed store keys (e.g. theme v2 → v3) leave their old files in
// the kv dir forever — clean up the known retired names after migration.
const RETIRED_KEYS = [
  "naru-theme",
  "naru-theme-v1",
  "naru-theme-v2",
  "naru-workspace",
  "naru-workspace-v1",
];

// Rate-limited warn so a persistently failing backend stays diagnosable
// without spamming the console on every keystroke.
let lastWarnAt = 0;
// Consecutive kv_set failures — past the threshold the user is silently
// losing every settings/layout change since the first failure (disk full,
// kv dir unwritable), so surface it once via a native notification.
let setFailStreak = 0;
let lossNotified = false;
function noteSetFailure() {
  setFailStreak += 1;
  if (setFailStreak < 3 || lossNotified) return;
  lossNotified = true;
  void import("@/lib/notify")
    .then(({ sendNativeNotification }) =>
      sendNativeNotification({
        title: "NARU",
        body: "설정/탭 저장에 계속 실패하고 있습니다 — 디스크 공간과 권한을 확인하세요.",
      })
    )
    .catch(() => {});
}
function warnKv(label: string, err: unknown) {
  if (label === "kv_set") noteSetFailure();
  const now = Date.now();
  if (now - lastWarnAt < 30_000) return;
  lastWarnAt = now;
  console.warn(`[kv-storage] ${label} failed`, err);
}

export async function preloadKvStorage(): Promise<void> {
  if (!isTauriRuntime()) {
    preloaded = true;
    return; // web preview → plain localStorage below
  }
  try {
    const all = await invoke<Record<string, string>>("kv_load");
    for (const [k, v] of Object.entries(all)) cache.set(k, v);
  } catch (e) {
    /* first run / command unavailable — start empty */
    warnKv("kv_load", e);
  }
  // One-time migration: carry over any existing localStorage state that
  // hasn't made it to disk yet (pre-kv builds). localStorage can throw in
  // privacy/sandboxed contexts, so guard the whole loop.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("naru-") || cache.has(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) {
        cache.set(key, value);
        void invoke("kv_set", { key, value }).catch((e) => warnKv("kv_set", e));
      }
    }
  } catch (e) {
    warnKv("localStorage migration", e);
  }
  // Drop retired version-renamed keys (and their lingering disk files).
  for (const key of RETIRED_KEYS) {
    if (!cache.has(key)) continue;
    cache.delete(key);
    void invoke("kv_delete", { key }).catch((e) => warnKv("kv_delete", e));
    try {
      localStorage.removeItem(key);
    } catch {
      /* localStorage unavailable */
    }
  }
  preloaded = true;
}

function flush(key: string, value: string) {
  const t = timers.get(key);
  if (t !== undefined) window.clearTimeout(t);
  pending.set(key, value);
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      pending.delete(key);
      void invoke("kv_set", { key, value })
        .then(() => {
          setFailStreak = 0; // a success resets the loss alarm
        })
        .catch((e) => warnKv("kv_set", e));
    }, 150)
  );
}

/**
 * Synchronously fire every pending debounced write so nothing is lost on quit.
 * `invoke` is async, but calling it here queues the IPC message before the
 * window tears down. Fire-and-forget — there's no time to await on unload.
 */
export function flushKvStorage(): void {
  if (!isTauriRuntime()) return;
  for (const [key, value] of pending) {
    const t = timers.get(key);
    if (t !== undefined) window.clearTimeout(t);
    timers.delete(key);
    void invoke("kv_set", { key, value }).catch((e) => warnKv("kv_set", e));
  }
  pending.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => flushKvStorage());
}

export const kvStorage: StateStorage = {
  getItem: (key) => {
    if (!isTauriRuntime()) return localStorage.getItem(key);
    if (!preloaded) {
      // Invariant violation — a store module was imported before
      // preloadKvStorage resolved; it will hydrate to defaults and clobber
      // persisted state on its first write. Fail loudly in the console.
      console.error(
        `[kv-storage] getItem("${key}") before preload — check main.tsx import order`
      );
    }
    return cache.get(key) ?? null;
  },
  setItem: (key, value) => {
    if (!isTauriRuntime()) {
      localStorage.setItem(key, value);
      return;
    }
    cache.set(key, value);
    flush(key, value);
  },
  removeItem: (key) => {
    if (!isTauriRuntime()) {
      localStorage.removeItem(key);
      return;
    }
    cache.delete(key);
    pending.delete(key);
    const t = timers.get(key);
    if (t !== undefined) {
      window.clearTimeout(t);
      timers.delete(key);
    }
    void invoke("kv_delete", { key }).catch((e) => warnKv("kv_delete", e));
  },
};
