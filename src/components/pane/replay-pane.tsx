import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronLeft,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Film,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildTerminalTheme } from "@/terminal/theme";
import { useSettings } from "@/store/settings";
import { useRecordings, type Recording } from "@/store/recordings";

const SPEEDS = [0.5, 1, 2, 4];

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Replay pane — lists recordings; opening one shows an asciinema-style player. */
export function ReplayPane() {
  const recordings = useRecordings((s) => s.recordings);
  const remove = useRecordings((s) => s.removeRecording);
  const [openId, setOpenId] = useState<string | null>(null);

  const open = recordings.find((r) => r.id === openId);
  if (open) return <ReplayPlayer recording={open} onBack={() => setOpenId(null)} />;

  return (
    <div className="h-full w-full overflow-y-auto bg-card text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
        <Film className="size-4" />
        세션 녹화
      </div>
      <div className="p-2">
        {recordings.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-muted-foreground">
            녹화가 없습니다. 커맨드 팔레트(⌘K)의 "세션 녹화 시작"으로 녹화하세요.
          </div>
        ) : (
          recordings.map((r) => (
            <div
              key={r.id}
              className="group flex items-center gap-2 rounded-md px-2.5 py-2 hover:bg-accent/50"
            >
              <button
                onClick={() => setOpenId(r.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Play className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{r.title}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                  {fmtTime(r.duration)}
                </span>
              </button>
              <button
                onClick={() => remove(r.id)}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                aria-label="녹화 삭제"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ReplayPlayer({
  recording,
  onBack,
}: {
  recording: Recording;
  onBack: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const rafRef = useRef<number>(0);
  const indexRef = useRef(0);
  const progressRef = useRef(0);
  const playingRef = useRef(false);
  const anchorWallRef = useRef(0);
  const anchorTRef = useRef(0);
  const speedRef = useRef(1);

  const [playing, setPlaying] = useState(false);
  const [progress, setProgressState] = useState(0);
  const [speed, setSpeed] = useState(1);

  // Build the replay terminal once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const s = useSettings.getState();
    const term = new Terminal({
      cols: recording.cols || 80,
      rows: recording.rows || 24,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: 1.2,
      theme: buildTerminalTheme(),
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false,
    });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(container);
    termRef.current = term;
    return () => {
      cancelAnimationFrame(rafRef.current);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.id]);

  const setProgress = (t: number) => {
    progressRef.current = t;
    setProgressState(t);
  };

  /** Write every event up to time `t` from the current index forward. */
  const writeUpTo = (t: number) => {
    const term = termRef.current;
    if (!term) return;
    const ev = recording.events;
    while (indexRef.current < ev.length && ev[indexRef.current].t <= t) {
      term.write(ev[indexRef.current].data);
      indexRef.current++;
    }
  };

  const stopLoop = () => {
    cancelAnimationFrame(rafRef.current);
    playingRef.current = false;
    setPlaying(false);
  };

  const loop = () => {
    const now = performance.now();
    const t =
      anchorTRef.current + ((now - anchorWallRef.current) / 1000) * speedRef.current;
    writeUpTo(t);
    if (indexRef.current >= recording.events.length) {
      setProgress(recording.duration);
      stopLoop();
      return;
    }
    setProgress(t);
    rafRef.current = requestAnimationFrame(loop);
  };

  const play = () => {
    if (progressRef.current >= recording.duration) restart();
    playingRef.current = true;
    setPlaying(true);
    anchorWallRef.current = performance.now();
    anchorTRef.current = progressRef.current;
    rafRef.current = requestAnimationFrame(loop);
  };

  const pause = () => stopLoop();

  const restart = () => {
    cancelAnimationFrame(rafRef.current);
    termRef.current?.reset();
    indexRef.current = 0;
    setProgress(0);
    if (playingRef.current) {
      anchorWallRef.current = performance.now();
      anchorTRef.current = 0;
      rafRef.current = requestAnimationFrame(loop);
    }
  };

  const seek = (target: number) => {
    cancelAnimationFrame(rafRef.current);
    if (target < progressRef.current) {
      termRef.current?.reset();
      indexRef.current = 0;
    }
    writeUpTo(target);
    setProgress(target);
    if (playingRef.current) {
      anchorWallRef.current = performance.now();
      anchorTRef.current = target;
      rafRef.current = requestAnimationFrame(loop);
    }
  };

  const changeSpeed = (v: number) => {
    speedRef.current = v;
    setSpeed(v);
    // Re-anchor so the new rate applies from the current position.
    if (playingRef.current) {
      anchorWallRef.current = performance.now();
      anchorTRef.current = progressRef.current;
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-term-bg text-foreground">
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          목록
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {recording.title}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {recording.cols}×{recording.rows}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      <div className="flex items-center gap-3 border-t border-border bg-card px-3 py-2">
        <button
          onClick={playing ? pause : play}
          className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
          aria-label={playing ? "일시정지" : "재생"}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <button
          onClick={restart}
          className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="처음부터"
        >
          <RotateCcw className="size-4" />
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {fmtTime(progress)} / {fmtTime(recording.duration)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0.01, recording.duration)}
          step={0.01}
          value={Math.min(progress, recording.duration)}
          onChange={(e) => seek(Number(e.target.value))}
          className={cn("h-1 flex-1 cursor-pointer accent-primary")}
        />
        <Select value={String(speed)} onValueChange={(v) => changeSpeed(Number(v))}>
          <SelectTrigger className="h-7 w-16 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEEDS.map((sp) => (
              <SelectItem key={sp} value={String(sp)}>
                {sp}×
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
