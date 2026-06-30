//! Agent CLI plan quota (claude `/usage`, codex `/status` numbers) for the
//! sidebar widget. Both sources are the UNDOCUMENTED endpoints the CLIs
//! themselves use — parsed defensively, cached hard (claude's endpoint is
//! aggressively rate-limited), and every failure degrades to `None` so the
//! widget simply hides.
//!
//!   claude → GET api.anthropic.com/api/oauth/usage
//!            (Bearer accessToken from ~/.claude/.credentials.json)
//!   codex  → GET chatgpt.com/backend-api/wham/usage
//!            (Bearer tokens.access_token + chatgpt-account-id header
//!             from ~/.codex/auth.json; the CLI refreshes that file hourly)

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

const CACHE_TTL: Duration = Duration::from_secs(300);
/// An EMPTY report (both sources None) is usually a TRANSIENT failure — claude
/// rotates its oauth token and 429s its usage endpoint right as the CLI starts
/// (e.g. on `--resume`). Caching that "no data" for the full 5 min hides the
/// chip long after the agent settled, so empty reports expire fast and the
/// next poll re-fetches.
const EMPTY_TTL: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone)]
pub struct QuotaWindow {
    /// 0–100.
    pub used_percent: f64,
    /// ISO timestamp, when the source provides one.
    pub resets_at: Option<String>,
    /// Seconds until reset, when the source provides one instead.
    pub resets_in_seconds: Option<u64>,
}

#[derive(Serialize, Clone, Default)]
pub struct AgentQuota {
    pub five_hour: Option<QuotaWindow>,
    pub weekly: Option<QuotaWindow>,
}

#[derive(Serialize, Clone, Default)]
pub struct QuotaReport {
    pub claude: Option<AgentQuota>,
    pub codex: Option<AgentQuota>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok()
        .map(PathBuf::from)
}

fn read_json(path: PathBuf) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Tolerant window parser — the codex shape is reverse-engineered, so accept
/// the known field-name variants for both percentage and reset time.
fn parse_window(v: &Value) -> Option<QuotaWindow> {
    let pct = ["used_percent", "utilization", "usage_percent"]
        .iter()
        .find_map(|k| v.get(k))
        .and_then(|x| x.as_f64())?;
    Some(QuotaWindow {
        used_percent: pct.clamp(0.0, 100.0),
        resets_at: ["resets_at", "reset_at", "reset_time"]
            .iter()
            .find_map(|k| v.get(k))
            .and_then(|x| x.as_str())
            .map(String::from),
        resets_in_seconds: ["resets_in_seconds", "reset_after_seconds"]
            .iter()
            .find_map(|k| v.get(k))
            .and_then(|x| x.as_u64()),
    })
}

/// Claude Code keeps its OAuth credentials in ~/.claude/.credentials.json on
/// Windows/Linux, but on macOS it stores them in the login Keychain instead
/// (service "Claude Code-credentials") — the file simply doesn't exist there,
/// which is why the usage widget was always blank on Mac. Try the file first,
/// then fall back to the Keychain via the `security` CLI. Both carry the same
/// `{ claudeAiOauth: { accessToken, … } }` shape. Any failure → None (widget
/// hides), and if macOS shows a one-time Keychain access prompt, denying it is
/// no worse than today.
fn read_claude_credentials() -> Option<Value> {
    if let Some(v) =
        home_dir().and_then(|h| read_json(h.join(".claude").join(".credentials.json")))
    {
        return Some(v);
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        serde_json::from_str(String::from_utf8(out.stdout).ok()?.trim()).ok()
    }
    #[cfg(not(target_os = "macos"))]
    None
}

async fn fetch_claude(client: &reqwest::Client) -> Option<AgentQuota> {
    let creds = read_claude_credentials()?;
    let token = creds["claudeAiOauth"]["accessToken"].as_str()?;
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        // CRITICAL: a non-claude-code UA lands in a stricter 429 bucket.
        .header("User-Agent", "claude-code/2.0.0")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    let q = AgentQuota {
        five_hour: v.get("five_hour").and_then(parse_window),
        weekly: v.get("seven_day").and_then(parse_window),
    };
    (q.five_hour.is_some() || q.weekly.is_some()).then_some(q)
}

async fn fetch_codex(client: &reqwest::Client) -> Option<AgentQuota> {
    let auth = read_json(home_dir()?.join(".codex").join("auth.json"))?;
    let tokens = auth.get("tokens")?;
    let token = tokens.get("access_token")?.as_str()?;
    let account = tokens.get("account_id").and_then(|x| x.as_str());
    let mut req = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(token)
        .header("User-Agent", "codex_cli_rs/0.49.0")
        .timeout(Duration::from_secs(10));
    if let Some(acc) = account {
        req = req.header("chatgpt-account-id", acc);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    // primary = rolling 5h window, secondary = rolling weekly window
    let rl = v.get("rate_limit").or_else(|| v.get("rate_limits")).unwrap_or(&v);
    let q = AgentQuota {
        five_hour: ["primary_window", "primary"]
            .iter()
            .find_map(|k| rl.get(k))
            .and_then(parse_window),
        weekly: ["secondary_window", "secondary"]
            .iter()
            .find_map(|k| rl.get(k))
            .and_then(parse_window),
    };
    (q.five_hour.is_some() || q.weekly.is_some()).then_some(q)
}

static CACHE: Mutex<Option<(Instant, QuotaReport)>> = Mutex::new(None);
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Current plan usage for both agent CLIs (cached for 5 minutes — claude's
/// endpoint 429s eagerly). `force` bypasses the cache (manual refresh).
#[tauri::command]
pub async fn agent_quota(force: Option<bool>) -> QuotaReport {
    if force != Some(true) {
        // Recover from a poisoned lock rather than panicking forever — a
        // dropped quota read is harmless, the widget just hides.
        let cached = CACHE.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some((at, report)) = cached {
            // Successful reports cache hard (rate-limit protection); empty ones
            // (transient failure) expire fast so the chip recovers.
            let has_data = report.claude.is_some() || report.codex.is_some();
            let ttl = if has_data { CACHE_TTL } else { EMPTY_TTL };
            if at.elapsed() < ttl {
                return report;
            }
        }
    }
    let client = CLIENT.get_or_init(reqwest::Client::new);
    let (claude, codex) = tokio::join!(fetch_claude(client), fetch_codex(client));
    let report = QuotaReport { claude, codex };
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), report.clone()));
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_window_shape() {
        let v: Value = serde_json::json!({
            "utilization": 33.0,
            "resets_at": "2026-06-05T12:00:00+00:00"
        });
        let w = parse_window(&v).unwrap();
        assert_eq!(w.used_percent, 33.0);
        assert_eq!(w.resets_at.as_deref(), Some("2026-06-05T12:00:00+00:00"));
    }

    #[test]
    fn parses_codex_window_shape() {
        let v: Value = serde_json::json!({
            "used_percent": 6.0,
            "window_minutes": 299,
            "resets_in_seconds": 17940
        });
        let w = parse_window(&v).unwrap();
        assert_eq!(w.used_percent, 6.0);
        assert_eq!(w.resets_in_seconds, Some(17940));
    }

    #[test]
    fn rejects_window_without_percent() {
        assert!(parse_window(&serde_json::json!({ "resets_in_seconds": 5 })).is_none());
    }
}
