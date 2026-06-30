//! Status detection engine (PLAN §5 — "★ 상태 감지 엔진", the heart of B).
//!
//! Watches each session's PTY output and classifies it into a lifecycle state
//! that drives notification rings, sidebar dots and OS notifications:
//!
//!   running  — output is actively flowing
//!   waiting  — settled on an interactive prompt that needs the user (y/n, …)
//!   idle     — settled back at a normal shell prompt
//!   done     — last command exited 0 (via OSC 133)
//!   error    — last command exited non-zero (via OSC 133)
//!
//! Two signals are combined:
//!   1. OSC 133 shell-integration markers (authoritative, when the shell emits
//!      them): A = prompt, C = command start, D;<code> = command end.
//!   2. An idle/debounce heuristic for shells without integration: once output
//!      stops for `IDLE_DEBOUNCE`, classify the tail buffer as waiting vs idle.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const IDLE_DEBOUNCE: Duration = Duration::from_millis(600);
const MONITOR_INTERVAL: Duration = Duration::from_millis(150);
const TAIL_CAP: usize = 4096;
/// A burst at least this long that then goes quiet reads as "an agent just
/// finished an answer" (claude/codex never emit OSC 133 mid-session — their
/// whole run is ONE shell command, so this is the only completion signal).
const DONE_MIN_BURST: Duration = Duration::from_secs(2);
/// Done needs a longer quiet window than idle/waiting: agent TUIs repaint
/// timers/spinners about once a second during tool runs, and 600ms gaps
/// between repaints must not fire premature "done" notifications.
const DONE_QUIET: Duration = Duration::from_millis(1500);
/// How long a session may sit settled (Idle/Done/Error/Waiting) with no output
/// activity before the periodic settle pass prunes it from the map, bounding
/// `sessions` growth for long-lived apps that churn through many sessions.
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
/// Bytes of the previous chunk retained so an OSC 133 marker split across two
/// `ingest` calls is still detected on the next scan. One whole marker is
/// `\x1b]133;D;<digits>` — 32 bytes comfortably covers the prefix + a code.
const OSC_CARRY: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Running,
    Waiting,
    Done,
    Error,
}

struct SessionState {
    status: Status,
    last_activity: Instant,
    /// When the current uninterrupted output burst began (for done detection).
    burst_start: Instant,
    /// Recent output tail (raw bytes) for heuristic classification.
    tail: Vec<u8>,
    /// Tail of the previous chunk, prepended to the next scan so OSC 133
    /// markers split across `ingest` boundaries are still detected.
    osc_carry: Vec<u8>,
    /// True once an authoritative OSC 133 marker fixed the state; suppresses
    /// the idle heuristic until the next output chunk arrives.
    settled: bool,
    /// True while agent lifecycle hooks (cmux-style, injected at `claude`
    /// launch) own this session's status. Output heuristics are silenced —
    /// TUI repaints must not flip a hook-set Done back to Running — until a
    /// shell-level OSC 133 marker proves the agent handed the shell back.
    hook_driven: bool,
}

impl SessionState {
    fn new() -> Self {
        Self {
            status: Status::Running,
            last_activity: Instant::now(),
            burst_start: Instant::now(),
            tail: Vec::new(),
            osc_carry: Vec::new(),
            settled: false,
            hook_driven: false,
        }
    }
}

#[derive(Default)]
pub struct StatusEngine {
    sessions: Mutex<HashMap<String, SessionState>>,
}

fn status_event(id: &str) -> String {
    format!("pty://status/{id}")
}

impl StatusEngine {
    /// Spawn the background monitor that flushes idle/waiting transitions.
    pub fn start_monitor<R: Runtime>(app: AppHandle<R>) {
        std::thread::spawn(move || loop {
            std::thread::sleep(MONITOR_INTERVAL);
            // The engine state may not be registered yet (early startup) or may
            // have been torn down (shutdown). Skip the tick rather than panic.
            let Some(engine) = app.try_state::<StatusEngine>() else {
                continue;
            };
            engine.tick(&app);
        });
    }

