//! Per-session inspection (PLAN §3): the shell's working directory, which
//! coding agent (if any) is running in it, git branch + diff stat, and the
//! TCP ports its process tree is listening on. Driven by the shell pid via
//! sysinfo + `git` + `netstat`/`ss`, so no shell integration is required.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;

use crate::pty::PtyManager;

#[derive(Serialize, Default)]
pub struct SessionInfo {
    cwd: Option<String>,
    brand: String,
    branch: Option<String>,
    added: i64,
    removed: i64,
    /// TCP ports the session's process tree is listening on (e.g. dev servers).
    ports: Vec<u16>,
    /// Count of descendant processes under the session's shell — the agent and
    /// everything it has spawned (dev servers, build watchers…). Surfaced as
    /// the sidebar "background processes" badge so leftovers are visible at a
    /// glance; the scoped Process Monitor breaks them down.
    procs: u32,
}

/// Per-process metadata captured once per refresh into the shared snapshot.
struct ProcMeta {
    /// Lowercased name + cmdline, for agent-brand matching.
    hay: String,
    cwd: Option<String>,
}

// ── shared caches ─────────────────────────────────────────────────────────────
// Every visible session polls `session_info` on the same ~4s cadence, and a
// cold call is expensive: a full sysinfo process scan + a `netstat` spawn +
// two `git` spawns. N sessions used to multiply ALL of that every window —
// constant background CPU spikes (felt as window-drag jank). The caches below
// make each expensive piece run at most once per TTL, shared across sessions.

const SYS_TTL: Duration = Duration::from_millis(2000);
const PORTS_TTL: Duration = Duration::from_millis(2000);
const GIT_TTL: Duration = Duration::from_millis(3000);

/// Process-tree snapshot rebuilt once per SYS_TTL refresh and shared by ALL
/// `session_info` calls in that window — previously every pane's poll rebuilt
/// the parents/haystack maps itself, paying O(processes) string work × N
/// panes × every tick.
struct SysSnapshot {
    /// parent pid → child pids (for the descendant walk).
    children: HashMap<Pid, Vec<Pid>>,
    /// pid → captured metadata (haystack, cwd, cpu%, memory bytes).
    procs: HashMap<Pid, ProcMeta>,
}

struct SysState {
    sys: System,
    refreshed: Option<Instant>,
    snapshot: Arc<SysSnapshot>,
}

#[derive(Clone)]
struct GitEntry {
    at: Instant,
    branch: Option<String>,
    added: i64,
    removed: i64,
}

/// Timestamped pid → listening-ports map (see `port_map_cached`).
type PortsCache = Option<(Instant, HashMap<u32, Vec<u16>>)>;

/// Tauri managed state — one per app.
pub struct InfoCache {
    sys: Mutex<SysState>,
    ports: Mutex<PortsCache>,
    git: Mutex<HashMap<String, GitEntry>>,
}

impl Default for InfoCache {
    fn default() -> Self {
        Self {
            sys: Mutex::new(SysState {
                sys: System::new(),
                refreshed: None,
                snapshot: Arc::new(SysSnapshot {
                    children: HashMap::new(),
                    procs: HashMap::new(),
                }),
            }),
            ports: Mutex::new(None),
            git: Mutex::new(HashMap::new()),
        }
    }
}

/// pid → listening ports, via procmon's per-OS scan, cached for PORTS_TTL.
fn port_map_cached(cache: &InfoCache) -> HashMap<u32, Vec<u16>> {
    let mut guard = cache.ports.lock();
    if let Some((at, map)) = guard.as_ref() {
        if at.elapsed() < PORTS_TTL {
            return map.clone();
        }
    }
    let map = crate::procmon::listening_port_map();
    *guard = Some((Instant::now(), map.clone()));
    map
}

/// Entries this stale are dropped during the next sweep — well past GIT_TTL so
/// a still-active cwd is never evicted, but closed sessions don't leak forever.
const GIT_MAX_AGE: Duration = Duration::from_secs(30); // ~10× GIT_TTL
/// Sweep the git cache only once it has grown beyond this many cwds.
const GIT_SWEEP_THRESHOLD: usize = 64;

/// git branch + diff stat for a cwd, cached for GIT_TTL (sessions sharing a
/// cwd share the spawns). Non-repos skip the diff entirely.
fn git_cached(cache: &InfoCache, cwd: &str) -> (Option<String>, i64, i64) {
    if let Some(e) = cache.git.lock().get(cwd) {
        if e.at.elapsed() < GIT_TTL {
            return (e.branch.clone(), e.added, e.removed);
        }
    }
    let branch = git_branch(cwd);
    let (added, removed) = if branch.is_some() {
        git_diff(cwd)
    } else {
        (0, 0)
    };
    let mut map = cache.git.lock();
    // The cache is keyed by cwd and never shrinks on its own; evict entries
    // for cwds nobody has polled recently so it can't grow unbounded.
    if map.len() >= GIT_SWEEP_THRESHOLD {
        map.retain(|_, e| e.at.elapsed() < GIT_MAX_AGE);
    }
    map.insert(
        cwd.to_string(),
        GitEntry {
            at: Instant::now(),
            branch: branch.clone(),
            added,
            removed,
        },
    );
    (branch, added, removed)
}

const AGENTS: &[(&str, &str)] = &[
    ("opencode", "opencode"),
    ("claude", "claude"),
    ("codex", "codex"),
    ("gemini", "gemini"),
    ("aider", "aider"),
];

