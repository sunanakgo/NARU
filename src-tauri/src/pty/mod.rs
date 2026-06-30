//! PTY layer (PLAN §5/§6 — `src-tauri/src/pty`).
//!
//! Phase 0: spawn a shell on a PTY, stream its output to the frontend, and
//! accept input / resize. Sessions are keyed by an id so the same code scales
//! to the multi-pane multiplexer in Phase 1 without changes.

use std::collections::HashMap;
use std::io::{Read, Write};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

use crate::status::StatusEngine;


/// PowerShell shell-integration: wraps the prompt to emit OSC 133 (D=prev exit,
/// A=prompt start, B=command input) and OSC 7 (cwd), preserving the user's
/// existing prompt. Runs after the profile via `-NoExit -Command`.
// Emits BOTH OSC 7 (xterm convention) and OSC 9;9 (Windows Terminal/ConEmu
// convention) for the cwd — ConPTY builds differ in which OSC they pass
// through unmodified, so sending both maximizes survival.
//
// Dual-mode visible prompt, switched LIVE via a mode file the app writes
// (no command injection into the shell — toggling leaves no echo):
//   file contains '1' → a single space (the input bar replaces the prompt
//          UI, Warp-style; PowerShell substitutes "PS>" for null/empty,
//          so a space is the minimum)
//   else → the user's own prompt (or the default "PS <dir>> ").
// The D (command finished) mark is gated on the history id actually
// advancing: PowerShell re-runs `prompt` on every redraw (resize, Ctrl+C at
// an empty line, sidebar animations…) and an unguarded D would re-report the
// LAST command's exit code as a fresh failure each time.
const POWERSHELL_INTEGRATION: &str = r#"$e=[char]27; $nf=Join-Path $env:TEMP 'naru-prompt-mode'; $o=(Get-Command prompt -ErrorAction SilentlyContinue).ScriptBlock; function global:prompt { $c=$LASTEXITCODE; if($null -eq $c){$c=0}; $p=$PWD.ProviderPath; $h=(Get-History -Count 1).Id; $d= if($null -ne $h -and $global:__naruHid -ne $h){ $global:__naruHid=$h; "$e]133;D;$c$e\" } else { "" }; [Console]::Write("$d$e]7;file://$p$e\$e]9;9;$p$e\$e]133;A$e\"); $m= try { [IO.File]::ReadAllText($nf).Trim() } catch { '0' }; $r= if($m -eq '1'){ " " } elseif($o){ & $o } else { "PS $p> " }; [Console]::Write("$e]133;B$e\"); $r }; function global:claude { $ns=$env:NARU_CLAUDE_SETTINGS; $skip=$false; foreach($a in $args){ if($a -in 'config','mcp','update','doctor','install','--help','-h','--version','-v','--settings'){ $skip=$true } }; $c=Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if(-not $c){ Write-Error 'claude CLI not found'; return }; if($ns -and (Test-Path $ns) -and -not $skip -and $env:NARU_CLAUDE_HOOKS_DISABLED -ne '1'){ & $c.Source --settings $ns @args } else { & $c.Source @args } }"#;

/// Persist the prompt mode where every shell's prompt function reads it.
pub fn write_prompt_mode(minimal: bool) {
    let path = std::env::temp_dir().join("naru-prompt-mode");
    let _ = std::fs::write(path, if minimal { "1" } else { "0" });
}

/// Write a file readable only by the current user — the hook settings carry
/// the orchestrator token, and on Unix `/tmp` is world-readable, so default
/// permissions would let any local user lift the token and drive sessions.
/// (Windows %TEMP% is per-user ACL'd already.)
fn write_private(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(contents)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
    }
}

/// Where a session's injected Claude hook settings live.
fn claude_settings_path(id: &str) -> std::path::PathBuf {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    std::env::temp_dir().join(format!("naru-claude-{safe}.json"))
}

