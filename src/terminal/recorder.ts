import { useRecordings, type Recording } from "@/store/recordings";

/**
 * Output-stream recorder (PLAN §"세션 녹화/리플레이"). Per session, captures the
 * raw output bytes the terminal renders, with timing, into an asciinema-style
 * cast. Started/stopped from the command palette; fed from the terminal pane's
 * write path. Output-only (like asciinema) — echoed input is captured too since
 * the shell echoes it back into the output stream.
 */
interface ActiveRec {
  startMs: number;
  cols: number;
  rows: number;
  title: string;
  decoder: TextDecoder;
  events: { t: number; data: string }[];
  bytes: number;
}

const active = new Map<string, ActiveRec>();
/** Auto-stop guards so a runaway stream can't exhaust memory. */
const MAX_BYTES = 5_000_000;
const MAX_EVENTS = 200_000;

export function isRecordingSession(id: string): boolean {
  return active.has(id);
}

export function startRecording(
  id: string,
  title: string,
  cols: number,
  rows: number
): void {
  if (active.has(id)) return;
  active.set(id, {
    startMs: performance.now(),
    cols,
    rows,
    title,
    decoder: new TextDecoder(),
    events: [],
    bytes: 0,
  });
  useRecordings.getState().setActive(id, true);
}

export function feedRecording(id: string, bytes: Uint8Array): void {
  const rec = active.get(id);
  if (!rec) return;
  const data = rec.decoder.decode(bytes, { stream: true });
  if (data) {
    rec.events.push({ t: (performance.now() - rec.startMs) / 1000, data });
  }
  rec.bytes += bytes.length;
  if (rec.bytes > MAX_BYTES || rec.events.length > MAX_EVENTS) {
    stopRecording(id);
  }
}

export function stopRecording(id: string): Recording | null {
  const rec = active.get(id);
  if (!rec) return null;
  active.delete(id);
  useRecordings.getState().setActive(id, false);
  if (rec.events.length === 0) return null;
  const recording: Recording = {
    id: `rec-${performance.now().toString(36)}`,
    title: rec.title,
    createdAt: Date.now(),
    cols: rec.cols,
    rows: rec.rows,
    duration: rec.events[rec.events.length - 1].t,
    events: rec.events,
  };
  useRecordings.getState().addRecording(recording);
  return recording;
}

/** Toggle recording for a session; returns the new state (true = recording). */
export function toggleRecording(
  id: string,
  title: string,
  cols: number,
  rows: number
): boolean {
  if (active.has(id)) {
    stopRecording(id);
    return false;
  }
  startRecording(id, title, cols, rows);
  return true;
}
