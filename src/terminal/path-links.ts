import type { IBuffer, IBufferLine, IDisposable, Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";

import { useViewer } from "@/store/viewer";
import { useWorkspace } from "@/store/workspace";
import { useOpenBrowser } from "@/store/pane-commands";
import { useLinkMenu } from "@/store/link-menu";

/**
 * Clickable file paths in terminal output (agent CLIs print lots of them).
 * A custom xterm link provider matches path-looking tokens; clicking opens
 * the file in the in-app right-side viewer. Relative paths resolve against
 * the session's live (OSC 7) cwd.
 */

// Prefix: Windows drive (C:\ or C:/), home (~/), dot-relative (./ ../) or a
// bare first segment followed by a separator (src/...). Body: anything that
// isn't whitespace or a char Windows forbids in paths. Optional :line(:col).
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\w.@-]+[\\/])[^\s:'"<>|*?]+(?::\d+(?::\d+)?)?/g;

function trimToken(raw: string): string {
  // strip trailing punctuation that commonly hugs paths in prose,
  // then a :line(:col) suffix
  return raw.replace(/[)\],.;`>]+$/, "").replace(/:\d+(?::\d+)?$/, "");
}

/**
 * Buffer-column ↔ string-index conversion. `translateToString(true)` yields
 * one UTF-16 unit per narrow cell but wide (CJK) chars occupy TWO buffer
 * cells and one-or-two string units — so string indices and buffer columns
 * diverge after any wide char. Both link ranges and click resolution must
 * convert, or paths after Korean text underline/click at the wrong cells.
 */

/** 0-based buffer column where the char at string index `index` starts. */
function stringIndexToCol(line: IBufferLine, index: number): number {
  let strPos = 0;
  let col = 0;
  while (col < line.length) {
    const cell = line.getCell(col);
    if (!cell) break;
    if (strPos >= index) return col;
    strPos += cell.getChars().length || 1; // empty cell renders as one space
    col += cell.getWidth() || 1; // skip the wide char's continuation cell
  }
  return col;
}

/** 0-based string index of the char rendered at buffer column `col`. */
function colToStringIndex(line: IBufferLine, col: number): number {
  let strPos = 0;
  let c = 0;
  while (c < line.length) {
    const cell = line.getCell(c);
    if (!cell) break;
    const w = cell.getWidth() || 1;
    if (c + w > col) return strPos; // col falls inside this cell
    strPos += cell.getChars().length || 1;
    c += w;
  }
  return strPos;
}

interface LogicalRow {
  rowAbs: number;
  /** String offset where this physical row begins in the logical `text`. */
  offset: number;
  line: IBufferLine;
}
interface LogicalLine {
  text: string;
  rows: LogicalRow[];
}

/**
 * Reconstruct the LOGICAL line containing buffer row `rowAbs` — xterm soft-wraps
 * a long line across physical rows (continuations have `isWrapped`). Matching a
 * link per physical row splits it, so a wrapped URL/path underlined/clicked on
 * neither half. We walk up to the wrap's first row, concatenate forward (no
 * trim, so per-row offsets stay aligned), and record where each row begins.
 */
function logicalLineAt(buf: IBuffer, rowAbs: number): LogicalLine | null {
  let startRow = rowAbs;
  while (startRow > 0) {
    const cur = buf.getLine(startRow);
    if (cur && cur.isWrapped) startRow--;
    else break;
  }
  const rows: LogicalRow[] = [];
  let text = "";
  for (let rr = startRow, guard = 0; guard < 256; rr++, guard++) {
    const line = buf.getLine(rr);
    if (!line) break;
    if (rr !== startRow && !line.isWrapped) break;
    rows.push({ rowAbs: rr, offset: text.length, line });
    text += line.translateToString(false);
  }
  return rows.length ? { text, rows } : null;
}

/** The logical text + the string index the pointer maps to (wrap-aware). */
function pointerLogical(
  term: Terminal,
  clientX: number,
  clientY: number
): { text: string; idx: number } | null {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!screen) return null;
  const r = screen.getBoundingClientRect();
  // Clamp into the grid: on a narrow pane the cell width doesn't divide the
  // screen evenly, so a click near the right/bottom edge of a (wrapped) line
  // could round to cols/rows and miss — snap it to the last cell instead.
  const col = Math.max(
    0,
    Math.min(term.cols - 1, Math.floor(((clientX - r.left) / r.width) * term.cols))
  );
  const row = Math.max(
    0,
    Math.min(term.rows - 1, Math.floor(((clientY - r.top) / r.height) * term.rows))
  );
  const buf = term.buffer.active;
  const rowAbs = buf.viewportY + row;
  const ll = logicalLineAt(buf, rowAbs);
  if (!ll) return null;
  const phys = ll.rows.find((p) => p.rowAbs === rowAbs);
  if (!phys) return null;
  return { text: ll.text, idx: phys.offset + colToStringIndex(phys.line, col) };
}

interface LinkRange {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  text: string;
  activate: () => void;
}

/**
 * Links on the LOGICAL line containing physical row `lineNo` (1-based buffer
 * line). Each link is matched on the whole logical line and returned with its
 * FULL range, which may span both wrapped rows (`start.y` != `end.y`).
 *
 * xterm only underlines the single link UNDER THE POINTER — so clipping a link
 * to one physical row (the old approach) underlined just the hovered half of a
 * wrapped link, leaving the other row bare. One multi-row range underlines the
 * whole link on hover (same as @xterm/addon-web-links does for wrapped URLs).
 * Only links covering `lineNo` are surfaced (provideLinks is called per hovered
 * row). `pick` returns the link text, or null to skip. Activation is a no-op
 * (the click handlers below open it).
 */
function rowLinks(
  term: Terminal,
  lineNo: number,
  re: RegExp,
  pick: (text: string, m: RegExpExecArray) => string | null
): LinkRange[] | undefined {
  const buf = term.buffer.active;
  const ll = logicalLineAt(buf, lineNo - 1);
  if (!ll) return undefined;
  const thisRowAbs = lineNo - 1;
  // The physical row whose slice of the logical text contains string index `i`.
  const rowOf = (i: number): LogicalRow => {
    let r = ll.rows[0];
    for (const p of ll.rows) {
      if (i >= p.offset) r = p;
      else break;
    }
    return r;
  };
  const links: LinkRange[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ll.text))) {
    const token = pick(ll.text, m);
    if (!token) continue;
    const startIdx = m.index;
    const endIdx = m.index + token.length - 1; // last char of the link
    const rs = rowOf(startIdx);
    const reRow = rowOf(endIdx);
    // provideLinks is called per hovered row — only surface a link that covers
    // this row, but give it the full (possibly multi-row) range so the whole
    // wrapped link underlines, not just the hovered half.
    if (thisRowAbs < rs.rowAbs || thisRowAbs > reRow.rowAbs) continue;
    links.push({
      range: {
        start: {
          x: stringIndexToCol(rs.line, startIdx - rs.offset) + 1,
          y: rs.rowAbs + 1,
        },
        end: {
          x: stringIndexToCol(reRow.line, endIdx - reRow.offset) + 1,
          y: reRow.rowAbs + 1,
        },
      },
      text: token,
      activate: () => {},
    });
  }
  return links.length ? links : undefined;
}

/** Match → path token (skips URL innards), or null. */
function pickPath(text: string, m: RegExpExecArray): string | null {
  const before = text.slice(Math.max(0, m.index - 3), m.index);
  if (before.includes(":/") || m[0].includes("://")) return null;
  const token = trimToken(m[0]);
  return token.length >= 3 ? token : null;
}

/** Match → URL (strips trailing prose punctuation), or null. */
function pickUrl(_text: string, m: RegExpExecArray): string | null {
  const url = m[0].replace(/[)\],.;:!?]+$/, "");
  return url.length >= 10 ? url : null;
}

/** URL under the pointer, resolving across soft-wraps. */
function urlUnderPointer(term: Terminal, x: number, y: number): string | null {
  const ctx = pointerLogical(term, x, y);
  return ctx ? urlAt(ctx.text, ctx.idx) : null;
}

/** Path token under the pointer, resolving across soft-wraps. */
function pathUnderPointer(term: Terminal, x: number, y: number): string | null {
  const ctx = pointerLogical(term, x, y);
  return ctx ? pathAt(ctx.text, ctx.idx) : null;
}

/** Path token covering `col` on a buffer line, or null. */
function pathAt(text: string, col: number): string | null {
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text))) {
    // skip URL innards (https://host/path)
    const before = text.slice(Math.max(0, m.index - 3), m.index);
    if (before.includes(":/") || m[0].includes("://")) continue;
    const token = trimToken(m[0]);
    if (token.length < 3) continue;
    if (col >= m.index && col < m.index + m[0].length) return token;
  }
  return null;
}

/**
 * Like the URL links below, activation resolves the cell UNDER THE POINTER
 * AT CLICK TIME — xterm's hover-registered link activation goes stale when
 * the pane resizes (e.g. the viewer this very link opens shifts the layout)
 * or live output moves lines, silently dropping the next click. The link
 * provider remains purely for the hover underline affordance.
 */
export function registerPathLinks(term: Terminal, sessionId: string): IDisposable {
  const provider = term.registerLinkProvider({
    provideLinks(lineNo, cb) {
      // Underline/cursor affordance only — opening happens in onClick. Matched
      // on the logical line so wrapped paths underline across both rows.
      cb(rowLinks(term, lineNo, PATH_RE, pickPath));
    },
  });

  const onClick = (e: MouseEvent) => {
    // Plain left click only; modifier clicks belong to the URL handler, and
    // a drag-selection ending on a path must not open the viewer.
    if (e.ctrlKey || e.metaKey || term.hasSelection()) return;
    const token = pathUnderPointer(term, e.clientX, e.clientY);
    if (!token) return;
    void openResolved(sessionId, token);
  };
  term.element?.addEventListener("click", onClick);

  return {
    dispose() {
      provider.dispose();
      term.element?.removeEventListener("click", onClick);
    },
  };
}

// http(s) URLs printed by dev servers ("Local: http://localhost:3000" etc.)
const URL_RE = /https?:\/\/[^\s'"<>`]+/g;

/** Strip punctuation that hugs URLs in prose; reject noise. */
function urlAt(text: string, col: number): string | null {
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    const url = m[0].replace(/[)\],.;:!?]+$/, "");
    if (url.length < 10) continue; // "http://x" noise
    if (col >= m.index && col < m.index + url.length) return url;
  }
  return null;
}

