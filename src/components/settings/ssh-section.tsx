import { Plus, Trash2, Server, Play } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  useSshHosts,
  sshCommand,
  isConnectable,
  type SshHost,
} from "@/store/ssh-hosts";
import { useWorkspaceCommand } from "@/store/workspace-command";

/**
 * SSH host manager. Connecting opens a new terminal pane running the system
 * `ssh` — so the user's ssh config / keys / known_hosts apply unchanged.
 */
export function SshSection() {
  const hosts = useSshHosts((s) => s.hosts);
  const add = useSshHosts((s) => s.add);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">SSH 호스트</h2>
        <button
          onClick={add}
          className="flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />
          호스트 추가
        </button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        접속하면 새 터미널 pane에서 시스템 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">ssh</code>{" "}
        가 실행됩니다 — 기존 ssh 설정·키·known_hosts가 그대로 적용됩니다. 커맨드
        팔레트(⌘K)의 "SSH"에서도 접속할 수 있습니다.
      </p>

      {hosts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-center">
          <Server className="size-5 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            저장된 호스트가 없습니다.
          </div>
          <button
            onClick={add}
            className="mt-1 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
          >
            첫 호스트 추가
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {hosts.map((h) => (
            <HostCard key={h.id} host={h} />
          ))}
        </div>
      )}
    </section>
  );
}

function HostCard({ host }: { host: SshHost }) {
  const update = useSshHosts((s) => s.update);
  const remove = useSshHosts((s) => s.remove);
  const set = (patch: Partial<SshHost>) => update(host.id, patch);
  const connectable = isConnectable(host);

  const connect = () => {
    if (!connectable) return;
    useWorkspaceCommand.getState().dispatch("newTerminal", sshCommand(host));
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-2.5">
        <Input
          value={host.label}
          placeholder="별칭 — 예: 프로덕션 웹"
          onChange={(e) => set({ label: e.target.value })}
          className="h-8 flex-1 text-sm font-medium"
        />
        <button
          onClick={connect}
          disabled={!connectable}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          <Play className="size-3.5" />
          접속
        </button>
        <button
          onClick={() => remove(host.id)}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="호스트 삭제"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="mt-2.5 grid grid-cols-[1fr_1fr_80px] gap-2">
        <Field label="사용자">
          <Input
            value={host.user}
            placeholder="root"
            spellCheck={false}
            onChange={(e) => set({ user: e.target.value })}
            className="h-8 font-mono text-xs"
          />
        </Field>
        <Field label="호스트">
          <Input
            value={host.host}
            placeholder="example.com"
            spellCheck={false}
            onChange={(e) => set({ host: e.target.value })}
            className="h-8 font-mono text-xs"
          />
        </Field>
        <Field label="포트">
          <Input
            value={host.port}
            placeholder="22"
            spellCheck={false}
            onChange={(e) => set({ port: e.target.value })}
            className="h-8 font-mono text-xs"
          />
        </Field>
      </div>
      <Field label="추가 인자">
        <Input
          value={host.extraArgs}
          placeholder="-A -J jumphost"
          spellCheck={false}
          onChange={(e) => set({ extraArgs: e.target.value })}
          className="mt-2 h-8 font-mono text-xs"
        />
      </Field>
      {connectable && (
        <div className="mt-2.5 rounded-md border border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] break-all text-muted-foreground">
          $ {sshCommand(host)}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
