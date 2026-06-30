import { Plus, Trash2, SquareCode } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useSnippets, snippetParams, type Snippet } from "@/store/snippets";

/**
 * Settings editor for command snippets / workflows. Each snippet is a command
 * template with optional `{{param}}` placeholders, invoked from the command
 * palette (`전체 검색`'s neighbor in the Actions list).
 */
export function SnippetsSection() {
  const snippets = useSnippets((s) => s.snippets);
  const add = useSnippets((s) => s.add);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">스니펫</h2>
        <button
          onClick={add}
          className="flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />
          스니펫 추가
        </button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        자주 쓰는 명령을 저장해 커맨드 팔레트(⌘K)에서 실행합니다.{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          {"{{이름}}"}
        </code>{" "}
        형태의 자리표시자는 실행 시 입력받습니다.
      </p>

      {snippets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-center">
          <SquareCode className="size-5 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            저장된 스니펫이 없습니다.
          </div>
          <button
            onClick={add}
            className="mt-1 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
          >
            첫 스니펫 만들기
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {snippets.map((sn) => (
            <SnippetCard key={sn.id} snippet={sn} />
          ))}
        </div>
      )}
    </section>
  );
}

function SnippetCard({ snippet }: { snippet: Snippet }) {
  const update = useSnippets((s) => s.update);
  const remove = useSnippets((s) => s.remove);
  const set = (patch: Partial<Snippet>) => update(snippet.id, patch);
  const params = snippetParams(snippet.command);

  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-2.5">
        <Input
          value={snippet.name}
          placeholder="이름 — 예: 프로덕션 배포"
          onChange={(e) => set({ name: e.target.value })}
          className="h-8 flex-1 text-sm font-medium"
        />
        <button
          onClick={() => remove(snippet.id)}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="스니펫 삭제"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <Input
        value={snippet.command}
        placeholder="명령 — 예: pnpm deploy {{env}}"
        spellCheck={false}
        onChange={(e) => set({ command: e.target.value })}
        className="mt-2.5 h-8 font-mono text-xs"
      />
      <Input
        value={snippet.description}
        placeholder="설명 (선택)"
        onChange={(e) => set({ description: e.target.value })}
        className="mt-2 h-8 text-xs"
      />
      {params.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">자리표시자</span>
          {params.map((p) => (
            <span
              key={p}
              className="rounded bg-primary/10 px-1.5 font-mono text-[10.5px] font-medium text-primary"
            >
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