function openInBrowser(sessionId: string, url: string) {
  // The browser pane opens in the tab that owns this terminal.
  const ws = useWorkspace.getState();
  const tab =
    ws.tabs.find((t) => t.panelIds.includes(sessionId)) ??
    ws.tabs.find((t) => t.id === ws.activeTabId);
  if (tab) useOpenBrowser.getState().open(tab.id, url);
}

const IS_MAC_UA = navigator.userAgent.includes("Macintosh");

/**
 * Ctrl+Click (Cmd on macOS) on an http(s) URL opens it as an in-app browser
 * pane — terminal convention, and plain clicks stay free for selection.
 *
 * Activation resolves the cell UNDER THE POINTER AT CLICK TIME and re-matches
 * the URL on that buffer line — xterm's own linkifier activation depends on
 * hover-registered state, which goes stale whenever live output shifts lines
 * (dev servers!) or layout changes move the grid, dropping clicks. A link
 * provider is still registered purely for the hover underline affordance.
 */
export function registerUrlLinks(term: Terminal, sessionId: string): IDisposable {
  const provider = term.registerLinkProvider({
    provideLinks(lineNo, cb) {
      // Underline only (Ctrl/Cmd+click opens in onClick); logical-line matching
      // underlines a URL wrapped across two rows on both.
      cb(rowLinks(term, lineNo, URL_RE, pickUrl));
    },
  });

  const onClick = (e: MouseEvent) => {
    if (!(IS_MAC_UA ? e.metaKey : e.ctrlKey)) return;
    const url = urlUnderPointer(term, e.clientX, e.clientY);
    if (!url) return;
    e.preventDefault();
    openInBrowser(sessionId, url);
  };
  term.element?.addEventListener("click", onClick);

  return {
    dispose() {
      provider.dispose();
      term.element?.removeEventListener("click", onClick);
    },
  };
}

