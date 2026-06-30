//! Repo intelligence for the drawer + input bar (Warp-absorption goal):
//! directory listing for the file explorer, runtime/stack detection with
//! real tool versions, and git changes / per-file diffs.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;

/// Run a subprocess with a hard timeout. Spawns the child, then polls
/// `try_wait` with short sleeps; on expiry the child is killed and `None`
/// is returned. Std-only (no `wait-timeout` dependency). Shared with procmon.
pub(crate) fn run_with_timeout(cmd: &mut Command, dur: Duration) -> Option<Output> {
    use std::process::Stdio;
    // Windows: GUI apps that spawn a console program flash a black console
    // window each time. CREATE_NO_WINDOW suppresses it — without this, the
    // procmon (netstat) and sessioninfo (git) pollers pop a window every few
    // seconds. Harmless no-op for console children that produce no UI.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + dur;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

// ── file explorer ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    is_dir: bool,
}

/// List a directory: folders first, then files, both alphabetical.
#[tauri::command(async)]
pub fn fs_list(path: String) -> Result<Vec<FsEntry>, String> {
    let mut entries: Vec<FsEntry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| FsEntry {
            name: e.file_name().to_string_lossy().to_string(),
            is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Read a text file for the in-app viewer (capped, binary-guarded).
/// A leading `~` expands to the user's home directory.
#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<String, String> {
    const CAP: u64 = 1024 * 1024; // 1 MiB is plenty for a side viewer
    let path = if let Some(rest) = path.strip_prefix('~') {
        let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map_err(|_| "홈 디렉토리를 찾을 수 없습니다".to_string())?;
        format!("{home}{rest}")
    } else {
        path
    };
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("디렉토리입니다".into());
    }
    if meta.len() > CAP {
        return Err(format!("파일이 너무 큽니다 ({} KB)", meta.len() / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err("바이너리 파일입니다".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `~` → home dir for the image commands below (mirrors read_text_file's).
fn expand_tilde(path: String) -> String {
    if let Some(rest) = path.strip_prefix('~') {
        if let Some(home) = home_dir() {
            return format!("{}{}", home.display(), rest);
        }
    }
    path
}

/// MIME for an image path, or None if the extension isn't a known image.
fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Read an image file and return it as a `data:` URL for inline display in the
/// viewer. Capped so a giant image can't blow up the webview; ~ is expanded.
#[tauri::command(async)]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    use base64::Engine;
    const CAP: u64 = 25 * 1024 * 1024;
    let path = expand_tilde(path);
    let mime = image_mime(&path).ok_or_else(|| "이미지 파일이 아닙니다".to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > CAP {
        return Err(format!(
            "이미지가 너무 큽니다 ({} MB)",
            meta.len() / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Persist a pasted (clipboard) image to a temp file and return its path, so it
/// can be inserted into the composer for an agent CLI to read. The image is
/// sent as base64 (far lighter over IPC than a JSON number array).
#[tauri::command(async)]
pub fn save_pasted_image(base64: String, ext: String) -> Result<String, String> {
    use base64::Engine;
    const CAP: usize = 25 * 1024 * 1024;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("base64 디코드 실패: {e}"))?;
    if bytes.is_empty() {
        return Err("빈 이미지입니다".into());
    }
    if bytes.len() > CAP {
        return Err("이미지가 너무 큽니다".into());
    }
    let ext = match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg".to_string(),
        "gif" => "gif".to_string(),
        "webp" => "webp".to_string(),
        "bmp" => "bmp".to_string(),
        _ => "png".to_string(),
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join("naru-pastes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("paste-{nanos}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Persist a large pasted text block to a temp `.txt` file and return its path,
/// so it can be attached to the composer (like a pasted image) instead of
/// dumping a huge blob inline — an agent CLI then reads the file.
#[tauri::command(async)]
pub fn save_pasted_text(text: String) -> Result<String, String> {
    const CAP: usize = 10 * 1024 * 1024;
    if text.is_empty() {
        return Err("빈 텍스트입니다".into());
    }
    if text.len() > CAP {
        return Err("텍스트가 너무 큽니다".into());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join("naru-pastes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("paste-{nanos}.txt"));
    std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Classify a path for the link context menu: "file" | "dir" | "missing".
/// `~` is expanded. Used to tailor the right-click menu's actions.
#[tauri::command(async)]
pub fn path_kind(path: String) -> String {
    let path = expand_tilde(path);
    match std::fs::metadata(&path) {
        Ok(m) if m.is_dir() => "dir".into(),
        Ok(_) => "file".into(),
        Err(_) => "missing".into(),
    }
}

/// Executable names on PATH (for command completion). Cached per app run.
#[tauri::command(async)]
pub fn list_path_commands() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut names = std::collections::BTreeSet::new();
            let path_var = std::env::var("PATH").unwrap_or_default();
            let split = if cfg!(windows) { ';' } else { ':' };
            for dir in path_var.split(split).filter(|d| !d.is_empty()) {
                let Ok(rd) = std::fs::read_dir(dir) else { continue };
                for e in rd.filter_map(|e| e.ok()) {
                    let name = e.file_name().to_string_lossy().to_string();
                    #[cfg(windows)]
                    {
                        let lower = name.to_lowercase();
                        for ext in [".exe", ".cmd", ".bat", ".ps1"] {
                            if let Some(stem) = lower.strip_suffix(ext) {
                                names.insert(stem.to_string());
                            }
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if e.metadata()
                            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                            .unwrap_or(false)
                        {
                            names.insert(name);
                        }
                    }
                }
            }
            names.into_iter().take(4000).collect()
        })
        .clone()
}

// ── agent CLI custom slash commands ─────────────────────────────────────────

#[derive(Serialize)]
pub struct AgentCommand {
    /// Command name WITHOUT the leading slash ("goal", "deploy-staging").
    name: String,
    /// One-line description (frontmatter `description:` or first content line).
    desc: String,
    /// project | user
    source: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok()
        .map(PathBuf::from)
}

/// Pull a short description out of a command/skill markdown file:
/// frontmatter `description:` first, else the first non-empty content line.
fn markdown_desc(path: &Path) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let mut lines = content.lines();
    let mut first_content = None::<String>;
    if content.starts_with("---") {
        lines.next(); // opening ---
        for line in lines.by_ref() {
            let t = line.trim();
            if t == "---" {
                break;
            }
            if let Some(v) = t.strip_prefix("description:") {
                let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
                if !v.is_empty() {
                    return truncate_chars(v, 100);
                }
            }
        }
    } else {
        lines = content.lines(); // no frontmatter — rescan from the top
    }
    for line in lines {
        let t = line.trim().trim_start_matches('#').trim();
        if !t.is_empty() {
            first_content = Some(t.to_string());
            break;
        }
    }
    truncate_chars(&first_content.unwrap_or_default(), 100)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// `dir/**/*.md` → one command per file, named by the file stem.
fn collect_command_files(dir: &Path, source: &str, out: &mut Vec<AgentCommand>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.is_dir() {
            collect_command_files(&p, source, out);
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")) {
            if let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().to_string()) {
                out.push(AgentCommand {
                    name: stem,
                    desc: markdown_desc(&p),
                    source: source.into(),
                });
            }
        }
    }
}

/// `dir/<skill>/SKILL.md` → one command per skill directory.
fn collect_skill_dirs(dir: &Path, source: &str, out: &mut Vec<AgentCommand>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let skill = e.path().join("SKILL.md");
        if skill.is_file() {
            out.push(AgentCommand {
                name: e.file_name().to_string_lossy().to_string(),
                desc: markdown_desc(&skill),
                source: source.into(),
            });
        }
    }
}

/// Custom slash commands that ACTUALLY exist on this machine for an agent CLI.
/// claude → project/user `.claude/commands/*.md` + `.claude/skills/*/SKILL.md`
/// codex  → `~/.codex/prompts/*.md`
/// opencode → project `.opencode/commands/*.md` + user `~/.config/opencode/commands/*.md`
/// Built-ins are a static list on the frontend; this fills in the rest.
#[tauri::command(async)]
pub fn agent_commands(brand: String, cwd: Option<String>) -> Vec<AgentCommand> {
    let mut out = Vec::new();
    match brand.as_str() {
        "claude" => {
            let mut roots: Vec<(PathBuf, &str)> = Vec::new();
            if let Some(c) = &cwd {
                roots.push((PathBuf::from(c).join(".claude"), "project"));
            }
            if let Some(h) = home_dir() {
                roots.push((h.join(".claude"), "user"));
            }
            for (root, src) in roots {
                collect_command_files(&root.join("commands"), src, &mut out);
                collect_skill_dirs(&root.join("skills"), src, &mut out);
            }
        }
        "codex" => {
            if let Some(h) = home_dir() {
                collect_command_files(&h.join(".codex").join("prompts"), "user", &mut out);
            }
        }
        "opencode" => {
            if let Some(c) = &cwd {
                collect_command_files(
                    &PathBuf::from(c).join(".opencode").join("commands"),
                    "project",
                    &mut out,
                );
            }
            if let Some(h) = home_dir() {
                collect_command_files(
                    &h.join(".config").join("opencode").join("commands"),
                    "user",
                    &mut out,
                );
            }
        }
        _ => {}
    }
    // Dedupe by name — project scope shadows user scope (scan order above).
    let mut seen = std::collections::HashSet::new();
    out.retain(|c| seen.insert(c.name.to_lowercase()));
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

// ── open the cwd in an external app ─────────────────────────────────────────

#[cfg(windows)]
fn spawn_hidden(program: &str, args: &[&str], cwd: Option<&str>) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = Command::new(program);
    c.args(args).creation_flags(CREATE_NO_WINDOW);
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    c.spawn().map(|_| ())
}

/// Open `cwd` in an external app: vscode | explorer | terminal | gitbash.
#[tauri::command(async)]
pub fn open_dir_in(app: String, cwd: String) -> Result<(), String> {
    if !Path::new(&cwd).is_dir() {
        return Err(format!("폴더가 없습니다: {cwd}"));
    }
    #[cfg(windows)]
    {
        match app.as_str() {
            // `code` is a .cmd shim — must go through cmd. The shim window is
            // suppressed; VS Code itself is a GUI app and shows normally.
            "vscode" => spawn_hidden("cmd", &["/C", "code", "."], Some(&cwd))
                .map_err(|_| "VS Code(code)를 찾을 수 없습니다".into()),
            "explorer" => Command::new("explorer")
                .arg(&cwd)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string()),
            // Windows Terminal first; plain cmd console as fallback.
            "terminal" => Command::new("wt")
                .args(["-d", &cwd])
                .spawn()
                .map(|_| ())
                .or_else(|_| {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
                    Command::new("cmd")
                        .creation_flags(CREATE_NEW_CONSOLE)
                        .current_dir(&cwd)
                        .spawn()
                        .map(|_| ())
                })
                .map_err(|e| e.to_string()),
            "gitbash" => {
                let candidates = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
                    .iter()
                    .filter_map(|v| std::env::var(v).ok())
                    .map(|p| PathBuf::from(p).join("Git").join("git-bash.exe"))
                    .chain(std::env::var("LOCALAPPDATA").ok().map(|p| {
                        PathBuf::from(p)
                            .join("Programs")
                            .join("Git")
                            .join("git-bash.exe")
                    }));
                for exe in candidates {
                    if exe.is_file() {
                        return Command::new(exe)
                            .arg(format!("--cd={cwd}"))
                            .spawn()
                            .map(|_| ())
                            .map_err(|e| e.to_string());
                    }
                }
                Err("Git Bash를 찾을 수 없습니다".into())
            }
            _ => Err(format!("unknown app: {app}")),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        match app.as_str() {
            "vscode" => c.args(["-a", "Visual Studio Code", &cwd]),
            "explorer" => c.arg(&cwd),
            // Git Bash is Windows-only; a setting synced from a Windows profile
            // can still carry it, so degrade to Terminal (the closest macOS
            // equivalent) instead of erroring.
            "terminal" | "gitbash" => c.args(["-a", "Terminal", &cwd]),
            _ => return Err(format!("unknown app: {app}")),
        };
        c.spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Err("지원하지 않는 플랫폼입니다".into())
    }
}

// ── runtime / stack detection ───────────────────────────────────────────────

#[derive(Serialize)]
pub struct RuntimeInfo {
    /// node | bun | deno | rust | python | go | dotnet
    kind: String,
    /// Tool version, e.g. "v22.11.0" (cached per app run).
    version: Option<String>,
}

#[derive(Serialize, Default)]
pub struct RepoInfo {
    /// Project name (package.json name / Cargo.toml name / folder name).
    name: Option<String>,
    runtimes: Vec<RuntimeInfo>,
}

/// Version lookups spawn real tools — cache them for the app's lifetime.
fn tool_version(tool: &str, args: &[&str]) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().get(tool) {
        return hit.clone();
    }
    let v = run_with_timeout(
        Command::new(tool).args(args),
        Duration::from_secs(3),
    )
    .and_then(|o| {
        if !o.status.success() {
            return None;
        }
        let txt = String::from_utf8_lossy(&o.stdout);
        let first = txt.lines().next()?.trim();
        // normalize: "rustc 1.83.0 (...)" -> "1.83.0", "v22.11.0" -> "22.11.0",
        // "go version go1.22.0 ..." -> "1.22.0". Pick the first whitespace token
        // containing a digit, then strip a leading "v" or "go" prefix.
        let token = first
            .split_whitespace()
            .find(|t| t.chars().any(|c| c.is_ascii_digit()))
            .unwrap_or(first);
        let token = token
            .strip_prefix("go")
            .or_else(|| token.strip_prefix('v'))
            .unwrap_or(token);
        Some(token.to_string())
    });
    cache.lock().insert(tool.to_string(), v.clone());
    v
}

fn json_field(path: &Path, field: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    // tiny extraction without a JSON dep: "field"\s*:\s*"value"
    let needle = format!("\"{field}\"");
    let at = text.find(&needle)?;
    let rest = &text[at + needle.len()..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    rest[1..].split('"').next().map(|s| s.to_string())
}

fn toml_name(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("name") {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                return Some(rest.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

#[tauri::command(async)]
pub fn repo_info(cwd: String) -> RepoInfo {
    let dir = PathBuf::from(&cwd);
    let mut info = RepoInfo::default();
    let has = |f: &str| dir.join(f).exists();

    if has("package.json") {
        info.name = json_field(&dir.join("package.json"), "name");
        // bun beats node when a bun lockfile exists
        if has("bun.lockb") || has("bun.lock") {
            info.runtimes.push(RuntimeInfo {
                kind: "bun".into(),
                version: tool_version("bun", &["--version"]),
            });
        } else {
            info.runtimes.push(RuntimeInfo {
                kind: "node".into(),
                version: tool_version("node", &["--version"]),
            });
        }
    }
    if has("deno.json") || has("deno.jsonc") {
        info.runtimes.push(RuntimeInfo {
            kind: "deno".into(),
            version: tool_version("deno", &["--version"]),
        });
    }
    if has("Cargo.toml") {
        if info.name.is_none() {
            info.name = toml_name(&dir.join("Cargo.toml"));
        }
        info.runtimes.push(RuntimeInfo {
            kind: "rust".into(),
            version: tool_version("rustc", &["--version"]),
        });
    }
    if has("go.mod") {
        info.runtimes.push(RuntimeInfo {
            kind: "go".into(),
            version: tool_version("go", &["version"]),
        });
    }
    if has("pyproject.toml") || has("requirements.txt") {
        info.runtimes.push(RuntimeInfo {
            kind: "python".into(),
            version: tool_version("python", &["--version"]),
        });
    }
    if info.name.is_none() {
        info.name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
    }
    info
}

// ── git changes / diff ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ChangedFile {
    path: String,
    /// M | A | D | R | U (untracked) — porcelain status condensed to one letter.
    status: String,
    added: i64,
    removed: i64,
}

#[derive(Serialize, Default)]
pub struct GitChanges {
    branch: Option<String>,
    files: Vec<ChangedFile>,
    /// git itself is not on PATH — distinct from "cwd is not a repo" so the
    /// UI doesn't claim "not a repository" inside a perfectly good repo.
    #[serde(rename = "gitMissing")]
    git_missing: bool,
}

/// Whether a `git` binary exists on PATH — probed once per app run.
fn git_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        run_with_timeout(
            Command::new("git").arg("--version"),
            Duration::from_secs(3),
        )
        .is_some_and(|out| out.status.success())
    })
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = run_with_timeout(
        Command::new("git").arg("-C").arg(cwd).args(args),
        Duration::from_secs(5),
    )?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn is_safe_relative_path(path: &str) -> bool {
    let p = Path::new(path);
    !p.is_absolute()
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

#[tauri::command(async)]
pub fn git_changes(cwd: String) -> GitChanges {
    if !git_available() {
        return GitChanges {
            git_missing: true,
            ..Default::default()
        };
    }
    let mut changes = GitChanges {
        branch: git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        ..Default::default()
    };

    // numstat for +/- per path (worktree vs HEAD)
    let mut stats: HashMap<String, (i64, i64)> = HashMap::new();
    if let Some(numstat) = git(&cwd, &["diff", "--numstat", "HEAD"]) {
        for line in numstat.lines() {
            let mut parts = line.split('\t');
            let a = parts.next().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            let r = parts.next().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            if let Some(p) = parts.next() {
                stats.insert(p.to_string(), (a, r));
            }
        }
    }

    if let Some(porcelain) = git(&cwd, &["status", "--porcelain"]) {
        for line in porcelain.lines() {
            if line.len() < 4 {
                continue;
            }
            let x = line.as_bytes()[0] as char;
            let y = line.as_bytes()[1] as char;
            let Some(rest) = line.get(3..) else {
                continue;
            };
            let path = rest.trim().trim_matches('"').to_string();
            // "R  old -> new": show the new path
            let path = path
                .rsplit(" -> ")
                .next()
                .unwrap_or(&path)
                .to_string();
            let status = if x == '?' || y == '?' {
                "U".to_string()
            } else if x == 'R' || y == 'R' {
                "R".to_string()
            } else if x == 'D' || y == 'D' {
                "D".to_string()
            } else if x == 'A' || y == 'A' {
                "A".to_string()
            } else {
                "M".to_string()
            };
            let (added, removed) = stats.get(&path).copied().unwrap_or((0, 0));
            changes.files.push(ChangedFile {
                path,
                status,
                added,
                removed,
            });
        }
    }
    changes
}

#[tauri::command(async)]
pub fn git_diff_file(cwd: String, path: String) -> String {
    if !is_safe_relative_path(&path) {
        return String::new();
    }
    // Tracked change first; untracked files fall back to a synthetic
    // all-added diff so the viewer still shows the content.
    if let Some(d) = git(&cwd, &["diff", "HEAD", "--", &path]) {
        if !d.trim().is_empty() {
            return d;
        }
    }
    if let Some(d) = git(&cwd, &["diff", "--cached", "--", &path]) {
        if !d.trim().is_empty() {
            return d;
        }
    }
    let full = PathBuf::from(&cwd).join(&path);
    match std::fs::read_to_string(&full) {
        Ok(content) => {
            let body: String = content.lines().map(|l| format!("+{l}\n")).collect();
            format!("+++ {path} (untracked)\n{body}")
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod agent_command_tests {
    use super::*;

    #[test]
    fn scans_project_commands_and_skills() {
        let tmp = std::env::temp_dir().join(format!("naru-agentcmd-{}", std::process::id()));
        let cmds = tmp.join(".claude").join("commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(
            cmds.join("deploy.md"),
            "---\ndescription: \"Deploy the app\"\n---\nLong body here.\n",
        )
        .unwrap();
        let skills = tmp.join(".claude").join("skills").join("ship");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("SKILL.md"), "# Ship\n\nShips it to prod.\n").unwrap();

        let out = agent_commands(
            "claude".into(),
            Some(tmp.to_string_lossy().to_string()),
        );
        assert!(
            out.iter()
                .any(|c| c.name == "deploy" && c.desc == "Deploy the app" && c.source == "project"),
            "command file missing: {:?}",
            out.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
        // no frontmatter -> first content line (heading text)
        assert!(out.iter().any(|c| c.name == "ship" && c.desc == "Ship"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn unknown_brand_is_empty() {
        assert!(agent_commands("shell".into(), None).is_empty());
    }

    #[test]
    fn git_diff_paths_must_stay_relative() {
        assert!(is_safe_relative_path("src/main.rs"));
        assert!(is_safe_relative_path("./src/main.rs"));
        assert!(!is_safe_relative_path("../secret.txt"));
        assert!(!is_safe_relative_path("src/../../secret.txt"));
        assert!(!is_safe_relative_path("/etc/passwd"));
        assert!(!is_safe_relative_path("C:\\Users\\secret.txt"));
    }
}
