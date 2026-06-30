import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { AgentCli } from "@/store/settings";
import type { SessionStatus } from "@/store/status";

/** Result of the Rust `session_info` command (PLAN §3). */
export interface SessionInfo {
  cwd: string | null;
  brand: string; // claude | opencode | codex | gemini | aider | shell
  branch: string | null;
  added: number;
  removed: number;
  ports: number[];
  /** Descendant process count under the session's shell (badge source). */
  procs: number;
}

const OPTIMISTIC_BRAND_MS = 10_000;

interface BrandOverride {
  brand: AgentCli;
  expiresAt: number;
}

interface SessionInfoState {
  optimisticBrands: Record<string, BrandOverride>;
  setOptimisticBrand: (panelId: string, brand: AgentCli) => void;
  clearOptimisticBrand: (panelId: string) => void;
}

const useSessionInfoState = create<SessionInfoState>((set) => ({
  optimisticBrands: {},
  setOptimisticBrand: (panelId, brand) => {
    const expiresAt = Date.now() + OPTIMISTIC_BRAND_MS;
    set((s) => ({
      optimisticBrands: {
        ...s.optimisticBrands,
        [panelId]: { brand, expiresAt },
      },
    }));
    window.setTimeout(() => {
      set((s) => {
        if (s.optimisticBrands[panelId]?.expiresAt !== expiresAt) return s;
        const next = { ...s.optimisticBrands };
        delete next[panelId];
        return { optimisticBrands: next };
      });
    }, OPTIMISTIC_BRAND_MS);
  },
  clearOptimisticBrand: (panelId) =>
    set((s) => {
      if (!(panelId in s.optimisticBrands)) return s;
      const next = { ...s.optimisticBrands };
      delete next[panelId];
      return { optimisticBrands: next };
    }),
}));

export const setOptimisticSessionBrand = (panelId: string, brand: AgentCli) =>
  useSessionInfoState.getState().setOptimisticBrand(panelId, brand);

export const clearOptimisticSessionBrand = (panelId: string) =>
  useSessionInfoState.getState().clearOptimisticBrand(panelId);

/**
 * Dev-server URL for a session: the first port its process tree is LISTENING
 * on (e.g. a running vite/next server), falling back to localhost:3000.
 * Used by the globe "open browser" buttons.
 */
export async function sessionDevUrl(
  panelId: string | undefined
): Promise<string> {
  if (panelId) {
    try {
      const info = await invoke<SessionInfo>("session_info", { id: panelId });
      if (info.ports.length > 0) {
        return `http://localhost:${info.ports[0]}`;
      }
    } catch {
      /* session may not exist yet — fall through to the default */
    }
  }
  return "http://localhost:3000";
}

// ── shared pollers ────────────────────────────────────────────────────────────
// `session_info` is EXPENSIVE backend-side (full process scan + netstat +
// git). Many components watch the same panel (sidebar row, terminal pane,
// input bar, titlebar…) — each used to run its own 4s interval, multiplying
// that cost and causing background CPU churn (visible as window-drag jank).
// Now: ONE refcounted poller per panel id; results fan out via a store.

const useInfoCache = create<{ infos: Record<string, SessionInfo | null> }>(
  () => ({ infos: {} })
);

interface SharedPoll {
  refs: number;
  timer: number;
  unlisteners: UnlistenFn[];
  poll: () => Promise<void>;
  disposed: boolean;
  /**
   * Monotonic token. A fast unsubscribe/re-subscribe replaces the poll object
   * for a panel id while a previous `listen()` promise is still in flight; the
   * stale resolution compares its captured epoch and disposes itself instead of
   * attaching its unlisten to (or firing into) the live poll.
   */
  epoch: number;
}

const polls = new Map<string, SharedPoll>();
let pollEpoch = 0;

function publishSessionInfo(panelId: string, info: SessionInfo) {
  useInfoCache.setState((s) => {
    const prev = s.infos[panelId];
    if (prev && JSON.stringify(prev) === JSON.stringify(info)) return s;
    return { infos: { ...s.infos, [panelId]: info } };
  });
  if (info.brand !== "shell") clearOptimisticSessionBrand(panelId);
}

export async function refreshSessionInfo(panelId: string): Promise<void> {
  const shared = polls.get(panelId);
  if (shared) {
    await shared.poll();
    return;
  }
  try {
    publishSessionInfo(
      panelId,
      await invoke<SessionInfo>("session_info", { id: panelId })
    );
  } catch {
    /* session may not exist yet */
  }
}