    /// Feed a fresh output chunk for `id`. Called from the PTY reader thread.
    pub fn on_output<R: Runtime>(&self, app: &AppHandle<R>, id: &str, bytes: &[u8]) {
        if let Some(status) = self.ingest(id, bytes) {
            let _ = app.emit(&status_event(id), status);
        }
    }

    /// Authoritative status from an agent lifecycle hook (Claude Code Stop /
    /// Notification / UserPromptSubmit…, posted to the orchestrator). Takes
    /// ownership of the session's status away from the output heuristics;
    /// `release` (SessionEnd) hands it back.
    pub fn on_hook_event<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        id: &str,
        status: Status,
        release: bool,
    ) {
        if let Some(changed) = self.apply_hook(id, status, release) {
            let _ = app.emit(&status_event(id), changed);
        }
    }

    /// Pure hook transition; `Some` = status changed.
    fn apply_hook(&self, id: &str, status: Status, release: bool) -> Option<Status> {
        let mut map = self.sessions.lock();
        let st = map
            .entry(id.to_string())
            .or_insert_with(SessionState::new);
        st.hook_driven = !release;
        st.settled = true;
        let changed = st.status != status;
        st.status = status;
        changed.then_some(status)
    }

    /// Pure state transition for an output chunk; `Some` = status changed.
    fn ingest(&self, id: &str, bytes: &[u8]) -> Option<Status> {
        let mut map = self.sessions.lock();
        let st = map
            .entry(id.to_string())
            .or_insert_with(SessionState::new);

        // Output arriving after a settled/quiet state starts a new burst.
        if st.settled || st.status != Status::Running {
            st.burst_start = Instant::now();
        }

        st.tail.extend_from_slice(bytes);
        if st.tail.len() > TAIL_CAP {
            let cut = st.tail.len() - TAIL_CAP;
            st.tail.drain(0..cut);
        }
        st.last_activity = Instant::now();

        // Scan the previous chunk's tail prepended to this one so an OSC 133
        // marker split across the boundary is still found. The carry holds only
        // the unscanned tail of the prior scan, so markers aren't double-counted
        // (a full marker that already fired lives wholly inside a prior scan and
        // won't recur once it scrolls out of the <OSC_CARRY tail).
        let mut scan_buf = std::mem::take(&mut st.osc_carry);
        let carry_len = scan_buf.len();
        scan_buf.extend_from_slice(bytes);
        let marker = scan_osc133(&scan_buf);
        // Retain the last OSC_CARRY bytes of *new* input for the next scan.
        let keep = scan_buf.len().min(OSC_CARRY);
        // Don't re-carry bytes that were already carried in this scan, or the
        // same boundary region could be rescanned indefinitely.
        let keep = keep.min(scan_buf.len().saturating_sub(carry_len));
        st.osc_carry = scan_buf[scan_buf.len() - keep..].to_vec();
        // While hooks own the status, raw output (TUI repaints, spinners)
        // must not flip it. A shell-level OSC 133 marker means the agent
        // exited back to the prompt — release ownership and process it.
        let mut released = false;
        if st.hook_driven {
            marker.as_ref()?;
            st.hook_driven = false;
            released = true;
        }

        let next = match marker {
            Some(Marker::Done(code)) => {
                st.settled = true;
                if code != 0 {
                    // A failed command is always attention-worthy.
                    Status::Error
                } else if !released
                    && st.last_activity.duration_since(st.burst_start) >= DONE_MIN_BURST
                {
                    // Long-running command finished cleanly — worth telling an
                    // unattended user about. Quick echoes settle straight to
                    // idle so trivial commands don't ring/notify.
                    Status::Done
                } else {
                    // Short command, or the agent the hooks were tracking just
                    // exited back to the shell (the user quit it — its D must
                    // not re-announce "done").
                    Status::Idle
                }
            }
            Some(Marker::Prompt) => {
                st.settled = true;
                if !released && matches!(st.status, Status::Error | Status::Done) {
                    // PSReadLine re-renders the prompt (a bare A, no D — the
                    // history guard suppresses duplicates) right after the
                    // exit marker. That repaint must not wipe the attention
                    // state the D just set; it clears on the next real
                    // command's markers or fresh output.
                    st.status
                } else {
                    Status::Idle
                }
            }
            Some(Marker::Running) | None => {
                st.settled = false;
                Status::Running
            }
        };

        let changed = st.status != next;
        st.status = next;
        changed.then_some(next)
    }

    pub fn remove(&self, id: &str) {
        self.sessions.lock().remove(id);
    }

    fn tick<R: Runtime>(&self, app: &AppHandle<R>) {
        for (id, s) in self.settle_pass() {
            let _ = app.emit(&status_event(&id), s);
        }
    }

    /// Pure settle pass — returns every session whose status changed.
    fn settle_pass(&self) -> Vec<(String, Status)> {
        let mut changes: Vec<(String, Status)> = Vec::new();
        let mut map = self.sessions.lock();
        let now = Instant::now();
        for (id, st) in map.iter_mut() {
            if st.hook_driven {
                continue; // hooks own this session's status
            }
            if st.status == Status::Running && !st.settled {
                let burst = st.last_activity.duration_since(st.burst_start);
                let quiet = now.duration_since(st.last_activity);
                if let Some(next) = decide_settle(&st.tail, burst, quiet) {
                    if st.status != next {
                        st.status = next;
                        changes.push((id.clone(), next));
                    }
                }
            }
        }
        // Prune long-idle sessions so the map can't grow unbounded. Only sessions
        // that are no longer Running (settled to Idle/Done/Error/Waiting) and have
        // had no output activity for SESSION_TTL are dropped; hook-driven and
        // actively-running sessions are always kept. `remove()` still handles the
        // common explicit-close case immediately.
        map.retain(|_, st| {
            if st.hook_driven || st.status == Status::Running {
                return true;
            }
            now.duration_since(st.last_activity) < SESSION_TTL
        });
        changes
    }
}

