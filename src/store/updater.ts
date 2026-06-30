import { create } from "zustand";

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { isTauriRuntime } from "@/lib/tauri";

/**
 * Self-update lifecycle, backed directly by the Tauri updater plugin. The repo
 * is public, so release assets download without auth — the plugin reads the
 * endpoint + signing pubkey from tauri.conf.json and verifies the bundle
 * signature itself. On startup (and every 6h) we poll for a newer release; a
 * hit reveals the titlebar download button.
 *
 *   idle         → no update known
 *   checking     → querying GitHub Releases
 *   available    → a newer release exists; titlebar shows the download button
 *   downloading  → bundle streaming (`progress` is 0..1, or null if unknown)
 *   installing   → download done, swapping in the new bundle (relaunch imminent)
 *   error        → check/download/install failed
 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

interface UpdaterState {
  phase: UpdatePhase;
  version: string | null;
  progress: number | null;
  error: string | null;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
}

// The Update handle returned by check() must survive until install. It's not
// serializable, so it lives here rather than in the store.
let pending: Update | null = null;

export const useUpdater = create<UpdaterState>((set, get) => ({
  phase: "idle",
  version: null,
  progress: null,
  error: null,

  checkForUpdate: async () => {
    if (!isTauriRuntime()) return;
    const phase = get().phase;
    if (phase === "checking" || phase === "downloading" || phase === "installing") {
      return;
    }
    set({ phase: "checking", error: null });
    try {
      const update = await check();
      if (update) {
        pending = update;
        set({ phase: "available", version: update.version });
      } else {
        pending = null;
        set({ phase: "idle", version: null });
      }
    } catch (e) {
      // A failed background check shouldn't nag — log and stay quiet.
      console.error("[updater] check failed", e);
      set({ phase: "idle" });
    }
  },

  downloadAndInstall: async () => {
    if (!pending) {
      set({ phase: "error", error: "설치할 업데이트가 없습니다." });
      return;
    }
    set({ phase: "downloading", progress: null, error: null });
    try {
      let downloaded = 0;
      let total = 0;
      await pending.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            set({ progress: total > 0 ? downloaded / total : null });
            break;
          case "Finished":
            set({ phase: "installing", progress: 1 });
            break;
        }
      });
      // Download + install done; relaunch into the new version (never returns
      // on success — the process is replaced).
      set({ phase: "installing", progress: 1 });
      await relaunch();
    } catch (e) {
      console.error("[updater] install failed", e);
      set({
        phase: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
