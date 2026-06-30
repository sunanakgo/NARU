import { useEffect, useState } from "react";
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import {
  Bell,
  Download,
  Info,
  Keyboard,
  Palette,
  Server,
  SquareCode,
  SquareTerminal,
  Zap,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { NaruLogo } from "@/components/common/naru-logo";
import { useTheme } from "@/store/theme";
import { useSettings, type CursorStyle } from "@/store/settings";
import { useUpdater } from "@/store/updater";
import { useOverlay } from "@/store/overlay";
import { useKeymap, ACTIONS } from "@/store/keymap";
import { eventToCombo, comboLabel } from "@/lib/keys";
import { PRESETS } from "@/theme/presets";
import { TriggersSection } from "@/components/settings/triggers-section";
import { SnippetsSection } from "@/components/settings/snippets-section";
import { SshSection } from "@/components/settings/ssh-section";

/** Curated monospace fonts for the terminal-font picker. Only JetBrains Mono is
 * bundled; the rest fall back through the shared stack if not installed. */
const TERMINAL_FONTS: { label: string; primary: string }[] = [
  { label: "JetBrains Mono", primary: '"JetBrains Mono"' },
  { label: "Cascadia Code", primary: '"Cascadia Code"' },
  { label: "Cascadia Mono", primary: '"Cascadia Mono"' },
  { label: "Consolas", primary: "Consolas" },
  { label: "Fira Code", primary: '"Fira Code"' },
  { label: "Source Code Pro", primary: '"Source Code Pro"' },
  { label: "IBM Plex Mono", primary: '"IBM Plex Mono"' },
  { label: "Hack", primary: "Hack" },
  { label: "D2Coding", primary: '"D2Coding"' },
];
const CUSTOM_FONT = "__custom__";
/** Wrap a primary family in the shared fallback stack (CJK + monospace). */
function termFontStack(primary: string): string {
  return `${primary}, ui-monospace, "Cascadia Code", Menlo, Consolas, "D2Coding", "Malgun Gothic", monospace`;
}

interface SettingsDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}
export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

type SectionId =
  | "appearance"
  | "terminal"
  | "notifications"
  | "shortcuts"
  | "triggers"
  | "snippets"
  | "ssh"
  | "updates"
  | "about";

const NAV: {
  group: string;
  items: { id: SectionId; label: string; icon: typeof Info }[];
}[] = [
  {
    group: "일반",
    items: [
      { id: "appearance", label: "모양", icon: Palette },
      { id: "terminal", label: "터미널", icon: SquareTerminal },
      { id: "notifications", label: "알림", icon: Bell },
      { id: "shortcuts", label: "단축키", icon: Keyboard },
    ],
  },
  {
    group: "기능",
    items: [
      { id: "triggers", label: "트리거", icon: Zap },
      { id: "snippets", label: "스니펫", icon: SquareCode },
      { id: "ssh", label: "SSH", icon: Server },
    ],
  },
  {
    group: "정보",
    items: [
      { id: "updates", label: "업데이트", icon: Download },
      { id: "about", label: "정보", icon: Info },
    ],
  },
];

