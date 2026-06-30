//! Disk-backed key-value store for frontend state (zustand persist).
//!
//! WebView2 flushes localStorage to disk LAZILY — a hard kill (Ctrl+C on
//! `tauri dev`, taskkill, crash) loses everything written since the last
//! flush, which wiped the user's tabs/settings between dev runs. Each key
//! lives in its own JSON file under app_data/kv, written tmp-then-rename so
//! a kill mid-write never corrupts the previous value.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::sleep;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

/// Serializes all kv writes/deletes. Tauri commands run on a thread pool, so
/// without this two `kv_set` calls could interleave their tmp-write + rename
/// and clobber each other's temp files.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Monotonic counter to make each write's tmp filename unique (combined with
/// the process id) so a slow straggler can never overwrite a newer tmp file.
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

fn kv_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("kv");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Keys are store names like "naru-settings" — already filesystem-safe, but
/// sanitize defensively so a weird key can never escape the kv dir.
fn sanitize(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// All stored entries (key = file stem). Called once at app startup.
#[tauri::command(async)]
pub fn kv_load(app: AppHandle) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(dir) = kv_dir(&app) else { return map };
    // Hold WRITE_LOCK so the tmp sweep below can't delete a tmp file that a
    // concurrent kv_set has written but not yet renamed.
    let _guard = WRITE_LOCK.lock();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            // Best-effort cleanup of stale temp files. Tmp names carry a unique
            // pid+counter suffix, so we can't reliably map them back to a key;
            // and with the atomic tmp-then-rename in `kv_set` the canonical
            // `{name}.json` is never absent, so a leftover tmp is only garbage
            // from a crash mid-write and safe to drop.
            if path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|n| n.contains(".tmp"))
            {
                let _ = fs::remove_file(&path);
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let (Some(stem), Ok(text)) = (
                path.file_stem().and_then(|s| s.to_str()),
                fs::read_to_string(&path),
            ) {
                map.insert(stem.to_string(), text);
            }
        }
    }
    map
}

#[tauri::command(async)]
pub fn kv_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let dir = kv_dir(&app).ok_or("no app data dir")?;
    let name = sanitize(&key);
    // Unique tmp name (pid + atomic counter) so concurrent writers — even to
    // the same key — never share a tmp file. The write+rename runs under
    // WRITE_LOCK to fully serialize against other kv mutations.
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!("{name}.json.{}.{seq}.tmp", std::process::id()));
    let path = dir.join(format!("{name}.json"));

    let _guard = WRITE_LOCK.lock();
    fs::write(&tmp, value).map_err(|e| e.to_string())?;
    // fs::rename atomically replaces an existing file on modern Rust/Windows
    // (MoveFileEx semantics), so no pre-delete window. Retry a few times to
    // ride out transient sharing violations (e.g. AV scanning the file).
    let mut last_err = None;
    for attempt in 0..3 {
        match fs::rename(&tmp, &path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e.to_string());
                if attempt < 2 {
                    sleep(Duration::from_millis(10));
                }
            }
        }
    }
    // Don't leak the tmp file if every rename attempt failed.
    let _ = fs::remove_file(&tmp);
    Err(last_err.unwrap_or_else(|| "rename failed".to_string()))
}

#[tauri::command(async)]
pub fn kv_delete(app: AppHandle, key: String) {
    if let Some(dir) = kv_dir(&app) {
        let _guard = WRITE_LOCK.lock();
        let _ = fs::remove_file(dir.join(format!("{}.json", sanitize(&key))));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sanitize_keeps_store_names_and_blocks_traversal() {
        assert_eq!(super::sanitize("naru-workspace-v2"), "naru-workspace-v2");
        assert_eq!(super::sanitize("../evil/key"), ".._evil_key");
        assert_eq!(super::sanitize("a\\b:c"), "a_b_c");
    }
}
