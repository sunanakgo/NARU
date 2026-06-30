import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

import { buildTerminalTheme } from "@/terminal/theme";
import { registerTerminal, unregisterTerminal } from "@/terminal/registry";
import { feedRecording, stopRecording } from "@/terminal/recorder";
import { useRecordings } from "@/store/recordings";
import { useWorkspace } from "@/store/workspace";
import {
  registerPathLinks,
  registerUrlLinks,
  registerLinkContextMenu,
} from "@/terminal/path-links";
import { InputBar } from "@/components/pane/input-bar";
import { TerminalSearch } from "@/components/pane/terminal-search";
import { useStatusStore, type SessionStatus } from "@/store/status";
import { useSessionInfo } from "@/store/session-info";
import { useTheme } from "@/store/theme";
import { useSettings } from "@/store/settings";
import { useSidebarUI } from "@/store/ui";
import { isTauriRuntime } from "@/lib/tauri";

let seq = 0;

interface TerminalPaneProps {
  /** Optional stable session id; defaults to a fresh per-instance id. */
  sessionId?: string;
  /** Sibling PTY id whose current cwd this shell should start in. */
  inheritFrom?: string;
  /** Command auto-run once the shell is ready (e.g. an `ssh` connect). */
  startupCommand?: string;
}

/**
 * A single terminal pane: an xterm.js grid (WebGL-rendered) bound to one
 * Rust-side PTY session over Tauri IPC.
 *
 * PLAN §2: the text grid is drawn by xterm/WebGL; everything *around* it
 * (chrome, blocks, notification rings) will be React/DOM on top.
 */
export function TerminalPane(props: TerminalPaneProps) {
  // Runtime guard lives in a hook-free wrapper so the inner component's
  // hooks are unconditional (Rules of Hooks).
  if (!isTauriRuntime()) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-term-bg px-6 text-center text-sm text-muted-foreground">
        Terminal panes run inside the Tauri desktop app.
      </div>
    );
  }
  return <TerminalPaneImpl {...props} />;
}

