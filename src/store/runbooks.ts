import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

/**
 * Runbooks / notebooks (PLAN §"런북/노트북"): a markdown document whose fenced
 * shell code blocks each get a "run" button that sends the command to a chosen
 * session. A living document that is also an executable checklist — onboarding,
 * deploy steps, incident playbooks.
 */
export interface Runbook {
  id: string;
  title: string;
  content: string;
}

const SAMPLE: Runbook = {
  id: "sample",
  title: "시작하기",
  content: `# 런북 시작하기

런북은 **문서이자 실행기**입니다. 아래 셸 코드 블록 위에 마우스를 올리면
나타나는 **실행** 버튼을 누르면, 상단에서 고른 세션에서 그 명령이 실행됩니다.

## 예시

현재 위치와 파일 목록:

\`\`\`bash
pwd
ls
\`\`\`

git 상태 확인:

\`\`\`bash
git status
\`\`\`

> 코드 블록을 직접 편집하려면 우측 상단 **편집**을 누르세요. 마크다운 문법을
> 그대로 쓸 수 있습니다.
`,
};

interface RunbooksState {
  runbooks: Runbook[];
  add: () => string;
  update: (id: string, patch: Partial<Runbook>) => void;
  remove: (id: string) => void;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `rb-${performance.now().toString(36)}`;
  }
}

export const useRunbooks = create<RunbooksState>()(
  persist(
    (set) => ({
      runbooks: [SAMPLE],
      add: () => {
        const rb: Runbook = {
          id: newId(),
          title: "새 런북",
          content: "# 새 런북\n\n```bash\necho hello\n```\n",
        };
        set((s) => ({ runbooks: [...s.runbooks, rb] }));
        return rb.id;
      },
      update: (id, patch) =>
        set((s) => ({
          runbooks: s.runbooks.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        })),
      remove: (id) =>
        set((s) => ({ runbooks: s.runbooks.filter((r) => r.id !== id) })),
    }),
    {
      name: "naru-runbooks",
      storage: createJSONStorage(() => kvStorage),
      version: 1,
    }
  )
);
