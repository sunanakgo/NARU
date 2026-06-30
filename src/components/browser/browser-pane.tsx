import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Globe, Lock, RotateCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { Input } from "@/components/ui/input";
import { ToolButton } from "@/components/common/tool-button";
import { useOverlay } from "@/store/overlay";
import { isTauriRuntime } from "@/lib/tauri";

function normalizeBrowserInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

/**
 * Embedded browser pane (PLAN §5). A native Tauri child webview (real Chromium,
 * handles cross-origin sites) is positioned over this pane's content region.
 * We poll the host element's bounds and keep the webview synced; it's parked
 * off-screen whenever the pane is hidden (inactive tab/session) or a modal is
 * open. The URL bar + nav are normal DOM above the webview.
 */
interface BrowserPaneProps {
  panelId: string;
  url?: string;
  onNavigate: (url: string) => void;
}

export function BrowserPane(props: BrowserPaneProps) {
  // Runtime guard lives in a hook-free wrapper so the inner component's
  // hooks are unconditional (Rules of Hooks).
  if (!isTauriRuntime()) {
    return (
      <div className="flex h-full flex-col bg-card">
        <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border bg-pane-head pr-2 pl-2.5">
          <Globe className="size-4 text-muted-foreground" />
          <span className="truncate text-xs text-muted-foreground">
            Browser panes run inside the Tauri desktop app.
          </span>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Native webviews are unavailable in the standalone web preview.
        </div>
      </div>
    );
  }
  return <BrowserPaneImpl {...props} />;
}

function BrowserPaneImpl({ panelId, url, onNavigate }: BrowserPaneProps) {
  const label = `bw-${panelId}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const current = url ?? "http://localhost:3000";
  const [draft, setDraft] = useState(current);
  const history = useRef([current]);
  const historyIndex = useRef(0);
  const [nav, setNav] = useState({ canBack: false, canForward: false });

  const opened = useRef(false);
  const hidden = useRef(false);
  const lastBounds = useRef("");

  const syncNav = () =>
    setNav({
      canBack: historyIndex.current > 0,
      canForward: historyIndex.current < history.current.length - 1,
    });

  const pushHistory = (next: string) => {
    const idx = historyIndex.current;
    if (history.current[idx] === next) {
      syncNav();
      return;
    }
    const entries = history.current.slice(0, idx + 1);
    entries.push(next);
    history.current = entries.slice(-50);
    historyIndex.current = history.current.length - 1;
    syncNav();
  };

  useEffect(() => {
    setDraft(current);
    pushHistory(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Open + continuously sync the native webview to the host element's rect.
  useEffect(() => {
    const tick = () => {
      const el = hostRef.current;
      if (!el) return;
      // Cheap bail-out for hidden panes (inactive tab/session, backgrounded
      // window) before touching layout: skip the work but keep the webview
      // parked off-screen so it doesn't bleed through.
      if (
        document.visibilityState !== "visible" ||
        el.offsetParent === null ||
        el.offsetWidth === 0 ||
        el.offsetHeight === 0
      ) {
        if (opened.current && !hidden.current) {
          hidden.current = true;
          void invoke("browser_hide", { label }).catch(() => {});
        }
        return;
      }
      const r = el.getBoundingClientRect();
      // checkVisibility catches visibility:hidden too — inactive sessions are
      // hidden that way (layout preserved), so the rect alone stays non-zero.
      // (document visibility is already verified by the early bail-out above.)
      const visible =
        r.width > 1 &&
        r.height > 1 &&
        el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }) &&
        useOverlay.getState().count === 0;

      if (!visible) {
        if (opened.current && !hidden.current) {
          hidden.current = true;
          void invoke("browser_hide", { label }).catch(() => {});
        }
        return;
      }

      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (!opened.current) {
        opened.current = true;
        hidden.current = false;
        lastBounds.current = key;
        void invoke("browser_open", {
          label,
          url: current,
          bounds: {
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height,
          },
        }).catch(() => {});
      } else if (key !== lastBounds.current || hidden.current) {
        hidden.current = false;
        lastBounds.current = key;
        void invoke("browser_set_bounds", {
          label,
          bounds: {
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height,
          },
        }).catch(() => {});
      }
    };

    tick();
    const id = window.setInterval(tick, 120);
    return () => {
      window.clearInterval(id);
      void invoke("browser_close", { label }).catch(() => {});
    };
    // `current` intentionally excluded: navigation is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // Navigate the live webview when the URL changes.
  useEffect(() => {
    if (opened.current)
      void invoke("browser_navigate", { label, url: current }).catch(() => {});
  }, [label, current]);

  const go = (raw: string) => {
    const normalized = normalizeBrowserInput(raw);
    if (normalized) onNavigate(normalized);
  };

  const goHistory = (delta: -1 | 1) => {
    const next = historyIndex.current + delta;
    const target = history.current[next];
    if (!target) return;
    historyIndex.current = next;
    syncNav();
    setDraft(target);
    onNavigate(target);
  };

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border bg-pane-head pr-2 pl-2.5">
        <div className="flex gap-px">
          <ToolButton
            tip="Reload"
            size="icon-xs"
            onClick={() =>
              void invoke("browser_navigate", { label, url: current }).catch(
                () => {}
              )
            }
          >
            <RotateCw />
          </ToolButton>
          <ToolButton
            tip="Back"
            size="icon-xs"
            disabled={!nav.canBack}
            onClick={() => goHistory(-1)}
          >
            <ChevronLeft />
          </ToolButton>
          <ToolButton
            tip="Forward"
            size="icon-xs"
            disabled={!nav.canForward}
            onClick={() => goHistory(1)}
          >
            <ChevronRight />
          </ToolButton>
        </div>
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(draft);
          }}
        >
          <div className="flex h-6 items-center gap-1.5 rounded-full border border-input bg-background px-2.5">
            <Lock className="size-[11px] shrink-0 text-muted-foreground" />
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-auto flex-1 border-0 bg-transparent p-0 font-mono text-[11.5px] text-muted-foreground shadow-none focus-visible:ring-0"
            />
          </div>
        </form>
      </div>

      {/* The native webview is positioned over this region. */}
      <div
        ref={hostRef}
        className="relative min-h-0 flex-1 bg-card"
        data-browser-host={label}
      >
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Globe className="size-4" />
          {current}
        </div>
      </div>
    </div>
  );
}
