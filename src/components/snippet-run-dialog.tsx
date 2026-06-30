import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSnippetRun } from "@/store/snippet-run";
import { snippetParams, resolveSnippet } from "@/store/snippets";

/**
 * Fills a snippet's `{{param}}` placeholders, then runs the resolved command in
 * the target session. Opened by the command palette only when a snippet has
 * params; paramless snippets run immediately without this dialog.
 */
export function SnippetRunDialog() {
  const pending = useSnippetRun((s) => s.pending);
  const close = useSnippetRun((s) => s.close);

  const snippet = pending?.snippet;
  const params = useMemo(
    () => (snippet ? snippetParams(snippet.command) : []),
    [snippet]
  );
  const [values, setValues] = useState<Record<string, string>>({});

  // Reset the form whenever a new snippet is staged.
  useEffect(() => {
    setValues({});
  }, [snippet?.id]);

  if (!pending || !snippet) return null;

  const resolved = resolveSnippet(snippet.command, values);
  const ready = params.every((p) => (values[p] ?? "").trim().length > 0);

  const run = () => {
    if (!ready) return;
    if (pending.sessionId) {
      void invoke("pty_write", {
        id: pending.sessionId,
        data: `${resolved}\r`,
      }).catch(() => {});
    }
    close();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[520px] gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogTitle className="border-b border-border px-5 py-3.5 text-sm font-semibold">
          {snippet.name || "스니펫 실행"}
        </DialogTitle>
        <div className="space-y-3 px-5 py-4">
          {snippet.description && (
            <p className="text-xs text-muted-foreground">{snippet.description}</p>
          )}
          {params.map((p, i) => (
            <label key={p} className="block">
              <span className="mb-1 block font-mono text-xs text-muted-foreground">
                {p}
              </span>
              <Input
                autoFocus={i === 0}
                value={values[p] ?? ""}
                placeholder={p}
                spellCheck={false}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [p]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ready) run();
                }}
                className="h-8 font-mono text-sm"
              />
            </label>
          ))}

          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs break-all text-foreground/80">
            {resolved || <span className="text-muted-foreground">…</span>}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={close}
              className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-accent"
            >
              취소
            </button>
            <button
              onClick={run}
              disabled={!ready}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Play className="size-3.5" />
              실행
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
