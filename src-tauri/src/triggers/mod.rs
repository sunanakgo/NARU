//! User-defined output trigger rules — the control-tower generalization of the
//! status engine (PLAN §5). Every session's output is matched, line by line,
//! against a set of user regexes; a match fires the rule's actions: an OS
//! notification (with optional sound) and/or a command written back into the
//! pane that matched. Rules are authored in Settings, persisted in the frontend
//! kv store, and pushed here via `set_triggers` whenever they change — regex
//! compilation lives in Rust so the hot output path only runs precompiled
//! patterns.
//!
//! This sits on the same `on_output` choke point as the StatusEngine, so it
//! sees EVERY pane — including background ones the user isn't looking at. That
//! is the whole point: "tell me when any pane prints X", even off-screen.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::pty::PtyManager;
use crate::status::strip_ansi;

/// Longest single line handed to the regex engine — a pathological no-newline
/// stream (a progress bar, a binary blob) must not give every pattern an
/// unbounded haystack. Longer lines are matched on their tail.
const LINE_CAP: usize = 8192;
/// Cooldown floor: even a rule configured with 0 gets this, so a match storm
/// (a build looping "error" every frame) fires at most a couple times a second.
const MIN_COOLDOWN: Duration = Duration::from_millis(750);
/// Default cooldown when a rule leaves `cooldownMs` at 0.
const DEFAULT_COOLDOWN: Duration = Duration::from_millis(3000);
/// Cap the matched-line snippet carried in the fired event (UI display only).
const SNIPPET_CAP: usize = 300;

/// A rule as authored in the UI. serde camelCase mirrors the zustand store's
/// natural object shape, so the frontend can pass its rules through verbatim.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerRule {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub enabled: bool,
    pub pattern: String,
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub sound: bool,
    /// Optional command written (with Enter) into the pane that matched.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub cooldown_ms: u64,
}

struct CompiledRule {
    id: String,
    name: String,
    re: regex::Regex,
    notify: bool,
    sound: bool,
    command: Option<String>,
    cooldown: Duration,
}

/// Reported back to the UI so a rule with a bad regex can be flagged inline
/// instead of silently never firing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerError {
    pub id: String,
    pub error: String,
}

/// Emitted on `naru://trigger` when a rule matches. The frontend turns this
/// into an OS notification / in-app toast; the command (if any) already ran
/// here in Rust.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TriggerFired {
    rule_id: String,
    rule_name: String,
    session_id: String,
    line: String,
    notify: bool,
    sound: bool,
    command: Option<String>,
}

#[derive(Default)]
pub struct TriggerEngine {
    rules: Mutex<Vec<CompiledRule>>,
    /// Per (rule_id, session_id) last-fire instant for cooldown.
    last_fire: Mutex<HashMap<(String, String), Instant>>,
    /// Per-session incomplete trailing line (ANSI already stripped).
    carry: Mutex<HashMap<String, String>>,
}

impl TriggerEngine {
    /// Replace the whole rule set. Returns the rules that failed to compile.
    pub fn set_rules(&self, rules: Vec<TriggerRule>) -> Vec<TriggerError> {
        let mut compiled = Vec::new();
        let mut errors = Vec::new();
        for r in rules {
            // Disabled / empty rules are dropped silently — not an error.
            if !r.enabled || r.pattern.trim().is_empty() {
                continue;
            }
            match RegexBuilder::new(&r.pattern)
                .case_insensitive(r.case_insensitive)
                .size_limit(1 << 20)
                .build()
            {
                Ok(re) => {
                    let cooldown = if r.cooldown_ms == 0 {
                        DEFAULT_COOLDOWN
                    } else {
                        Duration::from_millis(r.cooldown_ms).max(MIN_COOLDOWN)
                    };
                    let name = if r.name.trim().is_empty() {
                        r.pattern.clone()
                    } else {
                        r.name
                    };
                    compiled.push(CompiledRule {
                        id: r.id,
                        name,
                        re,
                        notify: r.notify,
                        sound: r.sound,
                        command: r.command.filter(|c| !c.trim().is_empty()),
                        cooldown,
                    });
                }
                Err(e) => errors.push(TriggerError {
                    id: r.id,
                    error: e.to_string(),
                }),
            }
        }
        // Forget cooldown state for rules that no longer exist so the map can't
        // grow as the user edits the rule list.
        let live: HashSet<String> = compiled.iter().map(|r| r.id.clone()).collect();
        self.last_fire.lock().retain(|(rule, _), _| live.contains(rule));
        *self.rules.lock() = compiled;
        errors
    }

    /// Drop a closed session's per-session state.
    pub fn remove(&self, id: &str) {
        self.carry.lock().remove(id);
        self.last_fire.lock().retain(|(_, sess), _| sess != id);
    }

