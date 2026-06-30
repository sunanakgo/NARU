import { forwardRef, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  CornerDownLeft,
  Folder,
  GitBranch,
  Play,
  Plus,
  SquareSlash,
  SquareTerminal,
  X,
} from "lucide-react";
import { ClaudeCode, Codex, OpenCode } from "@lobehub/icons";

import { cn } from "@/lib/utils";
import { IS_MAC } from "@/lib/platform";
import { ToolButton } from "@/components/common/tool-button";
import { TechIcon } from "@/components/common/tech-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileIcon } from "@/components/drawer/file-icon";
import {
  clearOptimisticSessionBrand,
  refreshSessionInfo,
  setOptimisticSessionBrand,
  useSessionInfo,
} from "@/store/session-info";
import { useAgentQuota } from "@/store/quota";
import { useSettings, type AgentCli } from "@/store/settings";
import { useCommandHistory } from "@/store/command-history";
import { Chip, QuotaPct } from "@/components/pane/input-context-chip";
import { useAgentSlashCommands } from "@/components/pane/use-agent-slash-commands";

import {
  BUILTIN_CMDS,
  GIT_SUBCOMMANDS,
  HISTORY,
  ensureHistory,
  lcp,
  pathCommands,
  pushHistory,
  type Completion,
  type FsEntry,
  type RepoInfo,
} from "@/components/pane/input-bar-model";

const CODEX_BLUE = "#7A9DFF";

// Composer font size — fixed, INDEPENDENT of the terminal "글자 크기" slider
// (settings.fontSize). The text box is chat UI, not terminal output, so
// resizing the terminal must not reflow it. Ghost overlay + textarea must
// share this exact value to keep the suggestion aligned with typed text.
const COMPOSER_FONT_SIZE = 13;

const isAgentBrand = (brand: string | undefined): brand is AgentCli =>
  brand === "claude" || brand === "codex" || brand === "opencode";

/** Last agent conversation recorded for this session (Rust agent vault). */
interface AgentSessionRecord {
  brand: string;
  agent_session_id: string;
  updated_at: number;
}

const agentFromCommand = (command: string): AgentCli | null => {
  const first = command.trim().split(/\s+/)[0]?.toLowerCase();
  return isAgentBrand(first) ? first : null;
};

/** Command that resumes a recorded agent session. claude has a precise id (its
 * SessionStart hook); codex/opencode fall back to the CLI's "continue last". */
const resumeCommand = (rec: AgentSessionRecord): string => {
  const id = rec.agent_session_id;
  switch (rec.brand) {
    case "codex":
      return id ? `codex resume ${id}` : "codex resume --last";
    case "opencode":
      return id ? `opencode -s ${id}` : "opencode --continue";
    default:
      return id ? `claude --resume ${id}` : "claude --continue";
  }
};

/**
 * Warp-style input card under the terminal grid. Commands are composed here
 * (Enter runs, Shift+Enter newline, Ctrl+C interrupts) and written to the
 * PTY — the shell echoes them into the grid, so blocks capture everything.
 * Context chips (runtime/cwd/branch/±) follow the shell's OSC 7 location.
 */
export const InputBar = forwardRef<
  HTMLTextAreaElement,
  {
    sessionId: string;
    hidden: boolean;
    /** Returns true if it consumed Ctrl+C (e.g. copied a grid selection). */
    onCtrlC?: () => boolean;
  }
