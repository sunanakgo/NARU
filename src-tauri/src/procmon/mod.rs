//! Process Monitor (PLAN §3 ops): surface processes that AI agents / dev
//! servers leave running so the user can inspect and kill them. Two sources,
//! in priority order:
//!   1. descendants of NARU's own PTY shells (owner session attached),
//!   2. any other user process holding a LISTENING TCP port (orphaned dev
//!      servers whose parent shell is long gone).

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::time::Duration;

use parking_lot::Mutex;

use crate::repo::run_with_timeout;
use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;

use crate::pty::PtyManager;

/// Persistent sysinfo handle. CPU% is a delta between two samples — a fresh
/// `System` per call would always report 0 — so the monitor keeps one alive
/// across polls (the pane refreshes every ~5s, well past sysinfo's minimum
/// CPU sampling interval).
#[derive(Default)]
pub struct ProcMonState {
    sys: Mutex<System>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    /// Full command line (exe + args), best effort.
    pub command: String,
    pub cwd: Option<String>,
    /// CPU usage as % of the whole machine (Task-Manager style, all cores).
    pub cpu: f32,
    /// Resident memory in bytes.
    pub memory: u64,
    /// TCP ports this pid is LISTENING on.
    pub ports: Vec<u16>,
    /// PTY session id (== terminal panel id) whose shell tree owns this pid.
    pub session_id: Option<String>,
    /// The pane's shell process itself (killing it ends that pane's shell).
    pub is_shell: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessList {
    pub entries: Vec<ProcessEntry>,
    /// Whole-machine CPU usage %, 0 on the very first sample.
    pub cpu_total: f32,
    pub mem_used: u64,
    pub mem_total: u64,
}

/// Windows system processes that must never appear in (or be killed from)
/// the monitor — they hold listening ports but are not the user's leftovers.
#[cfg(windows)]
const SYSTEM_PROCESS_NAMES: &[&str] = &[
    "system",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
    "spoolsv.exe",
    "searchhost.exe",
    "memcompression",
    "registry",
    "idle",
];

/// Windows: match by executable name against the known-system list.
#[cfg(windows)]
fn is_system_process(name: &str, _exe: Option<&std::path::Path>) -> bool {
    let lower = name.to_lowercase();
    SYSTEM_PROCESS_NAMES.iter().any(|s| *s == lower)
}

/// macOS/Linux: OS daemons that hold listening ports (mDNSResponder, rapportd,
/// sharingd, remoted, ControlCenter, …) live under these prefixes. The user's
/// leftover dev servers run from /usr/local, /opt/homebrew, ~/.nvm, project
/// node_modules, etc., so a path-prefix test is far more robust than a name
/// list. `/usr/bin` is deliberately NOT treated as system — a leftover like
/// `/usr/bin/python3 -m http.server` should still surface.
#[cfg(not(windows))]
fn is_system_process(_name: &str, exe: Option<&std::path::Path>) -> bool {
    const SYSTEM_DIRS: &[&str] = &[
        "/System/",
        "/usr/libexec/",
        "/usr/sbin/",
        "/sbin/",
        "/usr/lib/",
    ];
    match exe.and_then(|p| p.to_str()) {
        Some(path) => SYSTEM_DIRS.iter().any(|d| path.starts_with(d)),
        None => false,
    }
}

// `(async)` — netstat spawn (up to 5s timeout) + full process refresh must
// never run inline on the main/UI thread (see commands.rs note).
#[tauri::command(async)]
pub fn process_list(
    manager: State<'_, PtyManager>,
    state: State<'_, ProcMonState>,
) -> ProcessList {
    // pid → listening ports (one netstat pass for the whole table). Done BEFORE
    // taking the `sys` lock so the blocking subprocess spawn doesn't hold it.
    let port_map = listening_port_map();

    let mut sys = state.sys.lock();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cwd(UpdateKind::Always)
            .with_cmd(UpdateKind::Always)
            .with_exe(UpdateKind::Always)
            .with_cpu()
            .with_memory(),
    );
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    // sysinfo reports per-process CPU as % of ONE core; normalize to % of the
    // whole machine so the column reads like Task Manager.
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1) as f32;

    // Walk each PTY shell's descendant tree; first owner wins (a pid can't
    // belong to two trees anyway, but HashMap entry guards double-insert).
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, proc) in sys.processes() {
        if let Some(parent) = proc.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    let mut owner: HashMap<u32, (String, bool)> = HashMap::new();
    for (session_id, shell_pid) in manager.session_pids() {
        owner
            .entry(shell_pid)
            .or_insert_with(|| (session_id.clone(), true));
        let mut stack = vec![Pid::from_u32(shell_pid)];
        let mut seen: HashSet<Pid> = HashSet::new();
        while let Some(p) = stack.pop() {
            if let Some(kids) = children.get(&p) {
                for c in kids {
                    if seen.insert(*c) {
                        owner
                            .entry(c.as_u32())
                            .or_insert_with(|| (session_id.clone(), false));
                        stack.push(*c);
                    }
                }
            }
        }
    }

    let self_pid = std::process::id();
    let mut entries: Vec<ProcessEntry> = Vec::new();
    for (pid, proc) in sys.processes() {
        let pid_u = pid.as_u32();
        // NARU itself (and its webview helpers) are not "leftovers".
        if pid_u == self_pid || pid_u <= 4 {
            continue;
        }
        let name = proc.name().to_string_lossy().to_string();
        let owned = owner.get(&pid_u);
        let ports = port_map.get(&pid_u).cloned().unwrap_or_default();
        // Keep: PTY-tree members always; otherwise only port listeners that
        // aren't OS services.
        if owned.is_none() && (ports.is_empty() || is_system_process(&name, proc.exe())) {
            continue;
        }
        let command = {
            let joined = proc
                .cmd()
                .iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            if joined.is_empty() {
                name.clone()
            } else {
                joined
            }
        };
        entries.push(ProcessEntry {
            pid: pid_u,
            parent_pid: proc.parent().map(|p| p.as_u32()),
            name,
            command,
            cwd: proc.cwd().map(|p| p.display().to_string()),
            cpu: proc.cpu_usage() / cores,
            memory: proc.memory(),
            ports,
            session_id: owned.map(|(id, _)| id.clone()),
            is_shell: owned.map(|(_, shell)| *shell).unwrap_or(false),
        });
    }

    // Session-owned trees first, then orphaned listeners; stable pid order
    // within each group so refreshes don't shuffle rows.
    entries.sort_by(|a, b| {
        let ga = if a.session_id.is_some() { 0 } else { 1 };
        let gb = if b.session_id.is_some() { 0 } else { 1 };
        ga.cmp(&gb)
            .then(a.session_id.cmp(&b.session_id))
            .then(a.pid.cmp(&b.pid))
    });
    ProcessList {
        entries,
        cpu_total: sys.global_cpu_usage(),
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
    }
}