    /// Feed a fresh output chunk for `id`. Called from the PTY reader thread,
    /// right after the StatusEngine on the same stream.
    pub fn on_output<R: Runtime>(&self, app: &AppHandle<R>, id: &str, bytes: &[u8]) {
        // Hot-path early out: no rules → nothing to do (the default case).
        if self.rules.lock().is_empty() {
            return;
        }

        // Accumulate stripped text, then peel off complete lines; the trailing
        // partial line carries to the next chunk so a match split across the
        // chunk boundary is still seen.
        let text = strip_ansi(bytes);
        let mut lines: Vec<String> = Vec::new();
        {
            let mut carry_map = self.carry.lock();
            let buf = carry_map.entry(id.to_string()).or_default();
            buf.push_str(&text);
            while let Some(pos) = buf.find('\n') {
                // pos indexes an ASCII '\n', so ..=pos is a valid char boundary.
                let mut line: String = buf.drain(..=pos).collect();
                while line.ends_with('\n') || line.ends_with('\r') {
                    line.pop();
                }
                lines.push(line);
            }
            // Guard an endless no-newline stream: flush the buffer as one line.
            if buf.len() > LINE_CAP {
                lines.push(std::mem::take(buf));
            }
        }
        if lines.is_empty() {
            return;
        }

        let now = Instant::now();
        let mut fired: Vec<TriggerFired> = Vec::new();
        let mut commands: Vec<String> = Vec::new();
        {
            let rules = self.rules.lock();
            let mut last = self.last_fire.lock();
            for rule in rules.iter() {
                // One fire per rule per chunk is plenty; stop at the first match.
                let Some(hit) = lines.iter().find(|l| rule.re.is_match(tail(l, LINE_CAP))) else {
                    continue;
                };
                let key = (rule.id.clone(), id.to_string());
                if let Some(t) = last.get(&key) {
                    if now.duration_since(*t) < rule.cooldown {
                        continue; // still cooling down
                    }
                }
                last.insert(key, now);
                if let Some(cmd) = &rule.command {
                    commands.push(cmd.clone());
                }
                fired.push(TriggerFired {
                    rule_id: rule.id.clone(),
                    rule_name: rule.name.clone(),
                    session_id: id.to_string(),
                    line: tail(hit, SNIPPET_CAP).to_string(),
                    notify: rule.notify,
                    sound: rule.sound,
                    command: rule.command.clone(),
                });
            }
        }

        for f in fired {
            let _ = app.emit("naru://trigger", f);
        }
        if !commands.is_empty() {
            if let Some(mgr) = app.try_state::<PtyManager>() {
                for cmd in commands {
                    let mut data = cmd.into_bytes();
                    data.push(b'\r');
                    let _ = mgr.write(id, &data);
                }
            }
        }
    }
}

/// The last `max` bytes of `s`, snapped forward to a char boundary so a slice
/// can never split a multi-byte codepoint (CJK/emoji output).
fn tail(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Replace the active rule set (called from the UI whenever rules change).
/// Returns per-rule compile errors so the UI can flag a bad pattern inline.
#[tauri::command(async)]
pub fn set_triggers(engine: State<'_, TriggerEngine>, rules: Vec<TriggerRule>) -> Vec<TriggerError> {
    engine.set_rules(rules)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, pattern: &str) -> TriggerRule {
        TriggerRule {
            id: id.into(),
            name: String::new(),
            enabled: true,
            pattern: pattern.into(),
            case_insensitive: true,
            notify: true,
            sound: false,
            command: None,
            cooldown_ms: 0,
        }
    }

    #[test]
    fn bad_regex_is_reported_not_panicked() {
        let e = TriggerEngine::default();
        let errs = e.set_rules(vec![rule("r1", "(unclosed")]);
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].id, "r1");
        assert!(e.rules.lock().is_empty());
    }

    #[test]
    fn disabled_and_empty_rules_drop_without_error() {
        let e = TriggerEngine::default();
        let mut disabled = rule("a", "x");
        disabled.enabled = false;
        let blank = rule("b", "   ");
        let errs = e.set_rules(vec![disabled, blank]);
        assert!(errs.is_empty());
        assert!(e.rules.lock().is_empty());
    }

    #[test]
    fn match_records_a_fire_and_cooldown_suppresses_the_next() {
        let e = TriggerEngine::default();
        e.set_rules(vec![rule("err", "error|panic")]);

        // Pure matching path (no AppHandle): mirror on_output's core so the
        // cooldown bookkeeping is exercised without a tauri runtime.
        let matched = |engine: &TriggerEngine, line: &str| -> bool {
            let now = Instant::now();
            let rules = engine.rules.lock();
            let mut last = engine.last_fire.lock();
            let mut any = false;
            for r in rules.iter() {
                if !r.re.is_match(line) {
                    continue;
                }
                let key = (r.id.clone(), "s1".to_string());
                if let Some(t) = last.get(&key) {
                    if now.duration_since(*t) < r.cooldown {
                        continue;
                    }
                }
                last.insert(key, now);
                any = true;
            }
            any
        };

        assert!(matched(&e, "build error: boom"), "first match should fire");
        assert!(!matched(&e, "another error here"), "cooldown should suppress");
    }

    #[test]
    fn set_rules_prunes_cooldown_state_for_removed_rules() {
        let e = TriggerEngine::default();
        e.set_rules(vec![rule("keep", "a"), rule("drop", "b")]);
        e.last_fire
            .lock()
            .insert(("drop".into(), "s1".into()), Instant::now());
        e.last_fire
            .lock()
            .insert(("keep".into(), "s1".into()), Instant::now());
        // Re-push without "drop" → its cooldown entry is forgotten.
        e.set_rules(vec![rule("keep", "a")]);
        let last = e.last_fire.lock();
        assert!(last.contains_key(&("keep".to_string(), "s1".to_string())));
        assert!(!last.contains_key(&("drop".to_string(), "s1".to_string())));
    }

    #[test]
    fn tail_snaps_to_char_boundary() {
        let s = format!("{}xy", "한".repeat(10)); // 30 bytes + "xy"
        let t = tail(&s, 5);
        assert!(t.len() <= 5);
        assert!(s.ends_with(t));
    }
}