// `(async)` — runs on the async runtime's pool, NOT the main thread: this is
// the most expensive command in the app (full sysinfo process scan with
// cwd/cmd, netstat spawn, up to two git spawns with 4s timeouts), and every
// visible pane polls it on a ~4s cadence. Inline-on-main-thread execution was
// the structural cause of window-drag/typing jank.
#[tauri::command(async)]
pub fn session_info(
    manager: State<'_, PtyManager>,
    cache: State<'_, InfoCache>,
    id: String,
) -> SessionInfo {
    let mut info = SessionInfo {
        brand: "shell".into(),
        ..Default::default()
    };

    let Some(pid_u) = manager.pid(&id) else {
        return info;
    };
    let root = Pid::from_u32(pid_u);

    // Persistent System, refreshed at most once per SYS_TTL across ALL
    // sessions' polls. The per-process maps (haystacks, parent→children) are
    // rebuilt ONCE per refresh into a shared Arc snapshot — N panes polling
    // within the TTL window reuse it instead of each paying O(processes).
    let snapshot = {
        let mut sys_state = cache.sys.lock();
        if sys_state
            .refreshed
            .is_none_or(|t| t.elapsed() > SYS_TTL)
        {
            sys_state.sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cwd(UpdateKind::Always)
                    .with_cmd(UpdateKind::Always),
            );
            sys_state.refreshed = Some(Instant::now());

            let sys = &sys_state.sys;
            let mut procs = HashMap::with_capacity(sys.processes().len());
            let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
            for (pid, proc) in sys.processes() {
                if let Some(parent) = proc.parent() {
                    children.entry(parent).or_default().push(*pid);
                }
                let mut hay = proc.name().to_string_lossy().to_lowercase();
                for arg in proc.cmd() {
                    hay.push(' ');
                    hay.push_str(&arg.to_string_lossy().to_lowercase());
                }
                let cwd = proc.cwd().map(|c| c.display().to_string());
                procs.insert(*pid, ProcMeta { hay, cwd });
            }
            sys_state.snapshot = Arc::new(SysSnapshot { children, procs });
        }
        sys_state.snapshot.clone()
    }; // sys lock dropped here; the walk below runs on the shared snapshot.

    // OSC 7 from the shell integration is authoritative — the Win32 process
    // cwd does NOT follow PowerShell's `cd`. Fall back to the process cwd.
    info.cwd = manager.cwd(&id);
    if info.cwd.is_none() {
        info.cwd = snapshot.procs.get(&root).and_then(|m| m.cwd.clone());
    }

    // Collect the whole descendant set (for brand + port matching).
    let mut descendants: Vec<Pid> = Vec::new();
    let mut stack = vec![root];
    let mut seen = HashSet::new();
    while let Some(p) = stack.pop() {
        if let Some(kids) = snapshot.children.get(&p) {
            for c in kids {
                if seen.insert(*c) {
                    descendants.push(*c);
                    stack.push(*c);
                }
            }
        }
    }
    // Everything under the shell (excludes the shell itself) — the sidebar
    // badge's "how many is this session running" number.
    info.procs = descendants.len() as u32;

    // Detect a running agent (prefer its cwd).
    'walk: for c in &descendants {
        if let Some(m) = snapshot.procs.get(c) {
            for (needle, brand) in AGENTS {
                if m.hay.contains(needle) {
                    info.brand = (*brand).to_string();
                    if let Some(cwd) = &m.cwd {
                        info.cwd = Some(cwd.clone());
                    }
                    break 'walk;
                }
            }
        }
    }

    // Listening ports owned by this process tree (shared netstat snapshot).
    let mut pidset: HashSet<u32> = descendants.iter().map(|p| p.as_u32()).collect();
    pidset.insert(pid_u);
    let port_map = port_map_cached(&cache);
    let mut ports: std::collections::BTreeSet<u16> = Default::default();
    for (pid, plist) in &port_map {
        if pidset.contains(pid) {
            ports.extend(plist.iter().copied());
        }
    }
    info.ports = ports.into_iter().take(8).collect();

    if let Some(cwd) = info.cwd.clone() {
        let (branch, added, removed) = git_cached(&cache, &cwd);
        info.branch = branch;
        info.added = added;
        info.removed = removed;
    }

    info
}

/// How long a single `git` spawn may run before we kill it. A hung git (network
/// remote, locked index, filesystem stall) must never block the info poll.
const GIT_SPAWN_TIMEOUT: Duration = Duration::from_secs(4);

/// Run a command, capturing stdout on success, killing it on `timeout`.
/// Thin success-gated wrapper over the shared `repo::run_with_timeout`
/// (CREATE_NO_WINDOW, try_wait poll loop) — this module used to carry its own
/// copy of that logic.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<Vec<u8>> {
    let out = crate::repo::run_with_timeout(&mut cmd, timeout)?;
    out.status.success().then_some(out.stdout)
}

fn git_branch(cwd: &str) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    let out = run_with_timeout(cmd, GIT_SPAWN_TIMEOUT)?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn git_diff(cwd: &str) -> (i64, i64) {
    let mut cmd = Command::new("git");
    cmd.args(["-C", cwd, "diff", "--numstat", "HEAD"]);
    let out = match run_with_timeout(cmd, GIT_SPAWN_TIMEOUT) {
        Some(o) => o,
        None => return (0, 0),
    };
    let text = String::from_utf8_lossy(&out);
    let mut added = 0i64;
    let mut removed = 0i64;
    for line in text.lines() {
        let mut parts = line.split('\t');
        if let Some(a) = parts.next() {
            if let Ok(n) = a.parse::<i64>() {
                added += n;
            }
        }
        if let Some(r) = parts.next() {
            if let Ok(n) = r.parse::<i64>() {
                removed += n;
            }
        }
    }
    (added, removed)
}

