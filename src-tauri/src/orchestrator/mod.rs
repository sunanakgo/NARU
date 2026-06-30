//! Orchestrator API (PLAN §4). A token-protected localhost HTTP server that
//! lets an agent running inside one NARU pane observe and drive the others:
//! list sessions, read recent output, send input, and request a new session.
//! The port + token are exposed to every shell via NARU_ORCH_PORT / _TOKEN.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::pty::PtyManager;
use crate::status::{Status, StatusEngine};

/// Managed state: where the API is listening and its auth token.
pub struct OrchestratorInfo {
    pub port: u16,
    pub token: String,
}

struct Orch {
    token: String,
    app: AppHandle,
}

/// Constant-time byte compare — avoids leaking token bytes via timing.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Host-header check: defense-in-depth against DNS rebinding — a remote page
/// resolving to 127.0.0.1 still sends its own hostname in `Host`. The token
/// is the real gate; this just stops the socket being reachable cross-origin
/// at all. (Origin is absent for curl/hook callers, so only Host is checked.)
fn host_ok(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let name = if let Some(rest) = host.strip_prefix('[') {
        // bracketed IPv6 literal: [::1] or [::1]:port
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(h, _)| h)
    };
    matches!(name, "127.0.0.1" | "localhost" | "::1")
}

fn authed(headers: &HeaderMap, token: &str) -> bool {
    if !host_ok(headers) {
        return false;
    }
    let hv = |k: &str| headers.get(k).and_then(|v| v.to_str().ok());
    hv("x-naru-token").is_some_and(|v| ct_eq(v, token))
        || hv("authorization").is_some_and(|v| ct_eq(v, &format!("Bearer {token}")))
}

/// Start serving on an already-bound std listener (port known synchronously).
pub fn start(app: AppHandle, listener: std::net::TcpListener, token: String) {
    tauri::async_runtime::spawn(async move {
        let state = Arc::new(Orch { token, app });
        let router = Router::new()
            .route("/sessions", get(list_sessions))
            .route("/sessions/:id/input", post(send_input))
            .route("/sessions/:id/output", get(read_output))
            .route("/spawn", post(spawn_session))
            .route("/hooks/:brand/:event", post(hook_event))
            // Bound request bodies so a runaway/adversarial client can't make
            // the orchestrator buffer unbounded input.
            .layer(DefaultBodyLimit::max(64 * 1024))
            .with_state(state);

        let _ = listener.set_nonblocking(true);
        match tokio::net::TcpListener::from_std(listener) {
            Ok(tl) => {
                if let Err(e) = axum::serve(tl, router).await {
                    eprintln!("orchestrator: server exited: {e}");
                } else {
                    eprintln!("orchestrator: server stopped");
                }
            }
            Err(e) => eprintln!("orchestrator: failed to start: {e}"),
        }
    });
}

async fn list_sessions(
    State(st): State<Arc<Orch>>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    if !authed(&headers, &st.token) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let mgr = st.app.state::<PtyManager>();
    Ok(Json(json!({ "sessions": mgr.list() })))
}

async fn send_input(
    State(st): State<Arc<Orch>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Result<StatusCode, StatusCode> {
    if !authed(&headers, &st.token) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let mgr = st.app.state::<PtyManager>();
    mgr.write(&id, body.as_bytes())
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(StatusCode::OK)
}

async fn read_output(
    State(st): State<Arc<Orch>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<String, StatusCode> {
    if !authed(&headers, &st.token) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let mgr = st.app.state::<PtyManager>();
    Ok(mgr.recent_output(&id, 16 * 1024))
}

/// Agent lifecycle hooks (cmux-style). The CLI wrapper injects hooks at
/// `claude` launch that POST here; events map onto authoritative session
/// statuses, driving the notification ring / sidebar dots / OS alerts far
/// more reliably than output-silence heuristics.
async fn hook_event(
    State(st): State<Arc<Orch>>,
    Path((brand, event)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: String,
) -> Result<StatusCode, StatusCode> {
    if !authed(&headers, &st.token) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let Some(session) = query.get("session") else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let (status, release) = match event.as_str() {
        "stop" => (Status::Done, false),
        "notification" => (Status::Waiting, false),
        // Only an actual prompt submission means "generating a response" (drives
        // the sidebar spinner). session-start = the agent just launched and is
        // sitting idle at its prompt, NOT generating — so don't mark it Running.
        "prompt-submit" => (Status::Running, false),
        "session-start" => (Status::Idle, false),
        "session-end" => (Status::Idle, true),
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    st.app
        .state::<StatusEngine>()
        .on_hook_event(&st.app, session, status, release);

    // SessionStart's payload carries the agent's conversation id — remember
    // it so a restored NARU session can offer `claude --resume <id>`.
    if event == "session-start" {
        if let Ok(v) = serde_json::from_str::<Value>(&body) {
            if let Some(agent_id) = v.get("session_id").and_then(|x| x.as_str()) {
                st.app
                    .state::<crate::agentsessions::AgentSessions>()
                    .set(&st.app, session, &brand, agent_id);
            }
        }
    }
    Ok(StatusCode::OK)
}

async fn spawn_session(
    State(st): State<Arc<Orch>>,
    headers: HeaderMap,
    body: String,
) -> Result<StatusCode, StatusCode> {
    if !authed(&headers, &st.token) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // The frontend creates a new session/tab; the orchestrator can then poll
    // /sessions to find the new id and /input to run a command.
    let _ = st.app.emit("orchestrator://spawn", body);
    Ok(StatusCode::OK)
}
