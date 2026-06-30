import { useEffect, useState } from "react";
import { create } from "zustand";

/**
 * Per-session agent status (PLAN §5). Fed by `pty://status/{id}` events that
 * the Rust StatusEngine emits; consumed by notification rings, sidebar dots
 * and the OS-notification effect.
 */
export type SessionStatus =
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "error";

interface StatusState {
  statuses: Record<string, SessionStatus>;
  /**
   * cmux-style unread model: `acked[id]` is the last attention status the
   * user has SEEN (pane focused while its tab was active). An indicator only
   * pulls attention while `statuses[id]` is attention-worthy AND differs
   * from `acked[id]` — looking at a pane clears its ring/badge without
   * erasing the underlying status.
   */
  acked: Record<string, SessionStatus>;
  setStatus: (id: string, status: SessionStatus) => void;
  ack: (id: string) => void;
  clear: (id: string) => void;
  /**
   * Remove any `statuses`/`acked` entries whose id is NOT in `liveIds`.
   * Per-pane teardown calls `clear(id)`, but a pane that never unmounts cleanly
   * (crash, lost dockview disposal) would leak an entry forever — call this with
   * the current live panel ids to garbage-collect the survivors.
   */
  pruneExcept: (liveIds: string[]) => void;
}

export const useStatusStore = create<StatusState>((set) => ({
  statuses: {},
  acked: {},
  setStatus: (id, status) =>
    set((s) =>
      s.statuses[id] === status
        ? s
        : { statuses: { ...s.statuses, [id]: status } }
    ),
  ack: (id) =>
    set((s) => {
      const status = s.statuses[id];
      if (!status || s.acked[id] === status) return s;
      return { acked: { ...s.acked, [id]: status } };
    }),
  clear: (id) =>
    set((s) => {
      if (!(id in s.statuses) && !(id in s.acked)) return s;
      const statuses = { ...s.statuses };
      const acked = { ...s.acked };
      delete statuses[id];
      delete acked[id];
      return { statuses, acked };
    }),
  pruneExcept: (liveIds) =>
    set((s) => {
      const live = new Set(liveIds);
      const statuses: Record<string, SessionStatus> = {};
      const acked: Record<string, SessionStatus> = {};
      let changed = false;
      for (const [id, v] of Object.entries(s.statuses)) {
        if (live.has(id)) statuses[id] = v;
        else changed = true;
      }
      for (const [id, v] of Object.entries(s.acked)) {
        if (live.has(id)) acked[id] = v;
        else changed = true;
      }
      return changed ? { statuses, acked } : s;
    }),
}));

// Dev-only E2E hook: lets smoke probes (scripts/smoke-real.mjs) read the
// live status map — there is no DOM representation of raw statuses.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __naruStatusStore?: unknown }).__naruStatusStore =
    useStatusStore;
}

/** Window (native) focus — set by NotificationManager's Tauri focus events.
 * document.hasFocus() is NOT trusted (a webview element can hold DOM focus
 * while the native window is in the background). */
export const useWindowFocus = create<{ focused: boolean }>(() => ({
  focused: true,
}));

/** Priority for rolling many pane statuses up to a single tab indicator. */
const PRIORITY: Record<SessionStatus, number> = {
  error: 5,
  waiting: 4,
  running: 3,
  done: 2,
  idle: 1,
};

/** Aggregate a set of pane statuses into the most attention-worthy one. */
export function aggregateStatus(
  ids: string[],
  statuses: Record<string, SessionStatus>
): SessionStatus {
  let best: SessionStatus = "idle";
  for (const id of ids) {
    const s = statuses[id] ?? "idle";
    if (PRIORITY[s] > PRIORITY[best]) best = s;
  }
  return best;
}

/** Whether a status should pull the user's attention (ring / badge / notify).
 * `done` is included (agent finished an answer — cmux treats completion as
 * unread-until-seen); the ack model clears it the moment the user looks. */
export function isAttention(status: SessionStatus): boolean {
  return status === "waiting" || status === "error" || status === "done";
}

/** Any pane in `ids` holding an attention status the user hasn't seen yet. */
export function hasUnackedAttention(
  ids: string[],
  statuses: Record<string, SessionStatus>,
  acked: Record<string, SessionStatus>
): boolean {
  return ids.some((id) => {
    const s = statuses[id] ?? "idle";
    return isAttention(s) && acked[id] !== s;
  });
}

export const STATUS_COLOR: Record<SessionStatus, string> = {
  idle: "bg-muted-foreground/50",
  running: "bg-run",
  waiting: "bg-wait",
  done: "bg-ok",
  error: "bg-t-red",
};

/**
 * Leading-edge debounce for the "running" state. A resize (sidebar
 * collapse/expand, adding a pane, window resize) makes the shell repaint its
 * prompt — a brief output burst the StatusEngine reads as `running` before the
 * prompt marker settles it back to idle. Status dots that follow `running`
 * raw therefore flicker on every benign layout change.
 *
 * Returns `true` only once `running` has stayed true for `delay` ms, and drops
 * to `false` the instant it ends — so a quick blip never lights the indicator,
 * but a genuinely running command (which lasts well past `delay`) still does.
 */
export function useStableRunning(running: boolean, delay = 400): boolean {
  const [stable, setStable] = useState(false);
  useEffect(() => {
    if (!running) {
      setStable(false);
      return;
    }
    const t = window.setTimeout(() => setStable(true), delay);
    return () => window.clearTimeout(t);
  }, [running, delay]);
  return stable;
}

