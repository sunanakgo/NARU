import { useEffect, useMemo, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { Search } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useGlobalSearch } from "@/store/global-search";
import { useWorkspace } from "@/store/workspace";
import { allTerminals } from "@/terminal/registry";

/** Caps keep an incremental search over every pane's full scrollback cheap. */
const PER_SESSION_CAP = 50;
const TOTAL_CAP = 300;
/** How much leading context to keep so a far-right match stays visible. */
const CTX_BEFORE = 48;

interface Hit {
  sessionId: string;
  title: string;
  line: number;
  text: string;
  start: number;
  len: number;
}

function searchAll(query: string): Hit[] {
  const ws = useWorkspace.getState();
  const titleOf = (id: string) =>
    ws.tabs.find((t) => t.panelIds.includes(id))?.title ?? "세션";
  const q = query.toLowerCase();
  const out: Hit[] = [];
  for (const [id, term] of allTerminals()) {
    const buf = term.buffer.active;
    const len = buf.length;
    let per = 0;
    for (let i = 0; i < len && out.length < TOTAL_CAP; i++) {
      const text = buf.getLine(i)?.translateToString(true) ?? "";
      const idx = text.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      out.push({
        sessionId: id,
        title: titleOf(id),
        line: i,
        text: text.replace(/\s+$/, ""),
        start: idx,
        len: query.length,
      });
      if (++per >= PER_SESSION_CAP) break;
    }
    if (out.length >= TOTAL_CAP) break;
  }
  return out;
}

/** Scroll a terminal to `line` and flash it briefly (a transient decoration). */
function jumpTo(term: Terminal, line: number) {
  try {
    term.scrollToLine(Math.max(0, line - 2));
  } catch {
    /* line out of range after a buffer trim — ignore */
  }
  const buf = term.buffer.active;
  const marker = term.registerMarker(line - (buf.baseY + buf.cursorY));
  if (!marker) return;
  const deco = term.registerDecoration({
    marker,
    x: 0,
    width: term.cols,
    layer: "top",
  });
  if (!deco) {
    marker.dispose();
    return;
  }
  deco.onRender((el) => {
    el.className = "naru-search-hit";
  });
  window.setTimeout(() => {
    deco.dispose();
    marker.dispose();
  }, 2200);
}

/**
 * Cross-pane search overlay. Searches every mounted session's scrollback at
 * once; selecting a hit activates that session's tab, scrolls its terminal to
 * the line and flashes it. The control-tower answer to "where did that error
 * scroll off to?" across panes you aren't even looking at.
 */
export function GlobalSearch() {
  const open = useGlobalSearch((s) => s.open);
  const setOpen = useGlobalSearch((s) => s.setOpen);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<HTMLButtonElement>(null);

  // Reset each time it opens; focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setSel(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  // Debounced incremental search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSel(0);
      return;
    }
    const t = window.setTimeout(() => {
      setHits(searchAll(q));
      setSel(0);
    }, 120);
    return () => window.clearTimeout(t);
  }, [query, open]);

  // Keep the selected row visible.
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const jump = (hit: Hit) => {
    const ws = useWorkspace.getState();
    const tab = ws.tabs.find((t) => t.panelIds.includes(hit.sessionId));
    if (tab) ws.setActiveTab(tab.id);
    setOpen(false);
    const term = allTerminals().get(hit.sessionId);
    if (term) requestAnimationFrame(() => jumpTo(term, hit.line));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(0, hits.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[sel];
      if (hit) jump(hit);
    }
  };

  const count = hits.length;
  const showHint = query.trim().length < 2;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[12%] max-w-[640px] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[640px]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">전체 검색</DialogTitle>
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="모든 세션의 출력에서 검색…"
            spellCheck={false}
            className="h-6 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          {!showHint && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {count >= TOTAL_CAP ? `${TOTAL_CAP}+` : count}건
            </span>
          )}
        </div>

        <div className="max-h-[55vh] overflow-y-auto py-1">
          {showHint ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              두 글자 이상 입력하면 열려 있는 모든 세션의 스크롤백을 검색합니다.
            </div>
          ) : count === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              일치하는 결과가 없습니다.
            </div>
          ) : (
            hits.map((hit, i) => {
              const newGroup = i === 0 || hits[i - 1].sessionId !== hit.sessionId;
              return (
                <div key={`${hit.sessionId}-${hit.line}-${i}`}>
                  {newGroup && (
                    <div className="px-4 pb-0.5 pt-2 text-[11px] font-semibold text-muted-foreground">
                      {hit.title}
                    </div>
                  )}
                  <button
                    ref={i === sel ? selRef : undefined}
                    onClick={() => jump(hit)}
                    onMouseMove={() => setSel(i)}
                    className={cn(
                      "flex w-full items-baseline gap-2 px-4 py-1 text-left",
                      i === sel ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    <span className="w-10 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
                      {hit.line + 1}
                    </span>
                    <Snippet text={hit.text} start={hit.start} len={hit.len} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Snippet({
  text,
  start,
  len,
}: {
  text: string;
  start: number;
  len: number;
}) {
  const { before, match, after } = useMemo(() => {
    const raw = text.slice(0, start);
    const clipped = raw.length > CTX_BEFORE ? "…" + raw.slice(-CTX_BEFORE) : raw;
    return {
      before: clipped,
      match: text.slice(start, start + len),
      after: text.slice(start + len),
    };
  }, [text, start, len]);

  return (
    <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">
      {before}
      <mark className="rounded-[2px] bg-t-yellow/30 text-foreground">{match}</mark>
      {after}
    </span>
  );
}