enum Marker {
    Prompt,
    Running,
    Done(i32),
}

/// Scan a chunk for OSC 133 markers.
///
/// The shell integrations render `D;<code>` + OSC 7 + `A` in ONE prompt
/// write, so a command's exit marker and the next prompt marker almost always
/// land in the same chunk. Taking the literal last marker would let that `A`
/// permanently shadow the `D` — exit codes would never surface. A `D`
/// followed only by prompt markers therefore wins; a `C` AFTER the `D`
/// (a new command already executing) supersedes it.
fn scan_osc133(bytes: &[u8]) -> Option<Marker> {
    const PAT: &[u8] = b"\x1b]133;";
    let mut last = None;
    let mut last_done: Option<i32> = None;
    let mut i = 0;
    while i + PAT.len() < bytes.len() {
        if &bytes[i..i + PAT.len()] == PAT {
            match bytes[i + PAT.len()] {
                b'A' => last = Some(Marker::Prompt),
                b'C' => {
                    last = Some(Marker::Running);
                    last_done = None; // a newer command supersedes the old exit
                }
                b'D' => {
                    let mut j = i + PAT.len() + 1;
                    let mut code = 0i32;
                    if j < bytes.len() && bytes[j] == b';' {
                        j += 1;
                        // Exit codes fit in a byte; cap digits so a malformed or
                        // adversarial sequence can't overflow the i32 accumulator.
                        let mut digits = 0;
                        while j < bytes.len() && bytes[j].is_ascii_digit() && digits < 6 {
                            code = code
                                .saturating_mul(10)
                                .saturating_add((bytes[j] - b'0') as i32);
                            j += 1;
                            digits += 1;
                        }
                    }
                    last = Some(Marker::Done(code));
                    last_done = Some(code);
                }
                _ => {}
            }
            i += PAT.len();
        } else {
            i += 1;
        }
    }
    match (last_done, &last) {
        // D followed by the same render's prompt marker → the D is the signal.
        (Some(code), Some(Marker::Prompt)) => Some(Marker::Done(code)),
        _ => last,
    }
}