function TerminalPaneImpl({
  sessionId,
  inheritFrom,
  startupCommand,
}: TerminalPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const rendererRef = useRef<CanvasAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingSidebarFitRef = useRef(false);
  // In-terminal search overlay (Ctrl/⌘+F): prefilled with the grid selection.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInitial = useRef("");
  // PTY id is needed during render (input bar) — stable per instance.
  const [id] = useState(() => sessionId ?? `pane-${seq++}`);
  const recording = useRecordings((s) => s.active[id] ?? false);
  // Whether this pane's session is the active tab (drives the on-activate
  // renderer heal below).
  const isActive = useWorkspace((s) => {
    const tab = s.tabs.find((t) => t.panelIds.includes(id));
    return tab ? tab.id === s.activeTabId : true;
  });

  // When a backgrounded pane becomes the active tab again, the renderer can be
  // left with a stale glyph atlas / cell geometry — symptom: garbled letter
  // spacing and leftover gray bands after splitting/resizing elsewhere. Rebuild
  // the atlas and refit on activation (no-op when dims are unchanged).
  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        rendererRef.current?.clearTextureAtlas();
      } catch {
        /* renderer disposed */
      }
      if (containerRef.current?.offsetWidth) {
        const { cols, rows } = term;
        try {
          fitPreservingScroll();
        } catch {
          /* not laid out yet */
        }
        if (term.cols !== cols || term.rows !== rows) {
          void invoke("pty_resize", {
            id,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {});
        }
      }
      term.refresh(0, term.rows - 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, id]);
  // Alt-screen TUIs (claude/vim) own the whole grid — hide the input bar.
  const [altScreen, setAltScreen] = useState(false);
  const altRef = useRef(false);
  const theme = useTheme((s) => s.theme);
  const presetId = useTheme((s) => s.presetId);
  const fontFamily = useSettings((s) => s.fontFamily);
  const fontSize = useSettings((s) => s.fontSize);
  const cursorStyle = useSettings((s) => s.cursorStyle);
  const cursorBlink = useSettings((s) => s.cursorBlink);
  const scrollback = useSettings((s) => s.scrollback);
  const inputBar = useSettings((s) => s.inputBar);
  const sidebarLayoutRevision = useSidebarUI((s) => s.layoutRevision);
  const info = useSessionInfo(id);
  const agentAltScreen =
    altScreen &&
    inputBar &&
    (info?.brand === "claude" ||
      info?.brand === "codex" ||
      info?.brand === "opencode");
  const inputBarRef = useRef(inputBar);
  const agentAltScreenRef = useRef(false);
  useEffect(() => {
    inputBarRef.current = inputBar;
  }, [inputBar]);
  useEffect(() => {
    agentAltScreenRef.current = agentAltScreen;
    if (agentAltScreen) inputRef.current?.focus();
  }, [agentAltScreen]);

  const fitPreservingScroll = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const before = term.buffer.active;
    const viewportY = before.viewportY;
    const wasAtBottom = before.viewportY >= before.baseY;
    fit.fit();
    if (wasAtBottom) {
      term.scrollToBottom();
    } else {
      term.scrollToLine(Math.min(viewportY, term.buffer.active.baseY));
    }
  };

  const fitAndResizePty = () => {
    const term = termRef.current;
    const container = containerRef.current;
    if (!term || !container?.offsetWidth || !container.offsetHeight) return null;
    const { cols, rows } = term;
    fitPreservingScroll();
    if (term.cols !== cols || term.rows !== rows) {
      void invoke("pty_resize", { id, cols: term.cols, rows: term.rows }).catch(
        () => {}
      );
    }
    return term;
  };

  useEffect(() => {
    if (!pendingSidebarFitRef.current) return;
    pendingSidebarFitRef.current = false;
    const raf = requestAnimationFrame(() => {
      const term = fitAndResizePty();
      if (term) term.refresh(0, term.rows - 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [sidebarLayoutRevision, id]);

  // Live-apply terminal typography/cursor settings.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.scrollback = scrollback;
    fitPreservingScroll();
  }, [fontFamily, fontSize, cursorStyle, cursorBlink, scrollback]);

  // Re-skin the live terminal when the theme preset/mode changes. rAF lets the
  // inline CSS vars settle before we read them. While the input bar owns
  // typing (normal screen), the grid cursor is painted background-on-
  // background — invisible — so the blank prompt line stays truly blank.
  useEffect(() => {
    if (!termRef.current) return;
    const r = requestAnimationFrame(() => {
      const term = termRef.current;
      if (!term) return;
      const t = buildTerminalTheme();
      if (inputBar && (!altScreen || agentAltScreen)) {
        t.cursor = t.background;
        t.cursorAccent = t.background;
      }
      term.options.theme = t;
    });
    return () => cancelAnimationFrame(r);
  }, [theme, presetId, inputBar, altScreen, agentAltScreen]);

  // The unfocused cursor outline ("[]") must also vanish in input-bar mode.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorInactiveStyle =
      inputBar && (!altScreen || agentAltScreen) ? "none" : "outline";
  }, [inputBar, altScreen, agentAltScreen]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    const s = useSettings.getState();
    // Input-bar mode starts on the normal screen — hide the grid cursor from
    // the very first frame (the change-effects only cover later flips).
    const initialTheme = buildTerminalTheme();
    if (s.inputBar) {
      initialTheme.cursor = initialTheme.background;
      initialTheme.cursorAccent = initialTheme.background;
    }
    const term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: 1.2,
      cursorBlink: s.cursorBlink,
      cursorStyle: s.cursorStyle,
      cursorInactiveStyle: s.inputBar ? "none" : "outline",
      allowProposedApi: true,
      theme: initialTheme,
      scrollback: s.scrollback,
    });
    termRef.current = term;
    // Global registry — lets cross-pane search reach this buffer even while the
    // pane is in the background (all sessions stay mounted).
    registerTerminal(id, term);
    // Dev-only E2E hook: the canvas renderer keeps text out of the DOM, so
    // smoke probes (scripts/smoke-real.mjs) read the buffer through this.
    if (import.meta.env.DEV) {
      type TermRegistry = Record<string, Terminal>;
      const w = window as unknown as { __naruTerms?: TermRegistry };
      (w.__naruTerms ??= {})[id] = term;
    }

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    // Unicode 11 width tables (PLAN §4). The default is Unicode 6, whose
    // emoji/CJK widths disagree with modern CLIs (claude/codex use
    // string-width) — every mismatch shifts the rest of the line by a cell,
    // which is what garbled Korean sessions in agent TUIs.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";

    // Scrollback search (Ctrl/⌘+F overlay) — disposed with the terminal.
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;

    term.open(container);

    // Expose the instance for the headless test scripts (dev only).
    if (import.meta.env.DEV) {
      (container as HTMLDivElement & { __term?: Terminal }).__term = term;
    }

    // File paths printed by agents/compilers become clickable → in-app viewer.
    const pathLinks = registerPathLinks(term, id);
    // Dev-server URLs (Local: http://localhost:3000) → in-app browser pane.
    const urlLinks = registerUrlLinks(term, id);
    // Right-click on any link → context menu (open in default app / NARU / …).
    const linkMenu = registerLinkContextMenu(term, id);

    // Canvas (2D) renderer — NOT WebGL. NARU keeps every session mounted (one
    // renderer each), and Chromium/WebView2 caps simultaneous WebGL contexts
    // (~16); past that it force-loses the oldest, blanking a pane's text (only
    // the DOM block overlays survive → floating bars over an empty grid). Canvas
    // has no such limit, so the failure mode is gone. Falls back to the built-in
    // DOM renderer if the addon can't load.
    try {
      const canvas = new CanvasAddon();
      term.loadAddon(canvas);
      rendererRef.current = canvas;
    } catch (e) {
      console.warn("[naru] Canvas renderer unavailable, using DOM:", e);
    }

    fit.fit();

    // Bundled fonts (JetBrains Mono + the Korean Nanum Gothic Coding) can
    // finish loading AFTER the canvas renderer rasterized its first glyphs into
    // the texture atlas, caching a fallback shape (proportional Hangul drawn in
    // xterm's 2-cell slots → a gap after every character). Once fonts are ready,
    // drop the atlas and repaint so every glyph re-rasterizes from the real font.
    void document.fonts.ready.then(() => {
      if (disposed) return;
      try {
        rendererRef.current?.clearTextureAtlas();
      } catch {
        /* renderer disposed */
      }
      term.refresh(0, term.rows - 1);
    });

    // ── IME preview alignment for agent TUIs (claude/codex) ────────────────
    // Those CLIs draw their own input caret as an inverse-video blank cell
    // and often leave the hardware cursor elsewhere (right after the caret,
    // or parked at the screen edge before the first keystrokes), so xterm's
    // composition preview renders off target: 안█녕, or in a corner. While
    // composing, locate the drawn caret — an ISOLATED inverse blank cell —
    // and move the preview onto it. Preference order:
    //   1. caret right before the cursor (strongest signal),
    //   2. a UNIQUE isolated inverse blank anywhere in the viewport
    //      (covers the parked-cursor case; ≥2 matches = ambiguous, skip).
    // Plain shells have no inverse blanks at all, so this never fires there.
    const isCaretCell = (cell: { getChars(): string; isInverse(): number } | undefined) => {
      if (!cell || cell.isInverse() === 0) return false;
      const ch = cell.getChars();
      return ch === "" || ch === " " || ch === "█";
    };
    let imeRaf = 0;
    const alignImePreview = () => {
      const view = container.querySelector<HTMLElement>(".composition-view");
      if (view) {
        const buf = term.buffer.active;
        const curX = Math.min(buf.cursorX, term.cols - 1);
        const curY = buf.cursorY;
        const lineAt = (y: number) => buf.getLine(buf.baseY + y);

        let target: { x: number; y: number } | null = null;
        const before = curX > 0 ? lineAt(curY)?.getCell(curX - 1) : undefined;
        const beforePrev =
          curX > 1 ? lineAt(curY)?.getCell(curX - 2) : undefined;
        if (isCaretCell(before) && !beforePrev?.isInverse()) {
          target = { x: curX - 1, y: curY };
        } else {
          // viewport scan for a unique isolated inverse blank
          let count = 0;
          for (let y = 0; y < term.rows && count < 2; y++) {
            const line = lineAt(y);
            if (!line) continue;
            let prevInv = false;
            for (let x = 0; x < term.cols && count < 2; x++) {
              const cell = line.getCell(x);
              const inv = !!cell && cell.isInverse() !== 0;
              if (inv && !prevInv) {
                const next = x + 1 < term.cols ? line.getCell(x + 1) : undefined;
                if (isCaretCell(cell) && !next?.isInverse()) {
                  count++;
                  if (count === 1) target = { x, y };
                }
              }
              prevInv = inv;
            }
          }
          if (count !== 1) target = null;
        }

        if (target) {
          const screen = container.querySelector(".xterm-screen");
          const rect = screen?.getBoundingClientRect();
          const cellW = rect ? rect.width / term.cols : 0;
          const cellH = rect ? rect.height / term.rows : 0;
          view.style.marginLeft = `${(target.x - curX) * cellW}px`;
          view.style.marginTop = `${(target.y - curY) * cellH}px`;
          // min-width so the opaque preview fully hides the caret cell even
          // while the composed glyph is still narrow.
          view.style.minWidth = `${cellW * 2}px`;
        } else {
          view.style.marginLeft = "";
          view.style.marginTop = "";
          view.style.minWidth = "";
        }
      }
      imeRaf = requestAnimationFrame(alignImePreview);
    };
    const onCompositionStart = () => {
      cancelAnimationFrame(imeRaf);
      imeRaf = requestAnimationFrame(alignImePreview);
    };
    const onCompositionEnd = () => cancelAnimationFrame(imeRaf);
    const helperTextarea = container.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea"
    );
    helperTextarea?.addEventListener("compositionstart", onCompositionStart);
    helperTextarea?.addEventListener("compositionend", onCompositionEnd);

    // Clicking the pane background still focuses the active input target
    // (muscle memory: click anywhere in the pane to type).
    const onEmptyAreaMouseDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".xterm")) {
        // Without preventDefault the browser's own mousedown default runs
        // AFTER this handler and moves focus to body, undoing the focus().
        e.preventDefault();
        // Warp-style: clicks in the empty pane area go to the input bar when
        // it's visible; alt-screen TUIs get the grid itself.
        if (
          inputRef.current &&
          (!altRef.current || agentAltScreenRef.current)
        ) {
          inputRef.current.focus();
        } else {
          term.focus();
        }
      }
    };
    container.addEventListener("mousedown", onEmptyAreaMouseDown);

    // Ctrl/⌘+F anywhere in the pane (grid OR input bar) opens the search
    // overlay. Capture phase so xterm's helper textarea never sees the chord.
    const root = rootRef.current;
    const onSearchKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        e.stopPropagation();
        // Warp behavior: a grid selection seeds the query.
        searchInitial.current = term.getSelection().split("\n")[0] ?? "";
        setSearchOpen(true);
      }
    };
    root?.addEventListener("keydown", onSearchKey, true);

    // Live prompt-mode sync: the integration's prompt reads a mode FILE each
    // render, so toggling just rewrites the file (no command injection, no
    // echo) and a bare Enter refreshes the visible prompt line.
    let shellPromptMode = useSettings.getState().inputBar;
    const syncPromptMode = () => {
      const want = useSettings.getState().inputBar;
      if (want === shellPromptMode || altRef.current) return;
      shellPromptMode = want;
      void invoke("set_prompt_mode", { minimal: want })
        .then(() => {
          // empty Enter = no echo, just a fresh prompt in the new style
          void invoke("pty_write", { id, data: "\r" }).catch(() => {});
        })
        .catch(() => {});
    };
    const promptModeUnsub = useSettings.subscribe((s, prev) => {
      if (s.inputBar !== prev.inputBar) syncPromptMode();
    });

    // Track alt-screen so the input bar hides while a TUI owns the grid.
    // Focus follows: TUIs get the grid, the input bar takes over afterwards.
    const bufferDisposable = term.buffer.onBufferChange(() => {
      const alt = term.buffer.active.type === "alternate";
      altRef.current = alt;
      setAltScreen(alt);
      if (alt) {
        if (agentAltScreenRef.current && inputBarRef.current) {
          requestAnimationFrame(() => inputRef.current?.focus());
        } else {
          term.focus();
        }
      } else {
        if (inputBarRef.current) inputRef.current?.focus();
        // catch up if the setting flipped while a TUI was on screen
        syncPromptMode();
      }
    });

    // Warp focus model: while the input bar owns typing (normal screen),
    // clicking the grid must not steal keyboard focus — selection still works
    // (mouse-only), but keystrokes keep flowing to the input bar.
    const onTermFocus = () => {
      if (
        inputBarRef.current &&
        inputRef.current &&
        (!altRef.current || agentAltScreenRef.current)
      ) {
        requestAnimationFrame(() => {
          if (!altRef.current || agentAltScreenRef.current) {
            inputRef.current?.focus();
          }
        });
      }
    };
    term.textarea?.addEventListener("focus", onTermFocus);

    const writeToPty = (data: string) => {
      void invoke("pty_write", { id, data }).catch(() => {});
    };

    let onDataDisposable: { dispose(): void } | null = null;

    const start = async () => {
      try {
        // Listen BEFORE creating the PTY so no initial output/status is missed.
        unlisteners.push(
          await listen<SessionStatus>(`pty://status/${id}`, (event) => {
            if (disposed) return;
            useStatusStore.getState().setStatus(id, event.payload);
          }),
          // Backend signals reader EOF when the shell exits on its own.
          await listen(`pty://exit/${id}`, () => {
            if (disposed) return;
            term.writeln("\x1b[2m[프로세스가 종료되었습니다]\x1b[0m");
          })
        );
        if (disposed) {
          unlisteners.forEach((u) => u());
          return;
        }
        // Output arrives over a dedicated IPC channel as RAW bytes — events
        // serialize Vec<u8> as a JSON number array (3-5 chars per byte), which
        // was the dominant CPU cost on both sides under heavy streaming.
        const onOutput = new Channel<ArrayBuffer | number[]>();
        onOutput.onmessage = (data) => {
          if (disposed) return;
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data);
          term.write(bytes);
          // Tee into the recorder (no-op unless this session is recording).
          feedRecording(id, bytes);
        };
        // onData MUST be live BEFORE create resolves: ConPTY opens with a
        // cursor-position query (\x1b[6n) and blocks the child's console
        // connect until the terminal answers. The query can arrive over the
        // output channel before the create invoke's promise continuation
        // runs — registering onData afterwards dropped xterm's auto-reply
        // and froze the shell at startup (0 CPU, no output, forever).
        onDataDisposable = term.onData(writeToPty);
        await invoke("pty_create", {
          id,
          cols: term.cols,
          rows: term.rows,
          inheritFrom: inheritFrom ?? null,
          // The input bar replaces the prompt UI — spawn with a minimal "> ".
          minimalPrompt: useSettings.getState().inputBar,
          onOutput,
        });
        // Startup command (e.g. an SSH connect) — run it once the fresh shell
        // has drawn its first prompt so the line isn't swallowed mid-init.
        if (startupCommand) {
          window.setTimeout(() => {
            if (!disposed) {
              void invoke("pty_write", {
                id,
                data: `${startupCommand}\r`,
              }).catch(() => {});
            }
          }, 350);
        }
        // Focus whoever owns typing — and again a beat later: dockview runs
        // its own focus pass right after mounting a new panel, which was
        // intermittently stealing focus ("new shell won't take input").
        const focusOwner = () => {
          if (disposed) return;
          if (inputBarRef.current && !altRef.current) {
            inputRef.current?.focus();
          } else {
            term.focus();
          }
        };
        focusOwner();
        window.setTimeout(focusOwner, 150);
      } catch (e) {
        // Roll back anything we managed to register, then surface the failure
        // in the grid so the pane isn't left silently half-initialized.
        onDataDisposable?.dispose();
        onDataDisposable = null;
        unlisteners.forEach((u) => u());
        unlisteners.length = 0;
        if (!disposed) {
          term.writeln(`\x1b[31m셸을 시작하지 못했습니다: ${String(e)}\x1b[0m`);
        }
      }
    };
    const createPromise = start();

    // After a resize changes the grid geometry, the Canvas renderer can leave
    // stale pixels behind — the "leftover gray band" that stretches across the
    // pane's OLD width (visible even into a neighboring pane, since a sibling
    // split shrank this canvas but the prior frame's row wasn't repainted).
    // Clearing the glyph atlas and forcing a full repaint paints over it. The
    // on-activation heal above only fires on tab switches, so an already-active
    // pane resized by a sibling split never gets healed without this. Debounced
    // via rAF so a sash drag (many resize ticks) only heals once it settles.
    let healRaf = 0;
    const healCanvasBands = () => {
      cancelAnimationFrame(healRaf);
      healRaf = requestAnimationFrame(() => {
        try {
          rendererRef.current?.clearTextureAtlas();
        } catch {
          /* renderer disposed */
        }
        const t = termRef.current;
        if (t) t.refresh(0, t.rows - 1);
      });
    };

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      // Hidden sessions (display:none) report 0×0 — fitting then would shrink
      // the PTY to a bogus grid, making ConPTY re-wrap the screen (garbled
      // prompt) and emit output that flashes every sidebar status dot. We
      // refit when the pane becomes visible again instead.
      if (!container.offsetWidth || !container.offsetHeight) return;
      if (useSidebarUI.getState().resizing) {
        pendingSidebarFitRef.current = true;
        return;
      }
      const { cols, rows } = term;
      fitPreservingScroll();
      if (term.cols !== cols || term.rows !== rows) {
        void invoke("pty_resize", { id, cols: term.cols, rows: term.rows }).catch(
          () => {}
        );
        healCanvasBands();
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      cancelAnimationFrame(imeRaf);
      cancelAnimationFrame(healRaf);
      helperTextarea?.removeEventListener("compositionstart", onCompositionStart);
      helperTextarea?.removeEventListener("compositionend", onCompositionEnd);
      bufferDisposable.dispose();
      promptModeUnsub();
      term.textarea?.removeEventListener("focus", onTermFocus);
      container.removeEventListener("mousedown", onEmptyAreaMouseDown);
      root?.removeEventListener("keydown", onSearchKey, true);
      searchRef.current = null;
      ro.disconnect();
      onDataDisposable?.dispose();
      unlisteners.forEach((u) => u());
      useStatusStore.getState().clear(id);
      // On a fast unmount pty_create may still be in flight — chain the close
      // after it settles so we never orphan a PTY the backend hasn't yet
      // finished spawning.
      void createPromise.finally(() => {
        void invoke("pty_close", { id }).catch(() => {});
      });
      pathLinks.dispose();
      urlLinks.dispose();
      linkMenu.dispose();
      stopRecording(id); // finalize a recording if this pane was capturing
      unregisterTerminal(id);
      term.dispose();
      if (import.meta.env.DEV) {
        const w = window as unknown as { __naruTerms?: Record<string, unknown> };
        delete w.__naruTerms?.[id];
      }
      termRef.current = null;
      fitRef.current = null;
      rendererRef.current = null;
    };
  }, [id]);

  // Ctrl+C in the input bar: if the GRID has a selection, copy that instead
  // of sending SIGINT (Warp behavior).
  const copyGridSelection = () => {
    const t = termRef.current;
    if (t?.hasSelection()) {
      void navigator.clipboard.writeText(t.getSelection());
      t.clearSelection();
      return true;
    }
    return false;
  };

  // Close the overlay and hand focus back to whoever owns typing.
  const closeSearch = () => {
    setSearchOpen(false);
    if (inputBarRef.current && (!altRef.current || agentAltScreenRef.current)) {
      inputRef.current?.focus();
    } else {
      termRef.current?.focus();
    }
  };

  return (
    <div ref={rootRef} className="flex h-full w-full flex-col">
      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
        {recording && (
          <div className="pointer-events-none absolute top-2 left-3 z-20 flex items-center gap-1.5 rounded-full bg-t-red/15 px-2 py-0.5 text-[10.5px] font-semibold text-t-red">
            <span className="size-2 animate-pulse rounded-full bg-t-red" />
            REC
          </div>
        )}
        {searchOpen && (
          <TerminalSearch
            addon={searchRef.current}
            initial={searchInitial.current}
            onClose={closeSearch}
          />
        )}
      </div>
      <InputBar
        ref={inputRef}
        sessionId={id}
        hidden={!inputBar || (altScreen && !agentAltScreen)}
        onCtrlC={copyGridSelection}
      />
    </div>
  );
}
