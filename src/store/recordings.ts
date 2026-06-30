import { create } from "zustand";

/**
 * Session recordings (PLAN §"세션 녹화/리플레이"), asciinema-style. The recorder
 * (`terminal/recorder.ts`) tees a session's output stream with timing; a
 * finished recording lands here and replays in a replay pane. In-memory only
 * for now (a cast can be large) — they live for the app session.
 */
export interface CastEvent {
  /** Seconds since recording start. */
  t: number;
  /** Output text emitted at `t`. */
  data: string;
}

export interface Recording {
  id: string;
  title: string;
  createdAt: number;
  cols: number;
  rows: number;
  duration: number;
  events: CastEvent[];
}

/** Keep memory bounded — oldest recordings drop past this many. */
const MAX_RECORDINGS = 30;

interface RecordingsState {
  recordings: Recording[];
  /** sessionId → currently recording (reactive mirror for UI badges). */
  active: Record<string, boolean>;
  addRecording: (r: Recording) => void;
  removeRecording: (id: string) => void;
  setActive: (sessionId: string, on: boolean) => void;
}

export const useRecordings = create<RecordingsState>((set) => ({
  recordings: [],
  active: {},
  addRecording: (r) =>
    set((s) => ({ recordings: [r, ...s.recordings].slice(0, MAX_RECORDINGS) })),
  removeRecording: (id) =>
    set((s) => ({ recordings: s.recordings.filter((r) => r.id !== id) })),
  setActive: (sessionId, on) =>
    set((s) => {
      if ((s.active[sessionId] ?? false) === on) return s;
      const active = { ...s.active };
      if (on) active[sessionId] = true;
      else delete active[sessionId];
      return { active };
    }),
}));
