//! Agent session vault (cmux-style, minimal): remembers the LAST agent CLI
//! conversation id per NARU session so a restored session can offer
//! `claude --resume <id>`. Written by the SessionStart hook (its stdin
//! payload carries the agent's session_id), read by the resume chip in the
//! input bar, pruned when the pane is closed for good.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentSessionRecord {
    pub brand: String,
    pub agent_session_id: String,
    pub updated_at: u64,
}

#[derive(Default)]
pub struct AgentSessions {
    map: Mutex<HashMap<String, AgentSessionRecord>>,
    loaded: Mutex<bool>,
}

/// Entries older than this are dropped at load (cmux prunes at 7 days).
const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

fn store_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("agent-sessions.json"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl AgentSessions {
    fn ensure_loaded(&self, app: &AppHandle) {
        // Hold `loaded` across the whole critical section so a concurrent
        // reader never observes "loaded" with an empty/partial map. Lock
        // ordering is always `loaded` before `map`.
        let mut loaded = self.loaded.lock();
        if *loaded {
            return;
        }
        if let Some(path) = store_path(app) {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(stored) =
                    serde_json::from_str::<HashMap<String, AgentSessionRecord>>(&text)
                {
                    let cutoff = now_secs().saturating_sub(MAX_AGE_SECS);
                    let mut map = self.map.lock();
                    for (k, v) in stored {
                        if v.updated_at >= cutoff {
                            map.insert(k, v);
                        }
                    }
                }
            }
        }
        *loaded = true;
    }

    fn persist(&self, app: &AppHandle) {
        // Serializes concurrent persists (two SessionStart hooks can fire
        // near-simultaneously) — without this, both would write the same tmp
        // file and could install a torn JSON over the live vault.
        static PERSIST_LOCK: Mutex<()> = Mutex::new(());
        static PERSIST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

        let Some(path) = store_path(app) else { return };
        let Ok(json) = serde_json::to_string(&*self.map.lock()) else {
            return;
        };
        // Atomic replace: write to a uniquely-named sibling temp file, then
        // rename over the target. A crash mid-write can only damage the temp
        // file, never the live vault (`fs::rename` replaces an existing dest).
        let seq = PERSIST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
        let _guard = PERSIST_LOCK.lock();
        if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// SessionStart hook: remember this NARU session's live agent session.
    pub fn set(&self, app: &AppHandle, naru_id: &str, brand: &str, agent_id: &str) {
        self.ensure_loaded(app);
        self.map.lock().insert(
            naru_id.to_string(),
            AgentSessionRecord {
                brand: brand.to_string(),
                agent_session_id: agent_id.to_string(),
                updated_at: now_secs(),
            },
        );
        self.persist(app);
    }

    pub fn get(&self, app: &AppHandle, naru_id: &str) -> Option<AgentSessionRecord> {
        self.ensure_loaded(app);
        self.map.lock().get(naru_id).cloned()
    }

    /// Pane closed for good — its resume offer goes with it.
    pub fn remove(&self, app: &AppHandle, naru_id: &str) {
        self.ensure_loaded(app);
        if self.map.lock().remove(naru_id).is_some() {
            self.persist(app);
        }
    }
}

/// Latest resumable agent conversation for a NARU session (input-bar chip).
#[tauri::command(async)]
pub fn agent_resume_info(
    app: AppHandle,
    sessions: State<'_, AgentSessions>,
    id: String,
) -> Option<AgentSessionRecord> {
    sessions.get(&app, &id)
}

/// Frontend-recorded agent presence. claude captures a precise id via its
/// SessionStart hook; codex/opencode have no such hook, so when the UI detects
/// one running we remember just the brand (empty id) → the resume chip offers
/// "continue last session" (`codex resume --last` / `opencode --continue`).
/// Persisted, so the offer survives an app restart like claude's does.
#[tauri::command(async)]
pub fn agent_record_brand(
    app: AppHandle,
    sessions: State<'_, AgentSessions>,
    id: String,
    brand: String,
) {
    sessions.set(&app, &id, &brand, "");
}