/// Inline-settings JSON injected when `claude` launches inside NARU
/// (cmux-style — see Resources/bin/claude in manaflow-ai/cmux). Lifecycle
/// hooks POST authoritative status to the orchestrator:
///   UserPromptSubmit → running,  Stop → done,  Notification → waiting,
///   SessionStart → running,     SessionEnd → idle (releases ownership).
/// `--settings` merges additively per-invocation — the user's own
/// ~/.claude/settings.json is never touched.
///
/// The hook runs NARU's own binary (`exe`) in exec form (`args` array → no
/// shell). It POSTs the event to the orchestrator (see lib::run_hook). This
/// replaced a `curl.exe` command hook: Claude Code on Windows spawns hooks
/// without CREATE_NO_WINDOW (#61051), so a console program flashed a window on
/// every event — naru.exe is GUI-subsystem, so no window appears.
fn claude_hook_settings(exe: &str, port: u16, token: &str, session: &str) -> String {
    let hook = |event: &str, timeout: u32| {
        // Claude pipes the event JSON (incl. session_id, which powers resume)
        // to the hook's stdin; run_hook forwards it as the POST body.
        let path = format!("/hooks/claude/{event}?session={session}");
        serde_json::json!([{ "matcher": "", "hooks": [{
            "type": "command",
            "command": exe,
            "args": ["__naru-hook", port.to_string(), path, token],
            "timeout": timeout
        }]}])
    };
    serde_json::json!({
        "hooks": {
            "SessionStart": hook("session-start", 10),
            "UserPromptSubmit": hook("prompt-submit", 10),
            "Stop": hook("stop", 10),
            "Notification": hook("notification", 10),
            "SessionEnd": hook("session-end", 1),
        }
    })
    .to_string()
}

/// zsh integration (macOS default shell): sources the user's zshrc, then
/// adds a precmd emitting the same OSC marks as the PowerShell integration
/// (D gated on history advancing, cwd via OSC 7 + 9;9, minimal-prompt mode
/// from the shared mode file).
#[cfg(not(windows))]
const ZSH_INTEGRATION: &str = r#"
[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
__naru_precmd() {
  local c=$?
  local h=$HISTCMD
  if [[ -n "$__naru_hid" && "$__naru_hid" != "$h" ]]; then
    printf '\e]133;D;%s\e\\' "$c"
  fi
  __naru_hid=$h
  printf '\e]7;file://%s\e\\' "$PWD"
  printf '\e]9;9;%s\e\\' "$PWD"
  printf '\e]133;A\e\\'
  local nf="${TMPDIR:-/tmp}/naru-prompt-mode"
  if [[ -f "$nf" && "$(<"$nf")" == "1" ]]; then PROMPT=" "; fi
}
typeset -ag precmd_functions
precmd_functions+=(__naru_precmd)
claude() {
  case "$1" in
    config|mcp|update|doctor|install|--help|-h|--version|-v|--settings) command claude "$@"; return;;
  esac
  if [[ -n "$NARU_CLAUDE_SETTINGS" && -f "$NARU_CLAUDE_SETTINGS" && "$NARU_CLAUDE_HOOKS_DISABLED" != "1" ]]; then
    command claude --settings "$NARU_CLAUDE_SETTINGS" "$@"
  else
    command claude "$@"
  fi
}
"#;

/// bash fallback: same marks via PROMPT_COMMAND.
#[cfg(not(windows))]
const BASH_INTEGRATION: &str = r#"
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
__naru_prompt() {
  local c=$?
  local h=$(history 1 | awk '{print $1}')
  if [[ -n "$__naru_hid" && "$__naru_hid" != "$h" ]]; then
    printf '\e]133;D;%s\e\\' "$c"
  fi
  __naru_hid=$h
  printf '\e]7;file://%s\e\\' "$PWD"
  printf '\e]9;9;%s\e\\' "$PWD"
  printf '\e]133;A\e\\'
  local nf="${TMPDIR:-/tmp}/naru-prompt-mode"
  if [[ -f "$nf" && "$(<"$nf")" == "1" ]]; then PS1=" "; fi
}
PROMPT_COMMAND="__naru_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
claude() {
  case "$1" in
    config|mcp|update|doctor|install|--help|-h|--version|-v|--settings) command claude "$@"; return;;
  esac
  if [[ -n "$NARU_CLAUDE_SETTINGS" && -f "$NARU_CLAUDE_SETTINGS" && "$NARU_CLAUDE_HOOKS_DISABLED" != "1" ]]; then
    command claude --settings "$NARU_CLAUDE_SETTINGS" "$@"
  else
    command claude "$@"
  fi
}
"#;

/// A writer behind its own lock so `write()` never holds the sessions map
/// lock across a blocking `write_all`/`flush`.
type SharedWriter = std::sync::Arc<Mutex<Box<dyn Write + Send>>>;

/// The frontend's output sink. Raw bytes over a Tauri IPC channel — an
/// `app.emit(Vec<u8>)` serializes every byte as JSON decimal (3-5 chars/byte)
/// that the webview then parses back; at agent-streaming throughput that JSON
/// round-trip was the dominant CPU cost on both sides. Behind an Arc<Mutex<>>
/// so a window reload can swap in its new channel (reattach) and the running
/// reader thread picks it up on the next chunk.
type OutputTx = std::sync::Arc<Mutex<tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>>>;

