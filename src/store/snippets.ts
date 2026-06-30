import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

/**
 * Saved command snippets / workflows (PLAN §"Workflows/스니펫"). A snippet is a
 * reusable command template with `{{param}}` placeholders (e.g.
 * `deploy {{env}}`); invoking it from the command palette fills the params and
 * runs the resolved command in the active session.
 */
export interface Snippet {
  id: string;
  name: string;
  description: string;
  /** Command template; `{{param}}` placeholders are prompted for on run. */
  command: string;
}

interface SnippetsState {
  snippets: Snippet[];
  add: () => string;
  update: (id: string, patch: Partial<Snippet>) => void;
  remove: (id: string) => void;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${performance.now().toString(36)}`;
  }
}

/** Unique `{{param}}` names in template order. */
export function snippetParams(command: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Substitute `{{param}}` placeholders with the supplied values. */
export function resolveSnippet(
  command: string,
  values: Record<string, string>
): string {
  return command.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, name) =>
    values[name] !== undefined ? values[name] : ""
  );
}

export const useSnippets = create<SnippetsState>()(
  persist(
    (set) => ({
      snippets: [],
      add: () => {
        const snippet: Snippet = {
          id: newId(),
          name: "",
          description: "",
          command: "",
        };
        set((s) => ({ snippets: [...s.snippets, snippet] }));
        return snippet.id;
      },
      update: (id, patch) =>
        set((s) => ({
          snippets: s.snippets.map((sn) =>
            sn.id === id ? { ...sn, ...patch } : sn
          ),
        })),
      remove: (id) =>
        set((s) => ({ snippets: s.snippets.filter((sn) => sn.id !== id) })),
    }),
    {
      name: "naru-snippets",
      storage: createJSONStorage(() => kvStorage),
      version: 1,
    }
  )
);