/// Kill a process (and on Windows its whole tree — dev servers wrap their
/// real server in npm/cmd shims, so killing only the root leaves the port
/// held). Refuses NARU's own pid and obvious system pids.
///
/// CAVEAT (PID reuse): the pid comes from an earlier `process_list` snapshot;
/// if that process exited in the meantime the OS may have recycled the pid,
/// and the kill would hit an unrelated process. Fully closing that window
/// needs a handle + creation-time check; accepted as low-likelihood for a
/// user-driven kill from a list refreshed every few seconds.
#[tauri::command(async)]
pub fn process_kill(pid: u32) -> Result<(), String> {
    if pid == std::process::id() {
        return Err("cannot kill NARU itself".into());
    }
    if pid <= 4 {
        return Err("refusing to kill a system process".into());
    }

    #[cfg(windows)]
    {
        // /T kills the descendant tree, /F forces — equivalent of SIGKILL.
        let out = run_with_timeout(
            Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]),
            Duration::from_secs(5),
        )
        .ok_or_else(|| "taskkill timed out".to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    #[cfg(not(windows))]
    {
        // Kill the whole descendant tree (Windows uses `taskkill /T`): dev
        // servers wrap their real process in npm/shell shims, so SIGKILL'ing
        // only the root leaves the server — and its port — alive, reparented to
        // launchd/init. Build the same parent→children map process_list uses,
        // collect the target + all descendants, then kill leaves-first.
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let root = Pid::from_u32(pid);
        if sys.process(root).is_none() {
            return Err("process not found".into());
        }
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (cpid, proc) in sys.processes() {
            if let Some(parent) = proc.parent() {
                children.entry(parent).or_default().push(*cpid);
            }
        }
        let mut targets = vec![root];
        let mut stack = vec![root];
        let mut seen: HashSet<Pid> = HashSet::new();
        while let Some(p) = stack.pop() {
            if let Some(kids) = children.get(&p) {
                for c in kids {
                    if *c != root && seen.insert(*c) {
                        targets.push(*c);
                        stack.push(*c);
                    }
                }
            }
        }
        // Reverse the discovery order so children die before their parents (a
        // parent can't respawn a child we already reaped). The root's success
        // is what the caller cares about.
        let mut killed_root = false;
        for t in targets.iter().rev() {
            if let Some(proc) = sys.process(*t) {
                let ok = proc.kill();
                if *t == root {
                    killed_root = ok;
                }
            }
        }
        if killed_root {
            Ok(())
        } else {
            Err("kill failed (insufficient permission?)".into())
        }
    }
}