/// What a quiet, non-OSC133 session settles into. `None` = keep waiting.
///
///   quiet < 600ms                       → None (still flowing)
///   tail looks like a y/n-style prompt  → Waiting (immediately at 600ms)
///   long burst (agent answer/long job)  → Done, but only after 1.5s quiet
///   short burst (echo, repaint)         → Idle
fn decide_settle(tail: &[u8], burst: Duration, quiet: Duration) -> Option<Status> {
    if quiet <= IDLE_DEBOUNCE {
        return None;
    }
    let c = classify(tail);
    if c == Status::Waiting {
        return Some(Status::Waiting);
    }
    if burst >= DONE_MIN_BURST {
        if quiet >= DONE_QUIET {
            Some(Status::Done)
        } else {
            None // long burst — hold out for the longer done-quiet window
        }
    } else {
        Some(Status::Idle)
    }
}

/// Heuristic: is the settled tail an interactive prompt that needs the user?
fn classify(tail: &[u8]) -> Status {
    // Conservative: only well-known confirmation/question patterns count as
    // "waiting". Everything else is treated as a normal idle shell prompt, to
    // avoid mislabelling fancy prompts (starship, etc.) as needing attention.
    const WAIT: &[&str] = &[
        "(y/n)",
        "[y/n]",
        "y/n)",
        "(yes/no)",
        "press enter",
        "press any key",
        "continue?",
        "overwrite",
        "are you sure",
        "do you want",
        "proceed?",
        "[y/n/a]",
    ];
    let text = strip_ansi(tail).to_lowercase();
    let tail_str = text.trim_end();
    let hay = if tail_str.len() > 300 {
        // Walk back to a char boundary so CJK/emoji output can't panic the
        // slice (byte 300 may land in the middle of a multi-byte codepoint).
        let mut start = tail_str.len() - 300;
        while start < tail_str.len() && !tail_str.is_char_boundary(start) {
            start += 1;
        }
        &tail_str[start..]
    } else {
        tail_str
    };
    if WAIT.iter().any(|p| hay.contains(p)) {
        Status::Waiting
    } else {
        Status::Idle
    }
}

