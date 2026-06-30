//! Tauri command entry points (PLAN §6 — `src-tauri/src/commands.rs`).
//! Thin wrappers over `PtyManager`, invoked from the React frontend.

use tauri::{AppHandle, Manager, State};

use crate::pty::PtyManager;
use crate::status::StatusEngine;
use crate::triggers::TriggerEngine;

// NOTE on `#[tauri::command(async)]`: synchronous commands run INLINE in the
// webview's IPC callback — i.e. on the main/UI thread. Anything that spawns a
// process, touches the filesystem, or takes a lock that blocking I/O may hold
// (the PTY writer) therefore janks window dragging, typing and painting. The
// `(async)` attribute moves the (still synchronous) body onto the async
// runtime's thread pool instead. Only commands that are pure in-memory
// lookups (`pty_cwd`) or must touch the window (`set_window_blur`) stay sync.

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // mirrors the invoke arg surface 1:1
pub fn pty_create(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    inherit_from: Option<String>,
    minimal_prompt: Option<bool>,
    on_output: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<(), String> {
    manager.create(
        app,
        id,
        cols,
        rows,
        inherit_from,
        minimal_prompt.unwrap_or(false),
        on_output,
    )
}

/// Flip the prompt mode file — live shells pick it up on their next prompt.
#[tauri::command(async)]
pub fn set_prompt_mode(minimal: bool) {
    crate::pty::write_prompt_mode(minimal);
}

/// Fast lookup of a session's current (OSC 7) cwd — used by terminal link
/// resolution, where the full session_info scan would be too slow per click.
#[tauri::command]
pub fn pty_cwd(manager: State<'_, PtyManager>, id: String) -> Option<String> {
    manager.cwd(&id)
}

#[tauri::command(async)]
pub fn pty_write(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&id, data.as_bytes())
}

#[tauri::command(async)]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows)
}

#[tauri::command(async)]
pub fn pty_close(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    status: State<'_, StatusEngine>,
    triggers: State<'_, TriggerEngine>,
    id: String,
) -> Result<(), String> {
    status.remove(&id);
    triggers.remove(&id);
    let result = manager.close(&id);
    // The pane is gone for good — drop its saved cwd and resume offer.
    manager.persist_cwds(&app);
    app.state::<crate::agentsessions::AgentSessions>()
        .remove(&app, &id);
    result
}

/// Toggle the window's blur/acrylic effect (PLAN §7 polish; experimental).
#[tauri::command]
pub fn set_window_blur(app: AppHandle, enable: bool) -> Result<(), String> {
    use tauri::window::EffectsBuilder;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let mut builder = EffectsBuilder::new();
    if enable {
        #[cfg(windows)]
        {
            builder = builder.effect(tauri::window::Effect::Acrylic);
        }
        #[cfg(target_os = "macos")]
        {
            builder = builder.effect(tauri::window::Effect::HudWindow);
        }
    }
    win.set_effects(builder.build()).map_err(|e| e.to_string())
}

/// Bring the main NARU window to the foreground after a toast activation.
#[tauri::command]
pub fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.unminimize().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    // On Windows, set_focus can be ignored when another app owns foreground.
    // A short topmost toggle matches normal toast activation behavior without
    // leaving NARU pinned above other windows.
    #[cfg(windows)]
    {
        let _ = win.set_always_on_top(true);
        let _ = win.set_always_on_top(false);
    }

    Ok(())
}
