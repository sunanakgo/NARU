mod agentsessions;
mod browser;
mod commands;
mod kv;
mod orchestrator;
mod procmon;
mod pty;
mod quota;
mod repo;
mod sessioninfo;
mod status;
mod triggers;

use tauri::Manager;

use browser::BrowserManager;
use orchestrator::OrchestratorInfo;
use pty::PtyManager;
use status::StatusEngine;

/// The orchestrator failing to start silently kills agent lifecycle hooks
/// (status falls back to output heuristics) — surface it instead of only
/// logging to a console nobody sees.
fn notify_orchestrator_down(app: &tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("NARU")
        .body("에이전트 상태 훅을 시작하지 못했습니다 — 상태 표시가 부정확할 수 있습니다.")
        .show();
}

/// Hook-helper mode. Claude Code's injected lifecycle hooks launch THIS exe as
/// `naru __naru-hook <port> <path> <token>` (exec form, no shell). We POST the
/// event to the local orchestrator over a raw localhost HTTP/1.1 request and
/// return. The event JSON Claude pipes to our stdin becomes the body — mirrors
/// the old `curl --data-binary @-` call.
///
/// Why this exists: the previous hook ran `curl.exe`, a console-subsystem
/// program. Claude Code on Windows spawns hooks WITHOUT CREATE_NO_WINDOW
/// (issue #61051), so every hook flashed a black console window. naru.exe is a
/// GUI-subsystem binary, so Claude spawning it directly allocates no console —
/// no flash. Best-effort throughout: a hook must never crash or hang the CLI,
/// so every failure is swallowed.
fn run_hook(args: &[String]) {
    use std::io::{Read, Write};
    use std::time::Duration;
    let (Some(port), Some(path), Some(token)) = (args.get(2), args.get(3), args.get(4)) else {
        return;
    };
    let Ok(port) = port.parse::<u16>() else { return };

    // Read the event payload Claude pipes to stdin (may be empty for some events).
    let mut body = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut body);

    let timeout = Duration::from_secs(5);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, timeout) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(timeout));
    let _ = stream.set_read_timeout(Some(timeout));
    // Host header must be 127.0.0.1/localhost (orchestrator's DNS-rebinding
    // guard); x-naru-token is the real auth gate.
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-naru-token: {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(head.as_bytes()).is_err() || stream.write_all(&body).is_err() {
        return;
    }
    let _ = stream.flush();
    // Drain the response so the server runs the handler to completion before we exit.
    let mut sink = [0u8; 1024];
    while let Ok(n) = stream.read(&mut sink) {
        if n == 0 {
            break;
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Hook-helper fast path — handle and exit BEFORE Tauri/single-instance, so
    // a hook invocation never registers as a second app instance (which would
    // steal window focus) and never spins up the webview. See run_hook().
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("__naru-hook") {
        run_hook(&args);
        return;
    }

    tauri::Builder::default()
        // MUST be registered first. A second launch focuses the existing
        // window instead of starting another process — two instances share
        // app_data (kv, session-cwds, agent-sessions) and %TEMP% control
        // files with last-writer-wins semantics, silently corrupting state.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Self-update: the frontend (store/updater.ts) calls the updater
        // plugin's check()/downloadAndInstall() directly against the public
        // repo's GitHub Releases, then relaunches via the process plugin.
        // Both crates are desktop-only (see Cargo.toml target gate).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyManager::default())
        .manage(StatusEngine::default())
        .manage(triggers::TriggerEngine::default())
        .manage(BrowserManager::default())
        .manage(procmon::ProcMonState::default())
        .manage(sessioninfo::InfoCache::default())
        .manage(agentsessions::AgentSessions::default())
        .setup(|app| {
            // Background monitor for idle/waiting transitions (PLAN §5).
            StatusEngine::start_monitor(app.handle().clone());

            // Warm the PATH-commands cache off the command thread — the first
            // scan walks every PATH dir and would otherwise block the first
            // completion request (slow on network-drive PATH entries).
            std::thread::spawn(|| {
                let _ = repo::list_path_commands();
            });

            // Orchestrator API (PLAN §4): bind synchronously so the port is
            // known for shell env vars, then serve on the async runtime.
            let mut tok = [0u8; 16];
            if getrandom::getrandom(&mut tok).is_err() {
                // CSPRNG unavailable — fall back to a non-constant (but weaker)
                // seed so the token isn't all-zeros. Loud warning: a predictable
                // token weakens the orchestrator's localhost auth.
                eprintln!(
                    "naru: WARNING getrandom failed — orchestrator token is using a \
                     weak fallback seed (process id + monotonic clock). The local \
                     hook auth token is LESS secure than intended."
                );
                use std::hash::{Hash, Hasher};
                let mut seed = std::collections::hash_map::DefaultHasher::new();
                std::process::id().hash(&mut seed);
                // Duration since the epoch is always Hash; avoids depending on
                // Instant/SystemTime's own Hash impls.
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_else(|_| std::time::Instant::now().elapsed().as_nanos())
                    .hash(&mut seed);
                // Spread the 64-bit hash, re-mixing per chunk so the 16 bytes
                // aren't a trivially repeating 8-byte pattern.
                for (i, b) in tok.iter_mut().enumerate() {
                    let mut h = std::collections::hash_map::DefaultHasher::new();
                    seed.finish().hash(&mut h);
                    (i as u64).hash(&mut h);
                    *b = (h.finish() & 0xff) as u8;
                }
            }
            let token: String = tok.iter().map(|b| format!("{b:02x}")).collect();
            match std::net::TcpListener::bind("127.0.0.1:0") {
                Ok(listener) => match listener.local_addr() {
                    Ok(addr) => {
                        app.manage(OrchestratorInfo {
                            port: addr.port(),
                            token: token.clone(),
                        });
                        orchestrator::start(app.handle().clone(), listener, token);
                    }
                    Err(e) => {
                        eprintln!("naru: orchestrator local_addr failed: {e} — agent API disabled");
                        notify_orchestrator_down(app.handle());
                    }
                },
                Err(e) => {
                    eprintln!("naru: orchestrator TcpListener::bind failed: {e} — agent API disabled");
                    notify_orchestrator_down(app.handle());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_create,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_close,
            commands::set_prompt_mode,
            commands::set_window_blur,
            commands::focus_main_window,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_navigate,
            browser::browser_hide,
            browser::browser_close,
            sessioninfo::session_info,
            repo::fs_list,
            repo::repo_info,
            repo::git_changes,
            repo::git_diff_file,
            repo::read_text_file,
            repo::read_image_data_url,
            repo::save_pasted_image,
            repo::save_pasted_text,
            repo::path_kind,
            repo::list_path_commands,
            repo::agent_commands,
            repo::open_dir_in,
            quota::agent_quota,
            procmon::process_list,
            procmon::process_kill,
            kv::kv_load,
            kv::kv_set,
            kv::kv_delete,
            agentsessions::agent_resume_info,
            agentsessions::agent_record_brand,
            commands::pty_cwd,
            triggers::set_triggers,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // On app exit, kill + reap every PTY session and join its reader
            // thread so no orphaned shells / detached threads outlive us.
            if let tauri::RunEvent::Exit = event {
                app.state::<PtyManager>().shutdown_all();
            }
        });
}
