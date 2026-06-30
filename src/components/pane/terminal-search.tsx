import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { SearchAddon } from "@xterm/addon-search";

import { ToolButton } from "@/components/common/tool-button";
import { resolveThemeColor } from "@/terminal/theme";

/** "rgb(r, g, b)" → "rgba(r, g, b, a)" — readVar always yields rgb(). */
function withAlpha(rgb: string, alpha: number): string {
  return rgb.startsWith("rgb(")
    ? rgb.replace("rgb(", "rgba(").replace(")", `, ${alpha})`)
    : rgb;
}

interface TerminalSearchProps {
  /** Search addon of the pane's terminal (null if the terminal failed to init). */
  addon: SearchAddon | null;
  /** Prefill — the grid selection at the moment the overlay opened. */
  initial: string;
  onClose: () => void;
}

/**
 * Warp/VS Code-style in-terminal search overlay (PLAN §4 — addon-search was
 * specified in the stack but never wired up). Lives in the pane's top-right
 * corner; Enter steps forward, Shift+Enter back, Esc closes. Matches are
 * decorated in the grid + overview ruler while the overlay is open.
 */
export function TerminalSearch({ addon, initial, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState(initial);
  const [hits, setHits] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Decoration colors must be concrete (no CSS vars inside xterm) — resolve
  // from the active theme once per overlay open.
  const decorations = useMemo(() => {
    const match = resolveThemeColor("--t-yellow");
    const active = resolveThemeColor("--primary");
    return {
      matchBackground: withAlpha(match, 0.35),
      matchOverviewRuler: match,
      activeMatchBackground: withAlpha(active, 0.5),
      activeMatchColorOverviewRuler: active,
    };
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, []);

  useEffect(() => {
    if (!addon) return;
    const d = addon.onDidChangeResults(({ resultIndex, resultCount }) =>
      setHits({ index: resultIndex, count: resultCount })
    );
    return () => d.dispose();
  }, [addon]);

  // Live (incremental) search while typing — the active match is kept as
  // long as it still matches the longer query, Warp/VS Code behavior.
  useEffect(() => {
    if (!addon) return;
    if (!query) {
      addon.clearDecorations();
      setHits(null);
      return;
    }
    addon.findNext(query, { incremental: true, decorations });
  }, [addon, query, decorations]);

  // Leaving the overlay always clears the grid decorations.
  useEffect(() => () => addon?.clearDecorations(), [addon]);

  const step = (dir: 1 | -1) => {
    if (!addon || !query) return;
    if (dir === 1) addon.findNext(query, { decorations });
    else addon.findPrevious(query, { decorations });
  };

  return (
    <div className="absolute top-1.5 right-3 z-20 flex items-center gap-1 rounded-md border border-border bg-popover px-1.5 py-1 shadow-md">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // IME owns the key
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="검색..."
        spellCheck={false}
        aria-label="터미널 검색"
        className="h-5 w-44 border-0 bg-transparent px-1 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50"
      />
      <span className="min-w-9 text-center text-[10.5px] tabular-nums text-muted-foreground">
        {query ? (hits && hits.count > 0 ? `${hits.index + 1}/${hits.count}` : "0/0") : ""}
      </span>
      <ToolButton tip="이전 (Shift+Enter)" size="icon-xs" onClick={() => step(-1)}>
        <ArrowUp />
      </ToolButton>
      <ToolButton tip="다음 (Enter)" size="icon-xs" onClick={() => step(1)}>
        <ArrowDown />
      </ToolButton>
      <ToolButton tip="닫기 (Esc)" size="icon-xs" onClick={onClose}>
        <X />
      </ToolButton>
    </div>
  );
}