/// Strip ANSI/VT escape sequences so heuristics see plain text.
/// Shared with the trigger engine, which matches user regexes against the
/// stripped output line by line.
pub(crate) fn strip_ansi(bytes: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            i += 1;
            if i >= bytes.len() {
                break;
            }
            match bytes[i] {
                b'[' => {
                    // CSI: params then a final byte in 0x40..=0x7e
                    i += 1;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 1;
                    }
                }
                b']' => {
                    // OSC: until BEL or ST (ESC \)
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => i += 1,
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod settle_tests {
    use super::*;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    #[test]
    fn still_flowing_stays_running() {
        assert!(decide_settle(b"streaming...", MS(5000), MS(100)).is_none());
    }

    #[test]
    fn short_burst_settles_idle() {
        assert!(matches!(
            decide_settle(b"PS E:\\dev> ", MS(50), MS(700)),
            Some(Status::Idle)
        ));
    }

    #[test]
    fn long_burst_waits_for_done_quiet_then_done() {
        // agent answer: long burst, 600ms quiet → not yet (spinner repaint gap)
        assert!(decide_settle(b"...answer text", MS(8000), MS(700)).is_none());
        // 1.5s+ of true silence → done
        assert!(matches!(
            decide_settle(b"...answer text", MS(8000), MS(1600)),
            Some(Status::Done)
        ));
    }

    #[test]
    fn confirmation_prompt_wins_immediately() {
        assert!(matches!(
            decide_settle(b"Do you want to proceed? (y/n)", MS(8000), MS(700)),
            Some(Status::Waiting)
        ));
    }

    #[test]
    fn classify_multibyte_tail_does_not_panic() {
        // 400 bytes of multi-byte CJK so the 300-byte window's start lands mid
        // codepoint; the char-boundary walk must not panic.
        let big = "한".repeat(200); // each char is 3 bytes → 600 bytes
        let tail = format!("{big} continue?");
        assert_eq!(classify(tail.as_bytes()), Status::Waiting);
        let tail2 = format!("{big} done");
        assert_eq!(classify(tail2.as_bytes()), Status::Idle);
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;

    /// End-to-end (real clock, no tauri runtime): an agent-like stream
    /// (continuous chunks > 2s) followed by true silence must settle to
    /// `done` through the real ingest/settle path.
    #[test]
    fn agent_answer_burst_then_quiet_settles_done() {
        let engine = StatusEngine::default();
        // "claude streams an answer": chunks every 100ms for 2.6s
        for _ in 0..26 {
            engine.ingest("s1", b"\x1b[2K\x1b[1Ganswer text chunk");
            std::thread::sleep(Duration::from_millis(100));
        }
        // then silence; the monitor would tick every 150ms
        let mut seen = Vec::new();
        for _ in 0..14 {
            std::thread::sleep(Duration::from_millis(150));
            seen.extend(engine.settle_pass());
        }
        assert!(
            seen.iter().any(|(id, s)| id == "s1" && *s == Status::Done),
            "no done transition; got {} changes",
            seen.len()
        );
    }

    /// A short echo burst (keystroke) must settle to idle, not done.
    #[test]
    fn short_echo_settles_idle_not_done() {
        let engine = StatusEngine::default();
        engine.ingest("s2", b"h");
        engine.ingest("s2", b"i");
        let mut seen = Vec::new();
        for _ in 0..14 {
            std::thread::sleep(Duration::from_millis(150));
            seen.extend(engine.settle_pass());
        }
        assert!(seen.iter().any(|(_, s)| *s == Status::Idle), "expected idle");
        assert!(
            !seen.iter().any(|(_, s)| *s == Status::Done),
            "echo must not be done"
        );
    }

    /// OSC 133 D from the shell still wins immediately (integrated shells),
    /// and `settled` suppresses the heuristic afterwards.
    #[test]
    fn osc133_done_marker_is_authoritative() {
        let engine = StatusEngine::default();
        engine.ingest("s3", b"output...");
        // Model a long-running command: D;0 only reads as "done" when the
        // burst it closes lasted at least DONE_MIN_BURST.
        {
            let mut map = engine.sessions.lock();
            map.get_mut("s3").unwrap().burst_start = Instant::now() - DONE_MIN_BURST;
        }
        let st = engine.ingest("s3", b"\x1b]133;D;0\x07 trailing");
        assert!(matches!(st, Some(Status::Done)));
        std::thread::sleep(Duration::from_millis(800));
        assert!(engine.settle_pass().is_empty());
    }

    /// The shell integrations render `D;<code>` + OSC 7 + `A` in ONE prompt
    /// write — the prompt marker must not shadow a failed exit code.
    #[test]
    fn failed_command_reports_error_despite_same_chunk_prompt() {
        let engine = StatusEngine::default();
        engine.ingest("f", b"build output");
        let st = engine.ingest(
            "f",
            b"\x1b]133;D;1\x1b\\\x1b]7;file://C:/x\x1b\\\x1b]133;A\x1b\\",
        );
        assert!(matches!(st, Some(Status::Error)), "exit 1 must read as error");
    }

    /// Same-chunk D;0 + A from a QUICK command settles to idle (no done spam)…
    #[test]
    fn quick_command_success_settles_idle() {
        let engine = StatusEngine::default();
        engine.ingest("q", b"hi");
        let st = engine.ingest("q", b"\x1b]133;D;0\x1b\\\x1b]133;A\x1b\\");
        assert!(matches!(st, Some(Status::Idle)));
    }

    /// A bare prompt re-render (A without D — PSReadLine repaints after the
    /// exit marker) must not wipe a just-set error/done attention state.
    #[test]
    fn bare_prompt_repaint_keeps_error() {
        let engine = StatusEngine::default();
        engine.ingest("e", b"output");
        let st = engine.ingest("e", b"\x1b]133;D;1\x1b\\\x1b]133;A\x1b\\");
        assert!(matches!(st, Some(Status::Error)));
        let st = engine.ingest("e", b"\x1b]133;A\x1b\\\x1b]133;B\x1b\\");
        assert!(st.is_none(), "bare prompt repaint must not change status");
    }

    /// …while a long command's clean exit reports done (notify-worthy).
    #[test]
    fn long_command_success_reports_done() {
        let engine = StatusEngine::default();
        engine.ingest("l", b"compiling...");
        {
            let mut map = engine.sessions.lock();
            map.get_mut("l").unwrap().burst_start = Instant::now() - DONE_MIN_BURST;
        }
        let st = engine.ingest("l", b"\x1b]133;D;0\x1b\\\x1b]133;A\x1b\\");
        assert!(matches!(st, Some(Status::Done)));
    }

    /// An OSC 133 D marker split across two ingest chunks must still be detected
    /// via the per-session carry buffer.
    #[test]
    fn osc133_marker_split_across_chunks() {
        let engine = StatusEngine::default();
        engine.ingest("split", b"output \x1b]133;");
        // long-burst so the split D;0 reads as done (vs idle for quick cmds)
        {
            let mut map = engine.sessions.lock();
            map.get_mut("split").unwrap().burst_start = Instant::now() - DONE_MIN_BURST;
        }
        let st = engine.ingest("split", b"D;0\x07 done");
        assert!(matches!(st, Some(Status::Done)), "split marker missed");
    }

    /// A malformed/adversarial D marker with a huge digit run must not overflow;
    /// the code saturates and is treated as non-zero (Error).
    #[test]
    fn osc133_exit_code_overflow_saturates() {
        let mut huge = b"\x1b]133;D;".to_vec();
        huge.extend(std::iter::repeat_n(b'9', 40));
        huge.push(0x07);
        let m = scan_osc133(&huge);
        assert!(matches!(m, Some(Marker::Done(c)) if c != 0));
    }

    /// Settled sessions with no recent activity are pruned by the settle pass.
    #[test]
    fn idle_sessions_are_pruned_after_ttl() {
        let engine = StatusEngine::default();
        // Settle a session to Done via an authoritative marker.
        engine.ingest("ttl", b"\x1b]133;D;0\x07");
        // Force its last_activity far into the past so it exceeds SESSION_TTL.
        {
            let mut map = engine.sessions.lock();
            let st = map.get_mut("ttl").unwrap();
            st.last_activity = Instant::now() - (SESSION_TTL + Duration::from_secs(1));
        }
        engine.settle_pass();
        assert!(
            !engine.sessions.lock().contains_key("ttl"),
            "stale session should be pruned"
        );
    }
}

#[cfg(test)]
mod hook_tests {
    use super::*;

    #[test]
    fn hook_events_own_status_until_shell_marker() {
        let e = StatusEngine::default();
        // session-start → running (initial state is already running: no change)
        assert_eq!(e.apply_hook("s", Status::Running, false), None);
        // Stop hook → done, authoritative
        assert_eq!(e.apply_hook("s", Status::Done, false), Some(Status::Done));
        // TUI repaints must NOT flip the hook-set done back to running
        assert_eq!(e.ingest("s", b"spinner repaint tokens 1.2k"), None);
        assert!(e.settle_pass().is_empty());
        // shell-level OSC 133 prompt mark (claude exited) releases ownership
        assert_eq!(e.ingest("s", b"\x1b]133;A\x1b\\"), Some(Status::Idle));
    }
}