/// One live PTY-backed shell session.
///
/// `master` is `Option`-wrapped and `writer` lives behind an `Arc` so
/// `close()`/`shutdown_all()` can drop both (closing the underlying handles →
/// the cloned reader sees EOF) *before* joining the reader thread, without
/// fighting struct field-drop order.
struct PtySession {
    master: Option<Box<dyn MasterPty + Send>>,
    /// The writer half of the PTY, shared so callers can clone it out and
    /// release the sessions lock before doing blocking I/O.
    writer: SharedWriter,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Join handle for the reader pump — joined on close so the thread (and
    /// its cloned PTY handle) is fully torn down, not leaked/detached.
    reader: Option<std::thread::JoinHandle<()>>,
    /// OS process id of the shell — used to inspect cwd / child agents.
    pid: Option<u32>,
    /// Output channel to the frontend — swapped on reattach (window reload).
    output_tx: OutputTx,
}

impl PtySession {
    /// Kill + reap the child, close the PTY handles, and join the reader.
    /// Used by both `close()` (single session) and `shutdown_all()`.
    fn teardown(&mut self) {
        let _ = self.child.kill();
        // Reap the child so it doesn't linger as a zombie.
        let _ = self.child.wait();
        // Drop the master (and the writer, if no other Arc clone is mid-write)
        // so the cloned reader handle sees EOF and its loop exits.
        self.master.take();
        // Replace the shared writer with a throwaway empty one; dropping our
        // reference here releases the underlying writer handle once any
        // in-flight `write()` clone is done with it.
        let _ = std::mem::replace(
            &mut self.writer,
            std::sync::Arc::new(Mutex::new(Box::new(std::io::sink()) as Box<dyn Write + Send>)),
        );
        // Join the reader — it should exit promptly now the handles are closed.
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

/// Recent-output ring buffer cap per session (bytes), for the orchestrator API.
const OUTPUT_CAP: usize = 64 * 1024;


/// Registry of all live sessions. Stored as Tauri managed state.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    outputs: Mutex<HashMap<String, Vec<u8>>>,
    /// Last OSC 7 cwd per session. The Win32 process cwd does NOT follow
    /// PowerShell's `cd` (it only moves its internal location), so the shell
    /// integration's OSC 7 is the source of truth for "where the shell is".
    cwds: Mutex<HashMap<String, String>>,
    /// The most recently reported cwd across ALL sessions — new sessions
    /// open here instead of the home directory.
    last_cwd: Mutex<Option<String>>,
    /// Carry buffer so OSC 7 sequences split across reads still parse.
    cwd_carry: Mutex<HashMap<String, Vec<u8>>>,
    /// One-shot guard for loading the persisted cwd map at first create.
    cwds_loaded: Mutex<bool>,
}

/// Where the per-session cwd map survives restarts (PLAN: a restored session
/// reopens in the directory the user last `cd`'d to, not the home dir).
fn cwd_store_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("session-cwds.json"))
}

