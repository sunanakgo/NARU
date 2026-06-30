import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronLeft,
  Pencil,
  Play,
  Plus,
  Eye,
  Trash2,
  BookText,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRunbooks } from "@/store/runbooks";
import { useWorkspace } from "@/store/workspace";

const RUNNABLE = /^(bash|sh|shell|zsh|console|shell-session|powershell|ps1|fish|bat|cmd)$/i;

/**
 * Runbook pane — a markdown notebook whose shell code blocks run in a chosen
 * session. Lists all runbooks; opening one shows a render/edit view with a
 * per-block "run" button and a target-session selector.
 */
export function RunbookPane({ initialRunbookId }: { initialRunbookId?: string }) {
  const runbooks = useRunbooks((s) => s.runbooks);
  const add = useRunbooks((s) => s.add);
  const remove = useRunbooks((s) => s.remove);
  const [openId, setOpenId] = useState<string | null>(initialRunbookId ?? null);

  const open = runbooks.find((r) => r.id === openId);

  if (open) {
    return <RunbookDetail id={open.id} onBack={() => setOpenId(null)} />;
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-card text-foreground">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <BookText className="size-4" />
          런북
        </div>
        <button
          onClick={() => setOpenId(add())}
          className="flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />새 런북
        </button>
      </div>
      <div className="p-2">
        {runbooks.length === 0 ? (
          <div className="py-12 text-center text-xs text-muted-foreground">
            런북이 없습니다. 새로 만들어 보세요.
          </div>
        ) : (
          runbooks.map((rb) => (
            <div
              key={rb.id}
              className="group flex items-center gap-2 rounded-md px-2.5 py-2 hover:bg-accent/50"
            >
              <button
                onClick={() => setOpenId(rb.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <BookText className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{rb.title || "제목 없음"}</span>
              </button>
              <button
                onClick={() => remove(rb.id)}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                aria-label="런북 삭제"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RunbookDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const runbook = useRunbooks((s) => s.runbooks.find((r) => r.id === id));
  const update = useRunbooks((s) => s.update);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<string>(activeTabId);

  const run = useMemo(() => {
    return (code: string) => {
      const tab = tabs.find((t) => t.id === target) ?? tabs.find((t) => t.id === activeTabId);
      const sid = tab?.panelIds[0];
      if (!sid) return;
      // Each line becomes a typed command line (\r); the shell runs them in
      // sequence. The block lands in the visible terminal as real blocks.
      const data = code.replace(/\r?\n/g, "\r").replace(/\r?$/, "\r");
      void invoke("pty_write", { id: sid, data }).catch(() => {});
    };
  }, [tabs, target, activeTabId]);

  const components = useMemo<Components>(
    () => ({
      pre: ({ children }) => <RunBlock node={children} onRun={run} />,
    }),
    [run]
  );

  if (!runbook) {
    onBack();
    return null;
  }

  return (
    <div className="flex h-full w-full flex-col bg-card text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          목록
        </button>
        <input
          value={runbook.title}
          onChange={(e) => update(id, { title: e.target.value })}
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
          placeholder="런북 제목"
        />
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">실행 대상</span>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="h-7 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tabs.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <button
          onClick={() => setEditing((v) => !v)}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs",
            editing
              ? "border-primary text-primary"
              : "border-input text-muted-foreground hover:bg-accent"
          )}
        >
          {editing ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
          {editing ? "미리보기" : "편집"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {editing ? (
          <textarea
            value={runbook.content}
            onChange={(e) => update(id, { content: e.target.value })}
            spellCheck={false}
            className="h-full w-full resize-none bg-background p-4 font-mono text-xs leading-relaxed outline-none"
          />
        ) : (
          <div className="naru-md px-5 py-4">
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
              {runbook.content}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

function RunBlock({
  node,
  onRun,
}: {
  node: React.ReactNode;
  onRun: (code: string) => void;
}) {
  const codeEl = node as React.ReactElement<{
    className?: string;
    children?: React.ReactNode;
  }>;
  const className = codeEl?.props?.className ?? "";
  const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
  const code = String(codeEl?.props?.children ?? "").replace(/\n$/, "");
  const runnable = lang === "" || RUNNABLE.test(lang);

  return (
    <div className="naru-runblock group">
      <pre className="naru-runblock-pre">
        <code>{code}</code>
      </pre>
      {runnable && code.trim() && (
        <button
          onClick={() => onRun(code)}
          className="naru-runblock-run"
          title="이 블록을 실행"
        >
          <Play className="size-3" />
          실행
        </button>
      )}
    </div>
  );
}