export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open);
  const setOpen = useSettingsDialog((s) => s.setOpen);
  const [section, setSection] = useState<SectionId>("appearance");

  // Hide native webviews while the dialog is up (they float over the DOM).
  useEffect(() => {
    if (!open) return;
    useOverlay.getState().inc();
    return () => useOverlay.getState().dec();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton
        // grid-rows-[1fr]: the default auto row makes the child's h-full
        // resolve to content height, which silently kills inner scrolling.
        className="h-[80vh] max-w-[920px] grid-rows-[1fr] gap-0 overflow-hidden p-0 sm:max-w-[920px]"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex h-full min-h-0">
          {/* left nav */}
          <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar p-2">
            <div className="flex-1 space-y-4 overflow-y-auto py-1">
              {NAV.map((g) => (
                <div key={g.group} className="space-y-0.5">
                  <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
                    {g.group}
                  </div>
                  {g.items.map((it) => {
                    const Icon = it.icon;
                    const active = section === it.id;
                    return (
                      <button
                        key={it.id}
                        onClick={() => setSection(it.id)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                          active
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/50"
                        )}
                      >
                        <Icon className="size-4" />
                        {it.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 px-2 pt-2 text-[11px] text-muted-foreground">
              <NaruLogo className="size-4" />
              <div>
                <div className="font-medium text-foreground/80">Desktop</div>
                <div>v0.1.2</div>
              </div>
            </div>
          </nav>

          {/* content */}
          <div className="min-w-0 flex-1 overflow-y-auto px-7 py-6">
            {section === "appearance" && <AppearanceSection />}
            {section === "terminal" && <TerminalSection />}
            {section === "notifications" && <NotificationsSection />}
            {section === "shortcuts" && <ShortcutsSection />}
            {section === "triggers" && <TriggersSection />}
            {section === "snippets" && <SnippetsSection />}
            {section === "ssh" && <SshSection />}
            {section === "updates" && <UpdatesSection />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppearanceSection() {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);
  const presetId = useTheme((s) => s.presetId);
  const setPreset = useTheme((s) => s.setPreset);
  const s = useSettings();

  return (
    <Section title="모양" desc="색상 모드·테마·인터페이스 폰트.">
      <Card>
        <SettingRow
          title="색상 모드"
          desc="시스템 설정을 따르거나 라이트·다크로 고정합니다."
        >
          <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">시스템</SelectItem>
              <SelectItem value="light">라이트</SelectItem>
              <SelectItem value="dark">다크</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow title="테마" desc="NARU 전체에 적용되는 색상 프리셋.">
          <Select value={presetId} onValueChange={setPreset}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow title="UI 폰트" desc="인터페이스 전반에 사용할 폰트.">
          <Input
            value={s.uiFont}
            placeholder="시스템 기본값"
            onChange={(e) => s.set({ uiFont: e.target.value })}
            className="w-56"
          />
        </SettingRow>

        <SettingRow title="창 블러" desc="아크릴/블러 창 배경 (실험적).">
          <Switch
            checked={s.windowBlur}
            onCheckedChange={(v) => s.set({ windowBlur: v })}
          />
        </SettingRow>
      </Card>
    </Section>
  );
}

function TerminalSection() {
  const s = useSettings();
  const termFontPrimary =
    TERMINAL_FONTS.find((f) => termFontStack(f.primary) === s.fontFamily)
      ?.primary ?? CUSTOM_FONT;

  return (
    <Section title="터미널" desc="폰트·커서·스크롤백과 Warp식 입력 동작.">
      <Card>
        <SettingRow title="터미널 폰트" desc="터미널에 사용할 고정폭 폰트.">
          <Select
            value={termFontPrimary}
            onValueChange={(v) => {
              if (v !== CUSTOM_FONT) s.set({ fontFamily: termFontStack(v) });
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONTS.map((f) => (
                <SelectItem
                  key={f.primary}
                  value={f.primary}
                  style={{ fontFamily: termFontStack(f.primary) }}
                >
                  {f.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_FONT}>사용자 지정…</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        {termFontPrimary === CUSTOM_FONT && (
          <SettingRow
            title="폰트 직접 입력"
            desc="CSS font-family 스택을 직접 지정합니다."
          >
            <Input
              value={s.fontFamily}
              onChange={(e) => s.set({ fontFamily: e.target.value })}
              className="w-56 font-mono text-xs"
            />
          </SettingRow>
        )}
        <SettingRow title="글자 크기" desc={`${s.fontSize}px`}>
          <Slider
            className="w-40"
            min={10}
            max={24}
            step={1}
            value={[s.fontSize]}
            onValueChange={([v]) => s.set({ fontSize: v })}
          />
        </SettingRow>
        <SettingRow title="커서 모양" desc="터미널 커서의 형태.">
          <Select
            value={s.cursorStyle}
            onValueChange={(v) => s.set({ cursorStyle: v as CursorStyle })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bar">막대</SelectItem>
              <SelectItem value="block">블록</SelectItem>
              <SelectItem value="underline">밑줄</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="커서 깜빡임" desc="터미널 커서를 깜빡입니다.">
          <Switch
            checked={s.cursorBlink}
            onCheckedChange={(v) => s.set({ cursorBlink: v })}
          />
        </SettingRow>
        <SettingRow title="스크롤백" desc={`${s.scrollback.toLocaleString()}줄`}>
          <Slider
            className="w-40"
            min={1000}
            max={50000}
            step={1000}
            value={[s.scrollback]}
            onValueChange={([v]) => s.set({ scrollback: v })}
          />
        </SettingRow>
        <SettingRow
          title="하단 명령 입력바"
          desc="Warp식 채팅형 입력. 켜면 셸 프롬프트가 '>'로 최소화됩니다 (새 셸부터 적용)."
        >
          <Switch
            checked={s.inputBar}
            onCheckedChange={(v) => s.set({ inputBar: v })}
          />
        </SettingRow>
      </Card>
    </Section>
  );
}

function NotificationsSection() {
  const s = useSettings();
  return (
    <Section title="알림" desc="세션이 포커스되지 않았을 때의 OS 알림.">
      <Card>
        <SettingRow
          title="알림 사용"
          desc="세션이 포커스되지 않았을 때 OS 알림을 보냅니다 (마스터 스위치)."
        >
          <Switch
            checked={s.notificationsEnabled}
            onCheckedChange={(v) => s.set({ notificationsEnabled: v })}
          />
        </SettingRow>
        <SettingRow title="에이전트 입력 대기" desc="사용자 입력을 기다릴 때.">
          <Switch
            checked={s.notifyWaiting}
            onCheckedChange={(v) => s.set({ notifyWaiting: v })}
          />
        </SettingRow>
        <SettingRow title="명령 실패" desc="종료 코드가 0이 아닐 때.">
          <Switch
            checked={s.notifyError}
            onCheckedChange={(v) => s.set({ notifyError: v })}
          />
        </SettingRow>
        <SettingRow title="명령 완료" desc="명령이 끝났을 때.">
          <Switch
            checked={s.notifyDone}
            onCheckedChange={(v) => s.set({ notifyDone: v })}
          />
        </SettingRow>
        <SettingRow title="알림 소리" desc="알림과 함께 소리를 재생합니다.">
          <Switch
            checked={s.notifySound}
            onCheckedChange={(v) => s.set({ notifySound: v })}
          />
        </SettingRow>
      </Card>
    </Section>
  );
}

function UpdatesSection() {
  const phase = useUpdater((s) => s.phase);
  const version = useUpdater((s) => s.version);
  const progress = useUpdater((s) => s.progress);
  const error = useUpdater((s) => s.error);
  const checkForUpdate = useUpdater((s) => s.checkForUpdate);
  const downloadAndInstall = useUpdater((s) => s.downloadAndInstall);
  const [current, setCurrent] = useState("");

  useEffect(() => {
    getVersion()
      .then(setCurrent)
      .catch(() => {});
  }, []);

  const status =
    phase === "checking"
      ? "확인 중…"
      : phase === "available"
        ? `새 버전 v${version} 사용 가능`
        : phase === "downloading"
          ? `다운로드 중… ${progress != null ? Math.round(progress * 100) + "%" : ""}`
          : phase === "installing"
            ? "설치 중… 곧 재시작됩니다"
            : phase === "error"
              ? `오류: ${error ?? "알 수 없음"}`
              : "최신 상태입니다";

  const busy = phase === "downloading" || phase === "installing";

  return (
    <Section
      title="업데이트"
      desc="GitHub 릴리즈에서 새 버전을 받아 자동 설치합니다."
    >
      <Card>
        <SettingRow title="현재 버전" desc="설치된 NARU 버전.">
          <span className="text-sm text-muted-foreground">
            v{current || "…"}
          </span>
        </SettingRow>
        <SettingRow title="업데이트 확인" desc={status}>
          {phase === "available" || phase === "error" ? (
            <button
              disabled={busy}
              onClick={() => void downloadAndInstall()}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Download className="size-3.5" />
              {phase === "error" ? "다시 시도" : "지금 설치"}
            </button>
          ) : (
            <button
              disabled={busy || phase === "checking"}
              onClick={() => void checkForUpdate()}
              className="rounded-md border border-input px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              확인
            </button>
          )}
        </SettingRow>
      </Card>
    </Section>
  );
}

function AboutSection() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  return (
    <Section title="정보">
      <Card>
        <div className="px-4 py-4 text-sm">
          <NaruLogo className="size-7" />
          <p className="mt-2 text-xs text-muted-foreground">
            AI 에이전트 관제탑 터미널 워크스페이스{version ? ` · v${version}` : ""}
          </p>
        </div>
      </Card>
    </Section>
  );
}

function ShortcutsSection() {
  const bindings = useKeymap((s) => s.bindings);
  const setBinding = useKeymap((s) => s.setBinding);
  const setRecording = useKeymap((s) => s.setRecording);
  const recording = useKeymap((s) => s.recording);
  const reset = useKeymap((s) => s.reset);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = eventToCombo(e);
      if (!combo) return; // modifier alone — keep waiting
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      setBinding(recording, combo);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, setBinding, setRecording]);

  return (
    <Section title="단축키" desc="키를 눌러 동작에 새 단축키를 지정합니다.">
      <Card>
        {ACTIONS.map((a) => (
          <SettingRow key={a.id} title={a.label}>
            <button
              onClick={() => setRecording(a.id)}
              className={cn(
                "min-w-28 rounded-md border px-2.5 py-1 text-xs",
                recording === a.id
                  ? "animate-pulse border-primary text-primary"
                  : "border-input text-muted-foreground hover:bg-accent"
              )}
            >
              {recording === a.id
                ? "키를 누르세요… (Esc 취소)"
                : comboLabel(bindings[a.id] ?? a.default)}
            </button>
          </SettingRow>
        ))}
      </Card>
      <button
        onClick={reset}
        className="mt-3 text-xs text-muted-foreground hover:text-foreground"
      >
        기본값으로 초기화
      </button>
    </Section>
  );
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {desc && <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{desc}</p>}
      {!desc && <div className="mb-3" />}
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {children}
    </div>
  );
}

function SettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