/** Resolve a path token to an absolute path against the session's live cwd. */
async function resolvePath(sessionId: string, token: string): Promise<string> {
  let p = token;
  const isAbs =
    /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("~");
  if (!isAbs) {
    // relative → resolve against the session's live cwd ("~" is expanded
    // backend-side by read_text_file)
    const cwd = await invoke<string | null>("pty_cwd", { id: sessionId }).catch(
      () => null
    );
    if (cwd) {
      const sep = cwd.includes("/") && !cwd.includes("\\") ? "/" : "\\";
      p = cwd + sep + p.replace(/^\.[\\/]/, "");
    }
  }
  return p;
}

async function openResolved(sessionId: string, token: string) {
  useViewer.getState().open(await resolvePath(sessionId, token));
}

/**
 * Right-click on a link → a context menu (Warp/cmux). URLs offer "open in the
 * default browser" / "open in NARU"; files and folders offer system-open /
 * reveal / open-in-NARU / copy. The terminal's own `contextmenu` fires before
 * the app-wide native-menu blocker (window, bubble phase), so this just works.
 */
export function registerLinkContextMenu(
  term: Terminal,
  sessionId: string
): IDisposable {
  const onContext = (e: MouseEvent) => {
    // A drag-selection right-click should stay free for copy.
    if (term.hasSelection()) return;
    const url = urlUnderPointer(term, e.clientX, e.clientY);
    if (url) {
      e.preventDefault();
      e.stopPropagation();
      useLinkMenu
        .getState()
        .openMenu({ x: e.clientX, y: e.clientY, kind: "url", value: url, sessionId });
      return;
    }
    const token = pathUnderPointer(term, e.clientX, e.clientY);
    if (!token) return;
    e.preventDefault();
    e.stopPropagation();
    const x = e.clientX;
    const y = e.clientY;
    void (async () => {
      const abs = await resolvePath(sessionId, token);
      const kind = await invoke<string>("path_kind", { path: abs }).catch(
        () => "file"
      );
      if (kind === "missing") return; // not a real path — no menu
      useLinkMenu.getState().openMenu({
        x,
        y,
        kind: kind === "dir" ? "dir" : "file",
        value: abs,
        sessionId,
      });
    })();
  };
  term.element?.addEventListener("contextmenu", onContext);
  return {
    dispose() {
      term.element?.removeEventListener("contextmenu", onContext);
    },
  };
}
