import { invoke } from "@tauri-apps/api/core";

import { kvStorage } from "@/lib/kv-storage";
import { IS_MAC } from "@/lib/platform";

export interface RuntimeInfo {
  kind: string;
  version: string | null;
}
export interface RepoInfo {
  name: string | null;
  runtimes: RuntimeInfo[];
}
export interface FsEntry {
  name: string;
  is_dir: boolean;
}
export interface Completion {
  name: string;
  kind: "file" | "dir" | "cmd" | "script";
  /** Full replacement for the current token. */
  insert: string;
}

/** Shell builtins/commands that aren't PATH executables. */
export const BUILTIN_CMDS = [
  "cd", "ls", "dir", "echo", "cat", "type", "pwd", "cls", "clear", "exit",
  "set", "export", "source", "which", "where", "history",
];

export const GIT_SUBCOMMANDS = [
  "add", "bisect", "blame", "branch", "checkout", "cherry-pick", "clean",
  "clone", "commit", "diff", "fetch", "init", "log", "merge", "pull", "push",
  "rebase", "reflog", "remote", "reset", "restore", "revert", "rm", "show",
  "stash", "status", "switch", "tag", "worktree",
];

export interface SlashCmd {
  name: string;
  desc: string;
  /** Set for commands found on disk (custom commands/skills). */
  custom?: boolean;
}

/** Built-in slash commands of the agent CLIs — popped up live while one is
 * running in this session (brand comes from the PTY's process scan). The
 * claude list follows code.claude.com/docs/en/commands (2026-06). Custom
 * commands/skills on disk are merged in via the `agent_commands` backend. */