impl PtyManager {
    /// Load the persisted per-session cwd map once (before the first spawn).
    /// Entries only fill gaps — live sessions' reported cwds always win.
    fn ensure_cwds_loaded(&self, app: &AppHandle) {
        let mut loaded = self.cwds_loaded.lock();
        if *loaded {
            return;
        }
        *loaded = true;
        let Some(path) = cwd_store_path(app) else { return };
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            return;
        };
        if self.last_cwd.lock().is_none() {
            if let Some(last) = v.get("last").and_then(|x| x.as_str()) {
                *self.last_cwd.lock() = Some(last.to_string());
            }
        }
        if let Some(map) = v.get("sessions").and_then(|x| x.as_object()) {
            let mut cwds = self.cwds.lock();
            for (key, val) in map {
                if let Some(s) = val.as_str() {
                    cwds.entry(key.clone()).or_insert_with(|| s.to_string());
                }
            }
        }
    }

    /// Snapshot the cwd map to disk — called on every cd and on pane close.
    pub fn persist_cwds(&self, app: &AppHandle) {
        let Some(path) = cwd_store_path(app) else { return };
        let data = serde_json::json!({
            "last": self.last_cwd.lock().clone(),
            "sessions": &*self.cwds.lock(),
        });
        let _ = std::fs::write(path, data.to_string());
    }

    /// Spawn a new shell on a fresh PTY and start streaming its output.
    /// `inherit_from`: an existing session id whose current (OSC 7) cwd the
    /// new shell should start in — new panes open where their sibling is.
    #[allow(clippy::too_many_arguments)] // 1:1 with the pty_create command
    pub fn create(
        &self,
        app: AppHandle,
        id: String,
        cols: u16,
        rows: u16,
        inherit_from: Option<String>,
        minimal_prompt: bool,
        on_output: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    ) -> Result<(), String> {
        // Reattach: if the session is already live (e.g. a window reload, or a
        // tab that stayed mounted), keep the existing shell and its reader
        // thread. Swap in the new frontend's output channel and replay the
        // recent-output ring so the fresh (empty) grid isn't blank.
        {
            let sessions = self.sessions.lock();
            if let Some(session) = sessions.get(&id) {
                let recent = self.recent_output(&id, OUTPUT_CAP);
                if !recent.is_empty() {
                    let _ = on_output
                        .send(tauri::ipc::InvokeResponseBody::Raw(recent.into_bytes()));
                }
                *session.output_tx.lock() = on_output;
                return Ok(());
            }
        }
        self.ensure_cwds_loaded(&app);
        // Best-effort: prune stale per-session Claude settings files left by
        // sessions that didn't get a clean close() (crash, kill -9, …).
        prune_stale_claude_settings();

        // Defensive: serialize PTY+spawn setup. Concurrent CreateProcess calls
        // in one process can leak each other's inheritable pipe handles into
        // the wrong child (classic Windows race) — spawns are rare (session
        // restore), so the lock costs nothing. NOTE: the hidden-pane freeze
        // this was first suspected for turned out to be the frontend dropping
        // ConPTY's startup cursor-position query reply (see terminal-pane's
        // onData ordering comment); the lock stays as cheap insurance.
        static SPAWN_LOCK: Mutex<()> = Mutex::new(());
        let spawn_guard = SPAWN_LOCK.lock();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = default_shell();
        let mut cmd = CommandBuilder::new(&shell);
        // Inject shell integration so the shell emits OSC 133 (command marks +
        // exit codes) and OSC 7 (cwd) — powering block decoration and status.
        if shell.contains("powershell") {
            // Node's npm/npx shims are PowerShell scripts. A default Restricted
            // execution policy makes `npm` fail inside NARU even when Node is
            // installed, so relax it for this shell process only.
            cmd.arg("-ExecutionPolicy");
            cmd.arg("Bypass");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(POWERSHELL_INTEGRATION);
        }
        #[cfg(not(windows))]
        {
            // macOS/Linux: inject the integration via ZDOTDIR (zsh) or
            // --rcfile (bash) so OSC 133/7/9;9 flow without user setup.
            if shell.ends_with("zsh") {
                let dir = std::env::temp_dir().join("naru-zsh");
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(dir.join(".zshrc"), ZSH_INTEGRATION);
                cmd.env("ZDOTDIR", dir.to_string_lossy().to_string());
            } else if shell.ends_with("bash") {
                let rc = std::env::temp_dir().join("naru-bashrc");
                let _ = std::fs::write(&rc, BASH_INTEGRATION);
                cmd.arg("--rcfile");
                cmd.arg(rc.to_string_lossy().to_string());
            }
        }
        write_prompt_mode(minimal_prompt);
        // Expose the orchestrator API to agents running in this shell.
        cmd.env("NARU_SESSION_ID", &id);
        if let Some(info) = app.try_state::<crate::orchestrator::OrchestratorInfo>() {
            cmd.env("NARU_ORCH_PORT", info.port.to_string());
            cmd.env("NARU_ORCH_TOKEN", &info.token);
            // Claude lifecycle hooks (cmux-style): per-session settings JSON
            // on disk; the shell integration's `claude` wrapper injects it
            // via `--settings <file>` so hooks POST status back to us.
            // Hooks launch THIS exe (GUI-subsystem → no console flash) in
            // Claude's exec form; fall back to the literal "naru" only if the
            // path is somehow unavailable.
            let exe = std::env::current_exe()
                .ok()
                .and_then(|p| p.to_str().map(str::to_string))
                .unwrap_or_else(|| "naru".to_string());
            let settings = claude_hook_settings(&exe, info.port, &info.token, &id);
            let path = claude_settings_path(&id);
            if write_private(&path, settings.as_bytes()).is_ok() {
                cmd.env("NARU_CLAUDE_SETTINGS", path.to_string_lossy().to_string());
            }
        }
        // Start dir: THIS session's last known cwd (restored across app
        // restarts) → sibling pane's cwd → last cd'd dir anywhere → home.
        let start_dir = self
            .cwd(&id)
            .or_else(|| inherit_from.and_then(|src| self.cwd(&src)))
            .or_else(|| self.last_cwd.lock().clone())
            .filter(|p| std::path::Path::new(p).is_dir())
            .or_else(home_dir);
        if let Some(dir) = start_dir {
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;

        // Dropping the slave lets reads see EOF once the child exits.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // PTY + child fully set up — later spawns may proceed.
        drop(spawn_guard);

        // Register the session BEFORE spawning the reader so an instantly
        // exiting shell's EOF cleanup always finds the entry (no dead-session
        // residue lingering in the map until pane close).
        let pid = child.process_id();
        let output_tx: OutputTx = std::sync::Arc::new(Mutex::new(on_output));
        self.sessions.lock().insert(
            id.clone(),
            PtySession {
                master: Some(pair.master),
                writer: std::sync::Arc::new(Mutex::new(writer)),
                child,
                reader: None,
                pid,
                output_tx: output_tx.clone(),
            },
        );

        // Reader pump — owns its handle, so it needs no lock on the registry.
        let status_id = id.clone();
        let reader_handle = std::thread::spawn(move || {
            // 64KB reads: at full agent-streaming throughput ConPTY fills the
            // buffer, so larger reads naturally coalesce output into fewer
            // (bigger) IPC events — ~8x fewer events than an 8KB buffer.
            let mut buf = [0u8; 65536];
            // Resolve managed-state handles ONCE — `app.state::<T>()` is a
            // lock + TypeId map lookup, needless per-chunk work in a loop that
            // runs at streaming frequency.
            let engine = app.state::<StatusEngine>();
            let triggers = app.state::<crate::triggers::TriggerEngine>();
            let mgr = app.state::<PtyManager>();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        // Ring buffer FIRST, channel second: create()'s
                        // reattach path replays the ring into the fresh
                        // channel before swapping it in — a chunk recorded
                        // before it is sent can be replayed OR delivered, but
                        // never silently dropped between the two.
                        mgr.append_output(&status_id, &buf[..n]);
                        // Raw bytes over the channel (no JSON number-array
                        // encoding); multibyte sequences split across reads
                        // survive intact — the frontend decodes.
                        let _ = output_tx
                            .lock()
                            .send(tauri::ipc::InvokeResponseBody::Raw(buf[..n].to_vec()));
                        // Feed the status engine off the same stream.
                        engine.on_output(&app, &status_id, &buf[..n]);
                        // …and the user-defined trigger rules (same choke point
                        // so background panes match too).
                        triggers.on_output(&app, &status_id, &buf[..n]);
                        // Track the shell's location via OSC 7 — push changes
                        // immediately so the UI follows `cd` without waiting
                        // for the next info poll.
                        if let Some(cwd) = mgr.scan_cwd(&status_id, &buf[..n]) {
                            let _ = app.emit(&format!("pty://cwd/{status_id}"), cwd);
                            // survive app restarts (sessions reopen here)
                            mgr.persist_cwds(&app);
                        }
                    }
                    Err(_) => break,
                }
            }
            // EOF / read error: the shell exited (or its handle was closed).
            // Proactively prune this session's state and tell the frontend.
            // NOTE: a deliberate close()/shutdown_all() removes the session
            // entry first, so the removals below become no-ops in that path —
            // only an organic shell exit reaches here with state present. The
            // exit event still fires either way; on deliberate close the
            // frontend has already unlistened (and guards on `disposed`).
            let mgr = app.state::<PtyManager>();
            mgr.outputs.lock().remove(&status_id);
            mgr.cwds.lock().remove(&status_id);
            mgr.cwd_carry.lock().remove(&status_id);
            mgr.sessions.lock().remove(&status_id);
            let _ = std::fs::remove_file(claude_settings_path(&status_id));
            let _ = app.emit(&format!("pty://exit/{status_id}"), ());
        });

        // Attach the reader's JoinHandle; if the entry is already gone the
        // shell exited instantly and cleaned up — just detach the handle.
        if let Some(s) = self.sessions.lock().get_mut(&id) {
            s.reader = Some(reader_handle);
        }
        Ok(())
    }

    /// OS pid of a session's shell process.
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.sessions.lock().get(id).and_then(|s| s.pid)
    }

    /// Last OSC 7 cwd reported by the session's shell integration.
    pub fn cwd(&self, id: &str) -> Option<String> {
        self.cwds.lock().get(id).cloned()
    }

    /// Scan an output chunk for cwd reports — OSC 7 (`ESC ]7;file://<path>`)
    /// and OSC 9;9 (`ESC ]9;9;<path>`, the Windows Terminal convention) —
    /// and remember the latest path. A small carry survives chunk splits.
    /// Returns `Some(path)` when the cwd CHANGED (so callers can push an
    /// event instead of waiting for the next poll).
    fn scan_cwd(&self, id: &str, bytes: &[u8]) -> Option<String> {
        const PATS: [&[u8]; 2] = [b"\x1b]7;file://", b"\x1b]9;9;"];
        let mut carry = self.cwd_carry.lock();
        let buf = carry.entry(id.to_string()).or_default();
        buf.extend_from_slice(bytes);

        let mut latest: Option<(usize, String)> = None;
        for pat in PATS {
            let mut search_from = 0;
            while let Some(rel) = find(&buf[search_from..], pat) {
                let start = search_from + rel + pat.len();
                // terminator: BEL or ESC \
                let mut end = None;
                for i in start..buf.len() {
                    if buf[i] == 0x07 || (buf[i] == 0x1b && buf.get(i + 1) == Some(&b'\\')) {
                        end = Some(i);
                        break;
                    }
                }
                let Some(end) = end else { break }; // incomplete — wait for more
                let raw = String::from_utf8_lossy(&buf[start..end]).to_string();
                let path = normalize_osc7_path(raw.trim_matches('"'));
                // prefer whichever report appeared LAST in the stream
                if latest.as_ref().map(|(pos, _)| end > *pos).unwrap_or(true) {
                    latest = Some((end, path));
                }
                search_from = end;
            }
        }
        // keep only a small tail so a split sequence can complete next chunk
        if buf.len() > 1024 {
            let cut = buf.len() - 1024;
            buf.drain(0..cut);
        }
        drop(carry);
        if let Some((_, p)) = latest {
            if !p.is_empty() {
                *self.last_cwd.lock() = Some(p.clone());
                let prev = self.cwds.lock().insert(id.to_string(), p.clone());
                if prev.as_deref() != Some(p.as_str()) {
                    return Some(p);
                }
            }
        }
        None
    }

    /// Append output to a session's ring buffer (orchestrator API).
    pub fn append_output(&self, id: &str, bytes: &[u8]) {
        let mut map = self.outputs.lock();
        let buf = map.entry(id.to_string()).or_default();
        buf.extend_from_slice(bytes);
        if buf.len() > OUTPUT_CAP {
            let cut = buf.len() - OUTPUT_CAP;
            buf.drain(0..cut);
        }
    }

    /// Live session ids.
    pub fn list(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }

    /// (session id, shell pid) for every live session — process monitor input.
    pub fn session_pids(&self) -> Vec<(String, u32)> {
        self.sessions
            .lock()
            .iter()
            .filter_map(|(id, s)| s.pid.map(|p| (id.clone(), p)))
            .collect()
    }

    /// Recent output (UTF-8 lossy) for a session, last `max` bytes.
    pub fn recent_output(&self, id: &str, max: usize) -> String {
        let map = self.outputs.lock();
        match map.get(id) {
            Some(buf) => {
                let start = buf.len().saturating_sub(max);
                String::from_utf8_lossy(&buf[start..]).into_owned()
            }
            None => String::new(),
        }
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        // Clone the per-session writer Arc out, then release the sessions
        // lock so a blocking write/flush never stalls every other session.
        let writer = {
            let sessions = self.sessions.lock();
            let session = sessions
                .get(id)
                .ok_or_else(|| format!("no session '{id}'"))?;
            session.writer.clone()
        };
        let mut w = writer.lock();
        w.write_all(data).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock();
        let session = sessions
            .get(id)
            .ok_or_else(|| format!("no session '{id}'"))?;
        let Some(master) = session.master.as_ref() else {
            return Err(format!("session '{id}' has no master"));
        };
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        // Remove the entry FIRST and release the sessions lock, then tear the
        // session down. teardown() joins the reader thread, which itself takes
        // `sessions.lock()` on EOF — holding the lock across the join would
        // deadlock.
        let session = self.sessions.lock().remove(id);
        if let Some(mut session) = session {
            session.teardown();
        }
        self.outputs.lock().remove(id);
        self.cwds.lock().remove(id);
        self.cwd_carry.lock().remove(id);
        let _ = std::fs::remove_file(claude_settings_path(id));
        Ok(())
    }

    /// Kill, reap and join EVERY live session — called on app exit so no
    /// orphaned shells / detached reader threads survive the process.
    pub fn shutdown_all(&self) {
        // Drain the map under the lock, then release it before tearing each
        // session down: teardown() joins the reader thread, which locks
        // `sessions` on EOF — joining while holding the lock would deadlock.
        let drained: Vec<(String, PtySession)> = {
            let mut sessions = self.sessions.lock();
            sessions.drain().collect()
        };
        for (id, mut session) in drained {
            session.teardown();
            let _ = std::fs::remove_file(claude_settings_path(&id));
        }
        self.outputs.lock().clear();
        self.cwds.lock().clear();
        self.cwd_carry.lock().clear();
    }
}

