import { Plus, Trash2, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useTriggers, type TriggerRule } from "@/store/triggers";

/**
 * Settings editor for output trigger rules. The list is the source of truth;
 * `TriggerManager` pushes it to the Rust engine and writes compile errors back
 * into the store (surfaced inline under the pattern field).
 */
export function TriggersSection() {
  const rules = useTriggers((s) => s.rules);
  const errors = useTriggers((s) => s.errors);
  const add = useTriggers((s) => s.add);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">트리거</h2>
        <button
          onClick={add}
          className="flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />
          규칙 추가
        </button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        어느 pane이든 출력이 정규식과 일치하면 알림·소리를 보내거나 명령을
        실행합니다. 보고 있지 않은 백그라운드 pane도 감지됩니다.
      </p>

      {rules.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-center">
          <Zap className="size-5 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            아직 트리거가 없습니다.
          </div>
          <button
            onClick={add}
            className="mt-1 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
          >
            첫 규칙 만들기
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} error={errors[rule.id]} />
          ))}
        </div>
      )}
    </section>
  );
}

function RuleCard({ rule, error }: { rule: TriggerRule; error?: string }) {
  const update = useTriggers((s) => s.update);
  const remove = useTriggers((s) => s.remove);
  const set = (patch: Partial<TriggerRule>) => update(rule.id, patch);

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3.5",
        rule.enabled ? "border-border" : "border-border/60 opacity-60"
      )}
    >
      {/* enable · name · delete */}
      <div className="flex items-center gap-2.5">
        <Switch
          checked={rule.enabled}
          onCheckedChange={(v) => set({ enabled: v })}
        />
        <Input
          value={rule.name}
          placeholder="규칙 이름 (선택)"
          onChange={(e) => set({ name: e.target.value })}
          className="h-8 flex-1 text-sm"
        />
        <button
          onClick={() => remove(rule.id)}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="규칙 삭제"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      {/* pattern + case toggle */}
      <div className="mt-2.5 flex items-center gap-2">
        <Input
          value={rule.pattern}
          placeholder="정규식 패턴 — 예: error|panic|failed"
          spellCheck={false}
          onChange={(e) => set({ pattern: e.target.value })}
          className={cn(
            "h-8 flex-1 font-mono text-xs",
            error && "border-destructive focus-visible:border-destructive"
          )}
        />
        <button
          onClick={() => set({ caseInsensitive: !rule.caseInsensitive })}
          title="대소문자 무시"
          className={cn(
            "h-8 shrink-0 rounded-md border px-2 text-xs font-mono",
            rule.caseInsensitive
              ? "border-primary text-primary"
              : "border-input text-muted-foreground hover:bg-accent"
          )}
        >
          Aa
        </button>
      </div>
      {error && (
        <div className="mt-1 font-mono text-[11px] text-destructive">
          잘못된 정규식: {error}
        </div>
      )}

      {/* actions */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Toggle
          label="알림"
          checked={rule.notify}
          onChange={(v) => set({ notify: v })}
        />
        <Toggle
          label="소리"
          checked={rule.sound}
          onChange={(v) => set({ sound: v })}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          쿨다운
          <Input
            type="number"
            min={0}
            step={500}
            value={rule.cooldownMs || ""}
            placeholder="3000"
            onChange={(e) =>
              set({ cooldownMs: Math.max(0, Number(e.target.value) || 0) })
            }
            className="h-7 w-20 text-xs"
          />
          ms
        </label>
      </div>

      {/* run-command action */}
      <Input
        value={rule.command}
        placeholder="매칭 시 실행할 명령 (선택) — 일치한 pane에서 실행됩니다"
        spellCheck={false}
        onChange={(e) => set({ command: e.target.value })}
        className="mt-2.5 h-8 font-mono text-xs"
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}