export const AGENT_SLASH: Record<string, SlashCmd[]> = {
  // OpenCode built-ins follow opencode.ai/docs/tui (2026-06). Custom commands
  // are merged from `.opencode/commands` and `~/.config/opencode/commands`.
  opencode: [
    { name: "/connect", desc: "프로바이더/API 키 연결" },
    { name: "/compact", desc: "현재 세션 요약/압축" },
    { name: "/details", desc: "도구 실행 상세 표시 토글" },
    { name: "/editor", desc: "외부 에디터로 메시지 작성" },
    { name: "/exit", desc: "종료" },
    { name: "/export", desc: "현재 대화를 Markdown으로 내보내기" },
    { name: "/help", desc: "도움말 열기" },
    { name: "/init", desc: "AGENTS.md 생성/갱신" },
    { name: "/models", desc: "사용 가능한 모델 목록" },
    { name: "/new", desc: "새 세션 시작" },
    { name: "/redo", desc: "되돌린 메시지/파일 변경 다시 적용" },
    { name: "/sessions", desc: "세션 목록/이어가기" },
    { name: "/share", desc: "현재 세션 공유 링크 생성" },
    { name: "/summarize", desc: "현재 세션 요약/압축" },
    { name: "/themes", desc: "테마 선택" },
    { name: "/thinking", desc: "reasoning 블록 표시 토글" },
    { name: "/undo", desc: "마지막 메시지와 파일 변경 되돌리기" },
    { name: "/unshare", desc: "공유 링크 제거" },
  ].sort((a, b) => a.name.localeCompare(b.name)),
  claude: [
    { name: "/add-dir", desc: "작업 디렉토리 추가" },
    { name: "/agents", desc: "서브에이전트 관리" },
    { name: "/autofix-pr", desc: "CI 실패 시 PR 자동 수정" },
    { name: "/background", desc: "세션을 백그라운드로 전환" },
    { name: "/batch", desc: "대규모 변경 병렬 처리" },
    { name: "/branch", desc: "현재 대화에서 분기 생성" },
    { name: "/btw", desc: "기록에 안 남는 사이드 질문" },
    { name: "/chrome", desc: "Claude in Chrome 설정" },
    { name: "/claude-api", desc: "Claude API 레퍼런스/마이그레이션" },
    { name: "/clear", desc: "새 대화 시작 (컨텍스트 비움)" },
    { name: "/code-review", desc: "현재 diff 코드 리뷰" },
    { name: "/color", desc: "프롬프트 바 색상 설정" },
    { name: "/compact", desc: "대화 요약으로 컨텍스트 확보" },
    { name: "/config", desc: "설정 열기" },
    { name: "/context", desc: "컨텍스트 사용량 시각화" },
    { name: "/copy", desc: "마지막 응답 복사" },
    { name: "/cost", desc: "사용량/비용 보기" },
    { name: "/debug", desc: "디버그 로깅 + 문제 진단" },
    { name: "/deep-research", desc: "다중 소스 리서치 보고서" },
    { name: "/desktop", desc: "데스크톱 앱에서 이어가기" },
    { name: "/diff", desc: "인터랙티브 diff 뷰어" },
    { name: "/doctor", desc: "설치/설정 진단" },
    { name: "/effort", desc: "모델 effort 레벨 설정" },
    { name: "/exit", desc: "종료" },
    { name: "/export", desc: "대화 내보내기" },
    { name: "/fast", desc: "패스트 모드 토글" },
    { name: "/feedback", desc: "피드백/버그 신고" },
    { name: "/fewer-permission-prompts", desc: "권한 프롬프트 줄이기" },
    { name: "/focus", desc: "포커스 뷰 토글" },
    { name: "/fork", desc: "대화 상속 포크 서브에이전트" },
    { name: "/goal", desc: "목표 설정 — 달성까지 계속 작업" },
    { name: "/help", desc: "도움말" },
    { name: "/hooks", desc: "훅 설정 보기" },
    { name: "/ide", desc: "IDE 연동 관리" },
    { name: "/init", desc: "CLAUDE.md 생성" },
    { name: "/insights", desc: "세션 분석 리포트" },
    { name: "/install-github-app", desc: "GitHub 앱 설치" },
    { name: "/install-slack-app", desc: "Slack 앱 설치" },
    { name: "/keybindings", desc: "키바인딩 설정 열기" },
    { name: "/login", desc: "로그인" },
    { name: "/logout", desc: "로그아웃" },
    { name: "/loop", desc: "프롬프트 반복 실행" },
    { name: "/mcp", desc: "MCP 서버 관리" },
    { name: "/memory", desc: "메모리 파일 편집" },
    { name: "/mobile", desc: "모바일 앱 QR 코드" },
    { name: "/model", desc: "모델 변경" },
    { name: "/permissions", desc: "권한 규칙 관리" },
    { name: "/plan", desc: "플랜 모드 진입" },
    { name: "/plugin", desc: "플러그인 관리" },
    { name: "/powerup", desc: "인터랙티브 기능 학습" },
    { name: "/privacy-settings", desc: "개인정보 설정" },
    { name: "/quit", desc: "종료" },
    { name: "/recap", desc: "세션 한 줄 요약" },
    { name: "/release-notes", desc: "체인지로그 보기" },
    { name: "/reload-plugins", desc: "플러그인 리로드" },
    { name: "/reload-skills", desc: "스킬 디렉토리 재스캔" },
    { name: "/remote-control", desc: "claude.ai 원격 제어 허용" },
    { name: "/remote-env", desc: "웹 세션 기본 원격 환경" },
    { name: "/rename", desc: "세션 이름 변경" },
    { name: "/resume", desc: "이전 대화 이어가기" },
    { name: "/review", desc: "PR 리뷰" },
    { name: "/rewind", desc: "이전 시점으로 되돌리기" },
    { name: "/run", desc: "프로젝트 앱 실행/조작" },
    { name: "/sandbox", desc: "샌드박스 모드 토글" },
    { name: "/schedule", desc: "예약 루틴 관리" },
    { name: "/scroll-speed", desc: "스크롤 속도 조정" },
    { name: "/security-review", desc: "보안 리뷰" },
    { name: "/simplify", desc: "코드 정리 리뷰 + 적용" },
    { name: "/skills", desc: "사용 가능한 스킬 목록" },
    { name: "/stats", desc: "사용량 통계" },
    { name: "/status", desc: "버전/모델/계정 상태" },
    { name: "/statusline", desc: "상태줄 설정" },
    { name: "/stop", desc: "백그라운드 세션 중지" },
    { name: "/tasks", desc: "백그라운드 작업 관리" },
    { name: "/teleport", desc: "웹 세션을 터미널로 가져오기" },
    { name: "/terminal-setup", desc: "터미널 키 설정" },
    { name: "/theme", desc: "컬러 테마 변경" },
    { name: "/tui", desc: "TUI 렌더러 설정" },
    { name: "/ultraplan", desc: "울트라플랜 세션" },
    { name: "/ultrareview", desc: "클라우드 멀티에이전트 리뷰" },
    { name: "/upgrade", desc: "플랜 업그레이드" },
    { name: "/usage", desc: "플랜 사용량/비용 보기" },
    { name: "/verify", desc: "변경 동작 검증" },
    { name: "/voice", desc: "음성 입력 토글" },
    { name: "/workflows", desc: "워크플로 진행 보기" },
  ],
  // Codex list follows the TUI source of truth (openai/codex
  // codex-rs/tui/src/slash_command.rs, 2026-06); debug-only commands omitted.
  codex: [
    { name: "/agent", desc: "활성 에이전트 스레드 전환" },
    { name: "/approve", desc: "자동 리뷰 거부 재시도 승인" },
    { name: "/archive", desc: "세션 보관 후 종료" },
    { name: "/btw", desc: "임시 포크 사이드 대화" },
    { name: "/clear", desc: "화면 지우고 새 대화" },
    { name: "/compact", desc: "대화 요약으로 컨텍스트 확보" },
    { name: "/copy", desc: "마지막 응답 마크다운 복사" },
    { name: "/diff", desc: "git diff 보기 (미추적 포함)" },
    { name: "/exit", desc: "종료" },
    { name: "/experimental", desc: "실험 기능 토글" },
    { name: "/feedback", desc: "로그 전송 (피드백)" },
    { name: "/fork", desc: "현재 대화 포크" },
    { name: "/goal", desc: "장기 작업 목표 설정/보기" },
    { name: "/hooks", desc: "라이프사이클 훅 관리" },
    { name: "/ide", desc: "IDE 선택 영역/열린 파일 포함" },
    { name: "/init", desc: "AGENTS.md 생성" },
    { name: "/keymap", desc: "TUI 단축키 리맵" },
    { name: "/logout", desc: "로그아웃" },
    { name: "/mcp", desc: "MCP 도구 목록" },
    { name: "/memories", desc: "메모리 사용/생성 설정" },
    { name: "/mention", desc: "파일 멘션" },
    { name: "/model", desc: "모델/리즈닝 레벨 선택" },
    { name: "/new", desc: "새 대화 시작" },
    { name: "/permissions", desc: "Codex 권한 설정" },
    { name: "/personality", desc: "커뮤니케이션 스타일 선택" },
    { name: "/pets", desc: "터미널 펫 선택/숨김" },
    { name: "/plan", desc: "플랜 모드 전환" },
    { name: "/plugins", desc: "플러그인 탐색" },
    { name: "/ps", desc: "백그라운드 터미널 목록" },
    { name: "/quit", desc: "종료" },
    { name: "/raw", desc: "raw 스크롤백 모드 토글" },
    { name: "/realtime", desc: "실시간 음성 모드 토글" },
    { name: "/rename", desc: "스레드 이름 변경" },
    { name: "/resume", desc: "저장된 대화 이어가기" },
    { name: "/review", desc: "현재 변경 리뷰" },
    { name: "/settings", desc: "실시간 마이크/스피커 설정" },
    { name: "/side", desc: "임시 포크 사이드 대화" },
    { name: "/skills", desc: "스킬 사용" },
    { name: "/status", desc: "세션 설정/토큰 사용량" },
    { name: "/statusline", desc: "상태줄 항목 설정" },
    { name: "/stop", desc: "백그라운드 터미널 모두 중지" },
    { name: "/theme", desc: "구문 강조 테마 선택" },
    { name: "/title", desc: "터미널 타이틀 항목 설정" },
    { name: "/vim", desc: "컴포저 Vim 모드 토글" },
    { name: "/app", desc: "Codex Desktop에서 이어가기" },
    { name: "/setup-default-sandbox", desc: "상승된 샌드박스 설정" },
    // Windows-only in the codex TUI
    ...(IS_MAC
      ? []
      : [{ name: "/sandbox-add-read-dir", desc: "샌드박스 읽기 디렉토리 추가" }]),
  ].sort((a, b) => a.name.localeCompare(b.name)),
};