/// Best-effort cleanup of `naru-claude-*.json` temp files older than ~1 day,
/// left behind by sessions that crashed before close() could remove them.
fn prune_stale_claude_settings() {
    let dir = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let cutoff = std::time::Duration::from_secs(24 * 60 * 60);
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("naru-claude-") && name.ends_with(".json")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        if let Ok(age) = now.duration_since(modified) {
            if age > cutoff {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Naive subsequence search (no memmem dependency).
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// Our PowerShell integration writes `file://C:\dir` (raw provider path);
/// standard emitters write `file://host/C:/dir` (URL-encoded). Handle both.
fn normalize_osc7_path(raw: &str) -> String {
    // Operate on bytes end-to-end: `raw` derives from String::from_utf8_lossy
    // of arbitrary PTY bytes, so it can contain multi-byte chars (e.g. Korean
    // path segments, U+FFFD). Any byte-index slice on the &str would split a
    // codepoint and panic — work on the byte slice instead.
    let mut bytes: Vec<u8> = raw.as_bytes().to_vec();

    // strip a possible hostname segment before an absolute path:
    //   "hostname/C:/dir" -> "/C:/dir"
    // (skip when already rooted at '/' or when the path is a bare drive path
    //  like "C:\dir" / "C:/dir").
    let starts_with_drive_sep = bytes.len() >= 3
        && (bytes[1..].starts_with(b":\\") || bytes[1..].starts_with(b":/"));
    if bytes.first() != Some(&b'/') && !starts_with_drive_sep {
        if let Some(idx) = bytes.iter().position(|&b| b == b'/') {
            bytes.drain(0..idx);
        }
    }

    // percent-decode (best effort) — produces raw bytes, decoded to a String
    // lossily at the end so invalid sequences can't panic.
    if bytes.contains(&b'%') {
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        bytes = out;
    }

    // "/C:/dir" -> "C:/dir"
    if bytes.len() > 2 && bytes[0] == b'/' && bytes[2] == b':' {
        bytes.remove(0);
    }

    String::from_utf8_lossy(&bytes).into_owned()
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn home_dir() -> Option<String> {
    if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_cwd_parses_osc7_and_osc99() {
        let mgr = PtyManager::default();
        mgr.scan_cwd("a", b"junk\x1b]7;file://C:\\Users\\nanakgo\x1b\\more");
        assert_eq!(mgr.cwd("a").as_deref(), Some("C:\\Users\\nanakgo"));
        mgr.scan_cwd("a", b"\x1b]9;9;E:\\dev\\naru\x07tail");
        assert_eq!(mgr.cwd("a").as_deref(), Some("E:\\dev\\naru"));
        // the global "last cd'd dir" follows every change (new-session spawn dir)
        assert_eq!(mgr.last_cwd.lock().as_deref(), Some("E:\\dev\\naru"));
        // split across chunks
        mgr.scan_cwd("b", b"\x1b]9;9;E:\\de");
        mgr.scan_cwd("b", b"v\\naru\x07");
        assert_eq!(mgr.cwd("b").as_deref(), Some("E:\\dev\\naru"));
    }

    #[test]
    fn normalize_handles_url_and_raw_paths() {
        assert_eq!(normalize_osc7_path("C:\\dev\\naru"), "C:\\dev\\naru");
        assert_eq!(normalize_osc7_path("/C:/dev/naru"), "C:/dev/naru");
        assert_eq!(normalize_osc7_path("host/C:/dev/naru"), "C:/dev/naru");
        assert_eq!(normalize_osc7_path("/home/user%20x"), "/home/user x");
    }

    /// The decisive question: does THIS machine's ConPTY pass our cwd OSC
    /// sequences through? Spawns a real PowerShell with the integration and
    /// watches the PTY output for either marker.
    #[cfg(windows)]
    /// DIAGNOSTIC (run manually): spawn the real `claude` CLI on a ConPTY,
    /// send a trivial prompt, and log output-chunk timing — answers whether
    /// an idle claude TUI ever goes quiet long enough for the burst-done
    /// heuristic, and whether it emits BEL / OSC 9 we could key off instead.
    ///   cargo test --lib diag_claude_cadence -- --ignored --nocapture
    #[test]
    #[ignore]
    fn diag_claude_cadence() {
        use std::sync::{Arc, Mutex as StdMutex};
        use std::time::{Duration, Instant};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.arg("/c");
        cmd.arg("claude");
        cmd.cwd("E:\\dev\\naru");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn claude");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer: Arc<StdMutex<Box<dyn Write + Send>>> =
            Arc::new(StdMutex::new(pair.master.take_writer().expect("writer")));
        let t0 = Instant::now();
        let chunks: Arc<StdMutex<Vec<(u128, usize)>>> = Arc::default();
        let collected: Arc<StdMutex<Vec<u8>>> = Arc::default();
        {
            let chunks = chunks.clone();
            let collected = collected.clone();
            let writer = writer.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    if find(&buf[..n], b"\x1b[6n").is_some() {
                        let mut w = writer.lock().unwrap();
                        let _ = w.write_all(b"\x1b[1;1R");
                        let _ = w.flush();
                    }
                    chunks.lock().unwrap().push((t0.elapsed().as_millis(), n));
                    collected.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            });
        }

        // boot → idle window → send "hi" → response → idle window
        std::thread::sleep(Duration::from_secs(10));
        {
            let mut w = writer.lock().unwrap();
            let _ = w.write_all(b"hi");
            let _ = w.flush();
        }
        std::thread::sleep(Duration::from_millis(300));
        {
            let mut w = writer.lock().unwrap();
            let _ = w.write_all(b"\r");
            let _ = w.flush();
        }
        std::thread::sleep(Duration::from_secs(30));
        let _ = child.kill();

        let chunks = chunks.lock().unwrap().clone();
        let data = collected.lock().unwrap().clone();
        println!("=== {} chunks, {} bytes total ===", chunks.len(), data.len());
        // gap timeline: only print gaps > 400ms (candidate quiet windows)
        let mut prev = 0u128;
        for (at, n) in &chunks {
            let gap = at - prev;
            if gap > 400 {
                println!("t={at:>6}ms  gap={gap:>6}ms  (next chunk {n} bytes)");
            }
            prev = *at;
        }
        println!("last chunk at t={}ms (test end ~40300ms)", prev);
        // BEL / OSC9 / OSC777 occurrences with context
        for (i, b) in data.iter().enumerate() {
            if *b == 0x07 {
                let s = i.saturating_sub(30);
                println!("BEL@{}: {:?}", i, String::from_utf8_lossy(&data[s..i]));
            }
        }
        if let Some(p) = find(&data, b"\x1b]9;") {
            let e = (p + 120).min(data.len());
            println!("OSC9@{}: {:?}", p, String::from_utf8_lossy(&data[p..e]));
        }
        if let Some(p) = find(&data, b"\x1b]777;") {
            let e = (p + 120).min(data.len());
            println!("OSC777@{}: {:?}", p, String::from_utf8_lossy(&data[p..e]));
        }
        let tail = String::from_utf8_lossy(&data[data.len().saturating_sub(400)..]).into_owned();
        println!("tail: {tail:?}");
    }

    #[test]
    fn conpty_passes_cwd_sequences() {
        use std::sync::{Arc, Mutex as StdMutex};
        use std::time::{Duration, Instant};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoExit");
        cmd.arg("-Command");
        cmd.arg(POWERSHELL_INTEGRATION);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");
        let collected: Arc<StdMutex<Vec<u8>>> = Arc::default();
        let sink = collected.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                // ConPTY probes the terminal with DSR (ESC[6n) and stalls
                // until it gets an answer — xterm.js answers in the real app,
                // so emulate that here.
                if find(&buf[..n], b"\x1b[6n").is_some() {
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
                sink.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut osc7 = false;
        let mut osc99 = false;
        let mut osc133 = false;
        while Instant::now() < deadline {
            {
                let data = collected.lock().unwrap();
                osc7 = find(&data, b"\x1b]7;").is_some();
                osc99 = find(&data, b"\x1b]9;9;").is_some();
                osc133 = find(&data, b"\x1b]133;").is_some();
                if osc7 && osc99 && osc133 {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let tail = {
            let data = collected.lock().unwrap();
            let start = data.len().saturating_sub(600);
            String::from_utf8_lossy(&data[start..]).into_owned()
        };
        let _ = child.kill();
        assert!(
            osc7 || osc99,
            "cwd OSC survival: osc7={osc7} osc99={osc99} osc133={osc133}; tail: {tail:?}"
        );
    }
}

#[cfg(test)]
mod hook_settings_tests {
    use super::*;

    #[test]
    fn claude_hook_settings_is_valid_and_complete() {
        let s = claude_hook_settings("C:\\Program Files\\naru\\naru.exe", 12345, "tok", "abc-123");
        let v: serde_json::Value = serde_json::from_str(&s).expect("valid json");
        for ev in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "Notification",
            "SessionEnd",
        ] {
            assert!(v["hooks"][ev].is_array(), "{ev} hook missing");
        }
        // Exec form: command is OUR binary (GUI-subsystem → no console flash),
        // args carry the orchestrator coordinates run_hook needs.
        let entry = &v["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(
            entry["command"].as_str(),
            Some("C:\\Program Files\\naru\\naru.exe")
        );
        let args: Vec<&str> = entry["args"]
            .as_array()
            .expect("args array")
            .iter()
            .map(|a| a.as_str().expect("string arg"))
            .collect();
        assert_eq!(
            args,
            vec!["__naru-hook", "12345", "/hooks/claude/stop?session=abc-123", "tok"]
        );
    }

    #[test]
    fn settings_path_is_sanitized() {
        let p = claude_settings_path("a/../b:c");
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, "naru-claude-a____b_c.json");
    }
}