function startPoll(panelId: string): SharedPoll {
  const epoch = ++pollEpoch;
  const shared: SharedPoll = {
    refs: 0,
    timer: 0,
    unlisteners: [],
    poll: async () => {},
    disposed: false,
    epoch,
  };
  const poll = async () => {
    // No point scanning processes while the window is minimized/hidden.
    if (document.visibilityState === "hidden") return;
    try {
      const r = await invoke<SessionInfo>("session_info", { id: panelId });
      if (shared.disposed) return;
      useInfoCache.setState((s) => {
        // The poll returns a FRESH object every 4s even when nothing changed
        // (the common case: idle shell, same branch/diff). Publishing it
        // as-is would re-render every subscriber of this panel (sidebar row,
        // input bar, titlebar…) on every tick — keep the old reference when
        // the payload is identical. These objects are tiny; JSON compare is
        // cheaper than the render cascade it prevents.
        const prev = s.infos[panelId];
        if (prev && JSON.stringify(prev) === JSON.stringify(r)) return s;
        return { infos: { ...s.infos, [panelId]: r } };
      });
      if (r.brand !== "shell") {
        useSessionInfoState.getState().clearOptimisticBrand(panelId);
      }
    } catch {
      /* session may not exist yet */
    }
  };
  shared.poll = poll;
  void poll();
  shared.timer = window.setInterval(() => void poll(), 4000);

  const attachUnlistener = (un: UnlistenFn) => {
    if (shared.disposed || polls.get(panelId)?.epoch !== epoch) un();
    else shared.unlisteners.push(un);
  };

  // `cd` pushes pty://cwd/<id> from the backend the moment OSC 7 lands —
  // apply the new cwd instantly, then poll for the rest (branch, diff…).
  void listen<string>(`pty://cwd/${panelId}`, (e) => {
    if (shared.disposed) return;
    useInfoCache.setState((s) => {
      const prev = s.infos[panelId];
      return prev
        ? { infos: { ...s.infos, [panelId]: { ...prev, cwd: e.payload } } }
        : s;
    });
    void poll();
  }).then(attachUnlistener);
  void listen<SessionStatus>(`pty://status/${panelId}`, (e) => {
    if (shared.disposed) return;
    if (e.payload !== "running") {
      clearOptimisticSessionBrand(panelId);
      void poll();
    }
  }).then(attachUnlistener);
  void listen(`pty://exit/${panelId}`, () => {
    if (shared.disposed) return;
    clearOptimisticSessionBrand(panelId);
    useInfoCache.setState((s) => {
      if (!(panelId in s.infos)) return s;
      const infos = { ...s.infos };
      delete infos[panelId];
      return { infos };
    });
  }).then(attachUnlistener);
  return shared;
}

/**
 * Per-session cwd / agent brand / git branch + diff for one panel (a
 * session's shell PTY id). Subscribers share one backend poller per panel;
 * `enabled: false` releases this subscriber's hold (polling stops when no
 * one holds it). The last known info stays cached for instant re-renders.
 */
export function useSessionInfo(
  panelId: string | undefined,
  enabled = true
): SessionInfo | null {
  const info = useInfoCache((s) =>
    panelId ? (s.infos[panelId] ?? null) : null
  );
  const optimisticBrand = useSessionInfoState((s) =>
    panelId ? s.optimisticBrands[panelId] : undefined
  );

  useEffect(() => {
    if (!panelId || !enabled) return;
    let shared = polls.get(panelId);
    if (!shared) {
      shared = startPoll(panelId);
      polls.set(panelId, shared);
    }
    shared.refs++;
    return () => {
      shared.refs--;
      if (shared.refs <= 0) {
        shared.disposed = true;
        window.clearInterval(shared.timer);
        shared.unlisteners.forEach((un) => un());
        polls.delete(panelId);
        // Prune the cached info so it can't leak forever for dead panels.
        useInfoCache.setState((s) => {
          if (!(panelId in s.infos)) return s;
          const infos = { ...s.infos };
          delete infos[panelId];
          return { infos };
        });
      }
    };
  }, [panelId, enabled]);

  if (
    info &&
    info.brand === "shell" &&
    optimisticBrand &&
    optimisticBrand.expiresAt > Date.now()
  ) {
    return { ...info, brand: optimisticBrand.brand };
  }

  return info;
}