/** PATH executables, fetched once per app run. */
let PATH_CMDS: string[] | null = null;
export async function pathCommands(): Promise<string[]> {
  if (!PATH_CMDS) {
    PATH_CMDS = await invoke<string[]>("list_path_commands").catch(() => []);
  }
  return PATH_CMDS;
}

export const HISTORY_CAP = 100;
/** Keep at most this many session buckets — oldest-used are evicted so the
 * Map and its kv-store mirror don't grow forever across pane lifecycles. */
export const SESSION_CAP = 50;
const HISTORY_STORAGE_KEY = "naru-input-history-v1";

// Recency of session ids (oldest → newest). Updated on every access so the
// least-recently-used bucket is the one dropped when we exceed SESSION_CAP.
const sessionRecency: string[] = [];
const touchSession = (sessionId: string) => {
  const at = sessionRecency.indexOf(sessionId);
  if (at !== -1) sessionRecency.splice(at, 1);
  sessionRecency.push(sessionId);
};

const loadHistory = () => {
  if (typeof window === "undefined") return new Map<string, string[]>();
  try {
    // kvStorage (disk-backed, crash-safe) — raw localStorage here had the
    // exact lazy-flush data-loss problem the kv layer was built to fix.
    // The adapter is synchronous (in-memory cache filled by preload).
    const raw = kvStorage.getItem(HISTORY_STORAGE_KEY) as string | null;
    if (!raw) return new Map<string, string[]>();
    const entries = JSON.parse(raw) as Array<[string, string[]]>;
    // Persisted order is oldest → newest; seed recency to match so the LRU
    // cap survives restarts. Trim to the most recent SESSION_CAP buckets.
    const kept = entries.slice(-SESSION_CAP);
    for (const [id] of kept) sessionRecency.push(id);
    return new Map(
      kept.map(([id, items]) => [
        id,
        Array.isArray(items) ? items.slice(-HISTORY_CAP) : [],
      ])
    );
  } catch {
    return new Map<string, string[]>();
  }
};

