import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

/**
 * Output trigger rules (the control-tower generalization of the status engine,
 * PLAN §5). Each rule is a regex matched against EVERY pane's output — even
 * background ones — and fires an OS notification / sound and/or runs a command
 * in the matched pane. Authored here, persisted to the kv store, and pushed to
 * the Rust `TriggerEngine` (which owns regex compilation + matching) by
 * `TriggerManager` whenever `rules` changes.
 */
export interface TriggerRule {
  id: string;
  /** Human label; falls back to the pattern when blank. */
  name: string;
  enabled: boolean;
  /** Regex source (Rust `regex` crate syntax). */
  pattern: string;
  caseInsensitive: boolean;
  /** Fire an OS notification on match. */
  notify: boolean;
  /** Play a sound with the notification. */
  sound: boolean;
  /** Command to run in the matched pane on match (empty = none). */
  command: string;
  /** Per-rule cooldown in ms (0 = engine default ~3s). */
  cooldownMs: number;
}

interface TriggersState {
  rules: TriggerRule[];
  /** Compile errors keyed by rule id (set by the engine, NOT persisted). */
  errors: Record<string, string>;
  add: () => string;
  update: (id: string, patch: Partial<TriggerRule>) => void;
  remove: (id: string) => void;
  setErrors: (errors: Record<string, string>) => void;
}

function newId(): string {
  // WebView2 provides crypto.randomUUID; fall back to a counter-free random
  // token if it's ever missing.
  try {
    return crypto.randomUUID();
  } catch {
    return `r-${performance.now().toString(36)}`;
  }
}

function blankRule(): TriggerRule {
  return {
    id: newId(),
    name: "",
    enabled: true,
    pattern: "",
    caseInsensitive: true,
    notify: true,
    sound: false,
    command: "",
    cooldownMs: 0,
  };
}

export const useTriggers = create<TriggersState>()(
  persist(
    (set) => ({
      rules: [],
      errors: {},
      add: () => {
        const rule = blankRule();
        set((s) => ({ rules: [...s.rules, rule] }));
        return rule.id;
      },
      update: (id, patch) =>
        set((s) => ({
          rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        })),
      remove: (id) =>
        set((s) => {
          const errors = { ...s.errors };
          delete errors[id];
          return { rules: s.rules.filter((r) => r.id !== id), errors };
        }),
      setErrors: (errors) => set({ errors }),
    }),
    {
      name: "naru-triggers",
      storage: createJSONStorage(() => kvStorage),
      version: 1,
      // Only the rules are durable — `errors` is derived from the last push.
      partialize: (s) => ({ rules: s.rules }),
    }
  )
);