>(function InputBar({ sessionId, hidden, onCtrlC }, ref) {
  const [text, setText] = useState("");
  const info = useSessionInfo(sessionId, !hidden);
  // plan usage — only while claude/codex runs in THIS session
  const [quota, refreshQuota] = useAgentQuota(info?.brand);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  // Attachments shown as chips above the box; their paths are appended to the
  // command on submit so the agent CLI can read them. `url` (a data URL) marks
  // an image (rendered as a thumbnail); otherwise it's a file chip (e.g. a
  // long-text paste saved as .txt) with a name + line count.
  const [attachments, setAttachments] = useState<
    { path: string; url?: string; name?: string; lines?: number }[]
  >([]);
  // Drag-active ring while a file is hovering the composer. A ref counter
  // tracks enter/leave depth so moving over child elements doesn't flicker it.
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const lastCwd = useRef<string | null>(null);
  const agentCli = useSettings((s) => s.agentCli);
  const setSettings = useSettings((s) => s.set);
  const recordCommand = useCommandHistory((s) => s.record);

  // cmux-style resume: the Claude SessionStart hook records its conversation
  // id per NARU session — when the session restores (or claude exits) and no
  // agent is running, offer to continue where it left off.
  const [resume, setResume] = useState<AgentSessionRecord | null>(null);
  const agentRunning = isAgentBrand(info?.brand);
  useEffect(() => {
    if (agentRunning) {
      setResume(null);
      return;
    }
    let alive = true;
    void invoke<AgentSessionRecord | null>("agent_resume_info", {
      id: sessionId,
    })
      .then((r) => alive && setResume(r))
      .catch(() => alive && setResume(null));
    return () => {
      alive = false;
    };
  }, [sessionId, agentRunning]);

  // claude records its session id via the SessionStart hook; codex/opencode
  // have no such hook, so when the UI detects one running we record just the
  // brand in the vault → the resume chip can offer "continue last" for them.
  useEffect(() => {
    const b = info?.brand;
    if (b === "codex" || b === "opencode") {
      void invoke("agent_record_brand", { id: sessionId, brand: b }).catch(
        () => {}
      );
    }
  }, [info?.brand, sessionId]);

  // Refresh repo intel when the session's cwd changes (cd follows via OSC 7).
  useEffect(() => {
    const cwd = info?.cwd ?? null;
    if (!cwd || cwd === lastCwd.current) return;
    lastCwd.current = cwd;
    let alive = true;
    void invoke<RepoInfo>("repo_info", { cwd })
      .then((r) => alive && setRepo(r))
      .catch(() => alive && setRepo(null));
    return () => {
      alive = false;
    };
  }, [info?.cwd]);

  const send = (data: string) =>
    void invoke("pty_write", { id: sessionId, data }).catch(() => {});

  // Track the delayed-CR timer so an unmount mid-submit doesn't fire send()
  // (which would invoke into a torn-down PTY binding).
  const submitTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (submitTimer.current !== null) window.clearTimeout(submitTimer.current);
    },
    []
  );

  // Agent TUIs (Ink-based: claude/codex/opencode) treat text+CR arriving in
  // ONE stdin chunk as a PASTE — the CR becomes a newline inside their
  // composer instead of a submit, so the message never reaches the model
  // ("I typed but nothing answers"). Submitting with a separated, delayed CR
  // makes it read as a real Enter keypress. Plain shells keep the fast path.
  const submit = (line: string) => {
    if (isAgentBrand(info?.brand) && line.length > 0) {
      send(line);
      if (submitTimer.current !== null) window.clearTimeout(submitTimer.current);
      submitTimer.current = window.setTimeout(() => {
        submitTimer.current = null;
        send("\r");
      }, 120);
    } else {
      send(line + "\r");
    }
  };

  // ↑/↓ command history (bash-style: only when the caret can't move further
  // within the multiline text; draft is restored when stepping past newest).
  ensureHistory(sessionId);
  const hist = useRef({ index: -1, draft: "" });

  // ── agent slash commands ──────────────────────────────────────────────────
  // While claude/codex runs in this session, typing "/" pops their slash
  // commands. Enter/click runs the highlighted one; Tab inserts it for args.
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  useEffect(() => {
    setSlashSel(0);
    setSlashDismissed(false);
  }, [text]);

  const agentCmds = useAgentSlashCommands(info?.brand, info?.cwd ?? null);
  const slashItems =
    agentCmds && !slashDismissed && text.startsWith("/") && !/\s/.test(text)
      ? agentCmds.filter((c) =>
          c.name.toLowerCase().startsWith(text.toLowerCase())
        )
      : [];
  const slashOpen = slashItems.length > 0;
  const sel = Math.min(slashSel, slashItems.length - 1);

  const runSlash = (cmd: string) => {
    pushHistory(sessionId, cmd);
    hist.current.index = -1;
    submit(cmd);
    setText("");
  };

  // ── autosuggest (Warp/fish-style) ─────────────────────────────────────────
  // Ghost text: best history match continues the current input, dimmed.
  const ghost = (() => {
    if (slashOpen) return "";
    if (!text || text.includes("\n")) return "";
    const items = HISTORY.get(sessionId)!;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].startsWith(text) && items[i] !== text) {
        return items[i].slice(text.length);
      }
    }
    return "";
  })();

  // Tab path completion against the shell's cwd (multi-match → icon menu).
  const [completions, setCompletions] = useState<Completion[] | null>(null);
  useEffect(() => setCompletions(null), [text]); // any edit dismisses the menu

  /** Start of the trailing token, treating double-quoted spans (which may
   * contain spaces) as part of one token — `cd "my dir\` stays whole. */
  const tokenStart = (s: string): number => {
    let start = 0;
    let inQuote = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') inQuote = !inQuote;
      else if (!inQuote && /\s/.test(ch)) start = i + 1;
    }
    return start;
  };

  const applyToken = (insert: string) => {
    const idx = tokenStart(text);
    const token = text.slice(idx).replace(/"/g, "");
    const sep = (info?.cwd ?? "").includes("/") ? "/" : "\\";
    const cut = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
    const dirPart = cut >= 0 ? token.slice(0, cut + 1) : "";
    // files append a trailing-space separator — quote only the path part
    const trail = insert.endsWith(" ") ? " " : "";
    let core = dirPart.replace(/[/\\]/g, sep) + (trail ? insert.slice(0, -1) : insert);
    if (/\s/.test(core)) core = `"${core}"`; // paths with spaces need quoting
    setText(text.slice(0, idx) + core + trail);
    setCompletions(null);
  };

  /** Shared tail: single match completes, multiple complete the common
   * prefix and open the menu. `partial` is the token being completed. */
  const offer = (
    ta: HTMLTextAreaElement,
    partial: string,
    items: Completion[],
    keepPrefix = ""
  ) => {
    if (items.length === 0) return;
    if (items.length === 1) {
      // applyToken preserves the token's directory part itself
      applyToken(items[0].insert);
      requestAnimationFrame(() => ta.focus());
      return;
    }
    const common = lcp(items.map((m) => m.name));
    if (common.length > partial.length) {
      const idx = tokenStart(text);
      // keep the user's typed casing for the chars they already entered
      let core = keepPrefix + partial + common.slice(partial.length);
      // mid-completion token with spaces → open quote (closed on final pick)
      if (/\s/.test(core)) core = `"${core}`;
      setText(text.slice(0, idx) + core);
    }
    requestAnimationFrame(() => setCompletions(items.slice(0, 8)));
  };

  const complete = async (ta: HTMLTextAreaElement) => {
    if (text.includes("\n")) return;
    const tokens = text.split(/\s+/);
    // quote-aware: `cd "my dir\fi` completes the whole quoted token
    const last = text.slice(tokenStart(text)).replace(/"/g, "");

    // 1) first token → command completion (history > builtins > PATH)
    if (tokens.length === 1 && last && !/[\\/]/.test(last)) {
      const lower = last.toLowerCase();
      const histCmds = HISTORY.get(sessionId)!
        .map((h) => h.split(/\s+/)[0])
        .reverse();
      const pool = [...histCmds, ...BUILTIN_CMDS, ...(await pathCommands())];
      const seen = new Set<string>();
      const matches: Completion[] = [];
      for (const c of pool) {
        const cl = c.toLowerCase();
        if (!cl.startsWith(lower) || cl === lower || seen.has(cl)) continue;
        seen.add(cl);
        matches.push({ name: c, kind: "cmd", insert: c + " " });
        if (matches.length >= 24) break;
      }
      offer(ta, last, matches);
      return;
    }

    // 2) `git <partial>` → subcommands
    if (tokens[0] === "git" && tokens.length === 2) {
      const matches = GIT_SUBCOMMANDS.filter((s) =>
        s.startsWith(last.toLowerCase())
      ).map<Completion>((s) => ({ name: s, kind: "cmd", insert: s + " " }));
      if (matches.length > 0) {
        offer(ta, last, matches);
        return;
      }
    }

    // 3) `npm|pnpm|yarn|bun run <partial>` → package.json scripts
    if (
      ["npm", "pnpm", "yarn", "bun"].includes(tokens[0]) &&
      tokens[1] === "run" &&
      tokens.length === 3 &&
      info?.cwd
    ) {
      const sep = info.cwd.includes("/") && !info.cwd.includes("\\") ? "/" : "\\";
      try {
        const pkg = JSON.parse(
          await invoke<string>("read_text_file", {
            path: `${info.cwd}${sep}package.json`,
          })
        ) as { scripts?: Record<string, string> };
        const matches = Object.keys(pkg.scripts ?? {})
          .filter((s) => s.toLowerCase().startsWith(last.toLowerCase()))
          .map<Completion>((s) => ({ name: s, kind: "script", insert: s + " " }));
        if (matches.length > 0) {
          offer(ta, last, matches);
          return;
        }
      } catch {
        /* no package.json — fall through to paths */
      }
    }

    // 4) default: path completion against the cwd
    const cwd = info?.cwd;
    if (!cwd) return;
    const sep = cwd.includes("/") && !cwd.includes("\\") ? "/" : "\\";
    const token = last;
    const cut = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
    const dirPart = cut >= 0 ? token.slice(0, cut + 1) : "";
    const filePart = cut >= 0 ? token.slice(cut + 1) : token;
    const listPath = dirPart ? cwd + sep + dirPart.replace(/[/\\]/g, sep) : cwd;
    let entries: FsEntry[] = [];
    try {
      entries = await invoke<FsEntry[]>("fs_list", { path: listPath });
    } catch {
      return;
    }
    const matches = entries
      .filter((e) => e.name.toLowerCase().startsWith(filePart.toLowerCase()))
      .map<Completion>((e) => ({
        name: e.name,
        kind: e.is_dir ? "dir" : "file",
        insert: e.name + (e.is_dir ? sep : " "),
      }));
    offer(ta, filePart, matches, dirPart);
  };

  const recall = (ta: HTMLTextAreaElement, value: string) => {
    setText(value);
    requestAnimationFrame(() =>
      ta.setSelectionRange(value.length, value.length)
    );
  };

  const run = () => {
    // Append any pasted-image paths so the agent receives them alongside the
    // typed prompt (quote paths containing spaces).
    const paths = attachments.map((a) =>
      a.path.includes(" ") ? `"${a.path}"` : a.path
    );
    const cmd = [text.trim(), ...paths].filter(Boolean).join(" ");
    pushHistory(sessionId, cmd);
    recordCommand({ sessionId, command: cmd, cwd: info?.cwd ?? null });
    hist.current.index = -1;
    const launchedAgent = agentFromCommand(cmd);
    if (launchedAgent) setOptimisticSessionBrand(sessionId, launchedAgent);
    submit(cmd);
    setText("");
    setAttachments([]);
  };

  const attach = async () => {
    try {
      const file = await openDialog({ multiple: false, title: "파일 첨부" });
      if (typeof file !== "string") return;
      // Images attach as a thumbnail (same as paste); other files insert their
      // path as text. Falls back to path text if the image can't be read.
      if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(file)) {
        try {
          const url = await invoke<string>("read_image_data_url", { path: file });
          setAttachments((a) => [...a, { path: file, url }]);
          return;
        } catch {
          /* fall through to path text */
        }
      }
      const quoted = file.includes(" ") ? `"${file}"` : file;
      setText((t) => (t ? `${t} ${quoted}` : quoted));
    } catch {
      /* dialog cancelled/unavailable */
    }
  };

  // Ctrl/Cmd+V of a clipboard image (e.g. a screenshot): persist it to a temp
  // file and attach it as a thumbnail above the box (NOT as path text, no
  // viewer). Its path is appended to the command on submit so the agent reads it.
  const pasteImage = async (file: File) => {
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const ext = (file.type.split("/")[1] || "png").toLowerCase();
      const path = await invoke<string>("save_pasted_image", { base64, ext });
      setAttachments((a) => [...a, { path, url: dataUrl }]);
    } catch {
      /* clipboard/save unavailable — fall back to the default paste */
    }
  };

  // A large text paste → a temp .txt file attached as a chip (like an image),
  // instead of dumping a huge blob into the composer. The agent reads the file.
  const pasteText = async (text: string) => {
    try {
      const path = await invoke<string>("save_pasted_text", { text });
      const name = path.split(/[\\/]/).pop() ?? "paste.txt";
      setAttachments((a) => [
        ...a,
        { path, name, lines: text.split("\n").length },
      ]);
    } catch {
      // saving failed — fall back to a plain inline paste
      setText((t) => t + text);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault(); // don't also paste the binary as text
        void pasteImage(file);
        return;
      }
    }
    // Long text → a .txt attachment (chat-app style); short pastes go inline.
    const text = e.clipboardData?.getData("text") ?? "";
    const lines = (text.match(/\n/g)?.length ?? 0) + 1;
    if (text.length >= 2000 || lines >= 20) {
      e.preventDefault();
      void pasteText(text);
    }
  };

  // Drag-and-drop a file (e.g. a screenshot from Finder) onto the composer.
  // dragDropEnabled is false in tauri.conf, so the webview gets native HTML5
  // DnD — images attach as thumbnails (reusing the paste path: FileReader →
  // save_pasted_image), exactly like Ctrl/Cmd+V. Non-image files are ignored
  // (their on-disk path isn't exposed to the webview, so we can't reference it).
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
  };
  const onDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current += 1;
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    for (const file of files) {
      if (file.type.startsWith("image/")) void pasteImage(file);
    }
  };

  // cwd chip click → pick a folder → cd the shell there (OSC 7 then updates
  // the chip on the next prompt).
  const pickCwd = async () => {
    if (isAgentBrand(info?.brand)) return;
    try {
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "작업 폴더 선택",
        defaultPath: info?.cwd ?? undefined,
      });
      if (typeof dir === "string") send(`cd "${dir}"\r`);
    } catch {
      /* dialog cancelled/unavailable */
    }
  };

  if (hidden) return null;

  const diffTotal = (info?.added ?? 0) + (info?.removed ?? 0);
  const activeAgent = isAgentBrand(info?.brand) ? info.brand : null;
  const resumeVisible = isAgentBrand(resume?.brand) && !activeAgent;
  const launcherAgent = activeAgent ?? agentCli;
  const agentActionsLocked = activeAgent !== null;

  return (
    <div className="shrink-0 px-2 pb-2 pt-1">
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "rounded-lg border border-border bg-pane-head/70 shadow-[0_2px_10px_hsl(0_0%_0%/0.18)]",
          dragActive && "border-primary ring-1 ring-primary"
        )}
      >
        {/* context chips: runtime · cwd · branch · ± (Warp look) */}
        {(info?.cwd || info?.branch || quota || resumeVisible || (repo?.runtimes.length ?? 0) > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
            {repo?.runtimes.map((r) => (
              <Chip key={r.kind} title={r.kind}>
                <TechIcon kind={r.kind} size={12} />
                {r.version && (
                  <span className="font-semibold text-t-green">v{r.version}</span>
                )}
              </Chip>
            ))}
            {info?.cwd && (
              <Chip
                title={info.cwd}
                onClick={
                  agentActionsLocked ? undefined : () => void pickCwd()
                }
                className={cn(
                  agentActionsLocked &&
                    "cursor-not-allowed opacity-50 hover:border-border hover:bg-background/70"
                )}
              >
                <Folder className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{info.cwd}</span>
              </Chip>
            )}
            {info?.branch && (
              <Chip title={`git: ${info.branch}`}>
                <GitBranch className="size-3 shrink-0 text-amber-400" />
                <span className="truncate font-semibold text-amber-300">
                  {info.branch}
                </span>
              </Chip>
            )}
            {info?.branch && (
              <Chip
                title="워킹 트리 변경"
                className={cn(diffTotal === 0 && "text-muted-foreground")}
              >
                {diffTotal === 0 ? (
                  <span>± 0</span>
                ) : (
                  <>
                    <span className="text-t-green">+{info.added}</span>
                    <span className="text-t-red">-{info.removed}</span>
                  </>
                )}
              </Chip>
            )}
            {quota && (
              <Chip
                title="플랜 사용량 — 클릭해서 갱신"
                // numbers read better in the app/UI font than in mono
                style={{ fontFamily: "var(--app-font)" }}
                onClick={refreshQuota}
              >
                {info?.brand === "codex" ? (
                  <span style={{ color: CODEX_BLUE }} className="inline-grid shrink-0">
                    <Codex size={12} />
                  </span>
                ) : (
                  <span className="inline-grid shrink-0">
                    <ClaudeCode.Color size={12} />
                  </span>
                )}
                <QuotaPct label="5시간" w={quota.five_hour} />
                <QuotaPct label="주간" w={quota.weekly} />
              </Chip>
            )}
            {resumeVisible && resume && (
              <Chip
                title={`이전 ${resume.brand} 세션을 이어서 시작합니다`}
                style={{ fontFamily: "var(--app-font)" }}
                onClick={() => {
                  const b = resume.brand;
                  if (isAgentBrand(b)) setOptimisticSessionBrand(sessionId, b);
                  send(`${resumeCommand(resume)}\r`);
                  setResume(null);
                }}
              >
                <span className="inline-grid shrink-0">
                  {resume.brand === "codex" ? (
                    <span style={{ color: CODEX_BLUE }} className="inline-grid">
                      <Codex size={12} />
                    </span>
                  ) : resume.brand === "opencode" ? (
                    <span style={{ color: "#fff" }} className="inline-grid">
                      <OpenCode size={12} />
                    </span>
                  ) : (
                    <ClaudeCode.Color size={12} />
                  )}
                </span>
                <span className="font-medium">이어하기</span>
              </Chip>
            )}
          </div>
        )}

        {/* attachments — image thumbnails / file chips above the input box */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2.5 pt-2">
            {attachments.map((a, i) => {
              const remove = (
                <button
                  type="button"
                  title="첨부 제거"
                  onClick={() =>
                    setAttachments((list) => list.filter((_, j) => j !== i))
                  }
                  className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/80 [&_svg]:size-2.5"
                >
                  <X />
                </button>
              );
              return a.url ? (
                <div
                  key={a.path}
                  title={a.path}
                  className="group relative size-14 overflow-hidden rounded-md border border-border bg-background"
                >
                  <img src={a.url} alt="" className="size-full object-cover" />
                  {remove}
                </div>
              ) : (
                <div
                  key={a.path}
                  title={a.path}
                  className="group relative flex h-14 max-w-[200px] items-center gap-2 overflow-hidden rounded-md border border-border bg-background py-2 pl-2.5 pr-6"
                >
                  <FileIcon name={a.name ?? "paste.txt"} isDir={false} size={20} />
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-medium">
                      {a.name}
                    </div>
                    {a.lines != null && (
                      <div className="text-[10px] text-muted-foreground">
                        {a.lines}줄
                      </div>
                    )}
                  </div>
                  {remove}
                </div>
              );
            })}
          </div>
        )}

        {/* input row */}
        <div className="flex items-end gap-1.5 px-1.5 py-1.5">
          <ToolButton
            tip="파일 첨부"
            size="icon-xs"
            className="mb-0.5"
            onClick={() => void attach()}
          >
            <Plus />
          </ToolButton>
          <div className="relative min-w-0 flex-1">
            {/* fish/Warp-style ghost suggestion: invisible prefix keeps the
                dimmed continuation perfectly aligned with the typed text */}
            {ghost && (
              <div
                aria-hidden
                style={{ fontFamily: "var(--app-font)", fontSize: COMPOSER_FONT_SIZE }}
                className="pointer-events-none absolute inset-0 overflow-hidden px-1.5 py-1 break-words whitespace-pre-wrap"
              >
                <span className="invisible">{text}</span>
                <span className="text-muted-foreground/40">{ghost}</span>
              </div>
            )}
            {/* agent slash-command menu (live while claude/codex runs) */}
            {slashOpen && (
              <div className="absolute bottom-full left-0 z-30 mb-1 max-h-64 w-80 max-w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
                {slashItems.map((c, i) => (
                  <button
                    key={c.name}
                    ref={
                      i === sel
                        ? (el) => el?.scrollIntoView({ block: "nearest" })
                        : undefined
                    }
                    onClick={() => runSlash(c.name)}
                    onMouseEnter={() => setSlashSel(i)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]",
                      i === sel ? "bg-accent" : ""
                    )}
                  >
                    {c.custom ? (
                      <SquareSlash size={13} className="shrink-0 text-amber-400" />
                    ) : info?.brand === "codex" ? (
                      <span style={{ color: CODEX_BLUE }} className="inline-grid shrink-0">
                        <Codex size={13} />
                      </span>
                    ) : info?.brand === "opencode" ? (
                      <span style={{ color: "#fff" }} className="inline-grid shrink-0">
                        <OpenCode size={13} />
                      </span>
                    ) : (
                      <span className="inline-grid shrink-0">
                        <ClaudeCode.Color size={13} />
                      </span>
                    )}
                    <span className="shrink-0 font-mono font-semibold">{c.name}</span>
                    <span className="truncate text-muted-foreground">{c.desc}</span>
                  </button>
                ))}
              </div>
            )}
            {/* Tab-completion menu (multiple matches) */}
            {completions && !slashOpen && (
              <div className="absolute bottom-full left-0 z-30 mb-1 max-h-56 min-w-44 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
                {completions.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => applyToken(c.insert)}
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-[12px] hover:bg-accent"
                  >
                    {c.kind === "cmd" ? (
                      <SquareTerminal size={13} className="shrink-0 text-emerald-400" />
                    ) : c.kind === "script" ? (
                      <Play size={13} className="shrink-0 text-sky-400" />
                    ) : (
                      <FileIcon name={c.name} isDir={c.kind === "dir"} size={13} />
                    )}
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </div>
            )}
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              // agent TUI passthrough: while claude/codex runs and the
              // composer is empty, navigation keys go straight to the CLI
              // so its select menus (/resume, model picker…) work from here.
              if (agentCmds && text === "" && !e.nativeEvent.isComposing) {
                const seq: Record<string, string> = {
                  ArrowUp: "\x1b[A",
                  ArrowDown: "\x1b[B",
                  ArrowRight: "\x1b[C",
                  ArrowLeft: "\x1b[D",
                  Escape: "\x1b",
                  Tab: "\t",
                };
                const s =
                  e.key === "Tab" && e.shiftKey ? "\x1b[Z" : seq[e.key];
                if (s && !e.ctrlKey && !e.altKey && !e.metaKey) {
                  e.preventDefault();
                  send(s);
                  return;
                }
              }
              // agent slash menu: navigate / run / insert / dismiss.
              // During Hangul composition the IME owns Arrow/Tab/Escape/Enter —
              // let them through so candidate selection works.
              if (slashOpen && !e.nativeEvent.isComposing) {
                const cur = slashItems[sel];
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashSel((sel + 1) % slashItems.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashSel((sel - 1 + slashItems.length) % slashItems.length);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && cur) {
                  e.preventDefault();
                  runSlash(cur.name);
                  return;
                }
                if (e.key === "Tab" && !e.shiftKey && cur) {
                  e.preventDefault();
                  setText(cur.name + " ");
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                run();
                return;
              }
              // macOS: ⌘+C copies a terminal-grid selection (never interrupts —
              // SIGINT stays Ctrl+C as on every terminal). With a textarea
              // selection (start≠end) this is skipped so the default ⌘+C copies
              // the typed text instead; with nothing selected it's a no-op.
              if (
                IS_MAC &&
                e.metaKey &&
                !e.ctrlKey &&
                !e.shiftKey &&
                !e.altKey &&
                e.key.toLowerCase() === "c" &&
                e.currentTarget.selectionStart === e.currentTarget.selectionEnd
              ) {
                if (onCtrlC?.()) e.preventDefault();
                return;
              }
              // Ctrl+C priority: textarea selection (default copy) → grid
              // selection (copy via onCtrlC) → SIGINT to the shell.
              if (
                e.ctrlKey &&
                !e.shiftKey &&
                !e.altKey &&
                e.key.toLowerCase() === "c" &&
                e.currentTarget.selectionStart === e.currentTarget.selectionEnd
              ) {
                e.preventDefault();
                if (!onCtrlC?.()) {
                  clearOptimisticSessionBrand(sessionId);
                  send("\x03");
                  window.setTimeout(() => void refreshSessionInfo(sessionId), 250);
                  window.setTimeout(() => void refreshSessionInfo(sessionId), 1200);
                }
                return;
              }
              const ta = e.currentTarget;
              const atEnd =
                ta.selectionStart === text.length &&
                ta.selectionEnd === text.length;
              // ghost suggestion: → at the end (or Tab) accepts it
              if (ghost && atEnd && (e.key === "ArrowRight" || e.key === "Tab")) {
                e.preventDefault();
                setText(text + ghost);
                return;
              }
              // Tab: command / git subcommand / npm script / path completion
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                void complete(ta);
                return;
              }
              if (e.key === "Escape" && completions) {
                e.preventDefault();
                setCompletions(null);
                return;
              }
              // ↑/↓ history — only when the caret can't move further inside
              // the (possibly multiline) text.
              const collapsed = ta.selectionStart === ta.selectionEnd;
              const items = HISTORY.get(sessionId)!;
              if (e.key === "ArrowUp" && collapsed && items.length > 0) {
                const onFirstLine = !text.slice(0, ta.selectionStart).includes("\n");
                if (!onFirstLine) return;
                e.preventDefault();
                const h = hist.current;
                if (h.index === -1) {
                  h.draft = text;
                  h.index = items.length;
                }
                if (h.index > 0) h.index--;
                recall(ta, items[h.index]);
                return;
              }
              if (e.key === "ArrowDown" && collapsed && hist.current.index !== -1) {
                const onLastLine = !text.slice(ta.selectionEnd).includes("\n");
                if (!onLastLine) return;
                e.preventDefault();
                const h = hist.current;
                h.index++;
                if (h.index >= items.length) {
                  h.index = -1;
                  recall(ta, h.draft);
                } else {
                  recall(ta, items[h.index]);
                }
              }
            }}
            rows={Math.min(8, Math.max(3, text.split("\n").length))}
            aria-label="명령 입력"
            spellCheck={false}
            // Fixed composer size (COMPOSER_FONT_SIZE) — independent of the
            // terminal font slider; must match the ghost overlay above so the
            // suggestion stays aligned with typed text.
            style={{ fontFamily: "var(--app-font)", fontSize: COMPOSER_FONT_SIZE }}
            className={cn(
              "min-h-7 w-full resize-none border-0 bg-transparent px-1.5 py-1 outline-none",
              "placeholder:text-muted-foreground/50"
            )}
          />
          </div>
          {/* agent launcher: runs the selected CLI; chevron switches it */}
          <ToolButton
            tip={
              launcherAgent === "codex"
                ? "Codex 실행"
                : launcherAgent === "opencode"
                  ? "OpenCode 실행"
                  : "Claude 실행"
            }
            size="icon-xs"
            className={cn(
              "mb-0.5",
              agentActionsLocked && "cursor-not-allowed opacity-50"
            )}
            disabled={agentActionsLocked}
            onClick={() => {
              if (agentActionsLocked) return;
              setOptimisticSessionBrand(sessionId, agentCli);
              send(`${agentCli}\r`);
            }}
          >
            {launcherAgent === "codex" ? (
              <span style={{ color: CODEX_BLUE }} className="inline-grid">
                <Codex size={14} />
              </span>
            ) : launcherAgent === "opencode" ? (
              <span style={{ color: "#fff" }} className="inline-grid">
                <OpenCode size={14} />
              </span>
            ) : (
              <ClaudeCode.Color size={14} />
            )}
          </ToolButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="에이전트 선택"
                disabled={agentActionsLocked}
                className={cn(
                  "mb-0.5 grid h-6 w-3.5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3",
                  agentActionsLocked && "cursor-not-allowed"
                )}
              >
                <ChevronDown />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={launcherAgent}
                onValueChange={(v) => {
                  if (agentActionsLocked) return;
                  setSettings({ agentCli: v as AgentCli });
                }}
              >
                <DropdownMenuRadioItem value="claude">
                  <ClaudeCode.Color size={14} />
                  Claude
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="codex">
                  <span style={{ color: CODEX_BLUE }} className="inline-grid">
                    <Codex size={14} />
                  </span>
                  Codex
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="opencode">
                  <span style={{ color: "#fff" }} className="inline-grid">
                    <OpenCode size={14} />
                  </span>
                  OpenCode
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <ToolButton
            tip="실행 (Enter)"
            size="icon-xs"
            className="mb-0.5"
            onClick={run}
          >
            <CornerDownLeft />
          </ToolButton>
        </div>
      </div>
    </div>
  );
});