/// pid → LISTENING TCP ports, one snapshot for the whole process table.
/// Shared with sessioninfo (which caches it).
pub(crate) fn listening_port_map() -> HashMap<u32, Vec<u16>> {
    #[cfg(windows)]
    {
        match run_with_timeout(
            Command::new("netstat").args(["-ano", "-p", "TCP"]),
            Duration::from_secs(5),
        ) {
            Some(out) => parse_netstat(&String::from_utf8_lossy(&out.stdout)),
            None => HashMap::new(),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
        // `-F` field output is column-position-proof: each process emits a
        // `p<pid>` line and each open socket an `n<addr>` line, so a command
        // name containing spaces (which shifted the old whitespace-column
        // parse) no longer breaks pid/port extraction. Same timeout bound as
        // the Windows netstat branch — a hung lsof (dead NFS, stuck mount)
        // must not wedge the poller thread.
        if let Some(out) = run_with_timeout(
            Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]),
            Duration::from_secs(5),
        ) {
            let mut cur: Option<u32> = None;
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let mut chars = line.chars();
                let Some(tag) = chars.next() else { continue };
                let rest = chars.as_str();
                match tag {
                    // new process record — subsequent `n` lines belong to it
                    'p' => cur = rest.parse::<u32>().ok(),
                    // socket address: "*:3000", "127.0.0.1:5173", "[::1]:8080"
                    'n' => {
                        let Some(pid) = cur else { continue };
                        let Some(port) = rest
                            .rsplit(':')
                            .next()
                            .and_then(|p| p.parse::<u16>().ok())
                        else {
                            continue;
                        };
                        if port != 0 {
                            let ports = map.entry(pid).or_default();
                            if !ports.contains(&port) {
                                ports.push(port);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        map
    }

    #[cfg(target_os = "linux")]
    {
        let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
        // Same timeout bound as the Windows netstat branch.
        if let Some(out) = run_with_timeout(
            Command::new("ss").args(["-tlnp"]),
            Duration::from_secs(5),
        ) {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if !line.contains("LISTEN") {
                    continue;
                }
                let pid = line.split("pid=").nth(1).and_then(|rest| {
                    rest.split(|c: char| !c.is_ascii_digit())
                        .next()
                        .and_then(|p| p.parse::<u32>().ok())
                });
                let port = line
                    .split_whitespace()
                    .nth(3)
                    .and_then(|addr| addr.rsplit(':').next())
                    .and_then(|p| p.parse::<u16>().ok());
                if let (Some(pid), Some(port)) = (pid, port) {
                    if port != 0 {
                        let ports = map.entry(pid).or_default();
                        if !ports.contains(&port) {
                            ports.push(port);
                        }
                    }
                }
            }
        }
        map
    }
}

/// Parse `netstat -ano -p TCP` output into pid → listening ports.
/// Kept separate from the Command call so it is unit-testable.
#[cfg(windows)]
fn parse_netstat(text: &str) -> HashMap<u32, Vec<u16>> {
    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 5 && cols[3] == "LISTENING" {
            let (Some(pid), Some(port)) = (
                cols[4].parse::<u32>().ok(),
                cols[1].rsplit(':').next().and_then(|p| p.parse::<u16>().ok()),
            ) else {
                continue;
            };
            if port != 0 {
                let ports = map.entry(pid).or_default();
                if !ports.contains(&port) {
                    ports.push(port);
                }
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn parse_netstat_extracts_listening_pids_and_ports() {
        let sample = "\
Active Connections\n\
\n\
  Proto  Local Address          Foreign Address        State           PID\n\
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234\n\
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234\n\
  TCP    [::1]:8080             [::]:0                 LISTENING       9999\n\
  TCP    192.168.0.2:54321      52.1.2.3:443           ESTABLISHED     7777\n\
  TCP    0.0.0.0:0              0.0.0.0:0              LISTENING       not-a-pid\n";
        let map = super::parse_netstat(sample);
        assert_eq!(map.get(&1234), Some(&vec![3000u16, 5173]));
        assert_eq!(map.get(&9999), Some(&vec![8080u16]));
        assert!(!map.contains_key(&7777)); // ESTABLISHED is not LISTENING
        assert_eq!(map.len(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn system_processes_are_filtered() {
        assert!(super::is_system_process("svchost.exe", None));
        assert!(super::is_system_process("SvcHost.EXE", None));
        assert!(!super::is_system_process("node.exe", None));
    }

    #[cfg(not(windows))]
    #[test]
    fn system_processes_are_filtered_by_path() {
        use std::path::Path;
        // OS daemons under system dirs are filtered out…
        assert!(super::is_system_process(
            "mDNSResponder",
            Some(Path::new("/usr/sbin/mDNSResponder"))
        ));
        assert!(super::is_system_process(
            "rapportd",
            Some(Path::new("/usr/libexec/rapportd"))
        ));
        // …while the user's leftover dev servers are kept (shown).
        assert!(!super::is_system_process(
            "node",
            Some(Path::new("/opt/homebrew/bin/node"))
        ));
        assert!(!super::is_system_process(
            "python3",
            Some(Path::new("/usr/bin/python3"))
        ));
        assert!(!super::is_system_process("node", None));
    }
}