const saveHistory = () => {
  if (typeof window === "undefined") return;
  // Evict least-recently-used buckets beyond SESSION_CAP from both the live
  // Map and the persisted mirror.
  while (sessionRecency.length > SESSION_CAP) {
    const stale = sessionRecency.shift();
    if (stale !== undefined) HISTORY.delete(stale);
  }
  try {
    // Persist in recency order (oldest → newest) so load() can rebuild it.
    const ordered: Array<[string, string[]]> = [];
    for (const id of sessionRecency) {
      const items = HISTORY.get(id);
      if (items) ordered.push([id, items.slice(-HISTORY_CAP)]);
    }
    void kvStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(ordered));
  } catch {
    /* storage unavailable or full */
  }
};

/** Per-session command history, persisted across app restarts. */
export const HISTORY = loadHistory();

export const ensureHistory = (sessionId: string) => {
  touchSession(sessionId);
  if (!HISTORY.has(sessionId)) {
    HISTORY.set(sessionId, []);
    saveHistory();
  }
  return HISTORY.get(sessionId)!;
};

export const pushHistory = (sessionId: string, command: string) => {
  const cmd = command.trim();
  if (!cmd) return;
  const items = ensureHistory(sessionId);
  if (items[items.length - 1] !== cmd) {
    items.push(cmd);
    if (items.length > HISTORY_CAP) items.shift();
    saveHistory();
  }
};

export const lcp = (items: string[]) => {
  if (items.length === 0) return "";
  let p = items[0];
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i].toLowerCase() === s[i].toLowerCase()) i++;
    p = p.slice(0, i);
  }
  return p;
};
