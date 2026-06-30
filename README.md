# NARU

**An AI-agent control-tower terminal workspace.** NARU is a desktop terminal
multiplexer built for driving and watching multiple AI coding agents
(Claude Code, Codex, opencode) at once — it owns the *semantics* of the
terminal (sessions, command blocks, status) so it can surface what a bare CLI
can't: live per-session state, attention rings, and rich inline widgets.

Built with **Tauri 2 (Rust)** for a native PTY and a small footprint, a
**React 19 + shadcn/ui** chrome for fully customizable UI, and **xterm.js +
WebGL** for GPU-accelerated grid rendering.

> Takes cues from Warp (command blocks, palette), tmux (session persistence),
> cmux (vertical-tab sidebar, notify ring), Wave (widget blocks), and
> purplemux (UI-palette ⟂ terminal-palette theming).

---

## Features

- **AI-agent control tower** — launch `claude` / `codex` / `opencode` per
  session; the sidebar shows each session's branch, cwd, and live status, and a
  notify ring lights up panes that need attention.
- **Persistent sessions** — PTYs live in the Rust backend; views can come and go
  without killing the shell.
- **Warp-style command composer** — a command bar with history, fish-style ghost
  suggestions, path/command completion, agent slash-command menus, plan/quota
  chips, and resume-last-session.
- **Rich inline attachments** — paste or drag-and-drop an image into the composer
  to attach it as a thumbnail; long pastes become file chips.
- **Git drawer & file explorer** — working-tree diff, branch info, and an
  in-app file tree, plus an "open current folder in…" split button (Finder /
  VS Code / Terminal).
- **Control-tower extras** — triggers, global search, command palette,
  desktop notifications, and a localhost orchestrator API for spawning sessions.
- **Theming** — independent UI and terminal palettes, custom fonts (Hangul
  rendered at correct cell width), light/dark.
- **Self-update** — signed builds with an in-app updater (no token required).

> The UI is currently Korean.

## Platforms

macOS (Apple Silicon; Intel via cross-build) and Windows. Builds are
code-signed and the in-app updater pulls new releases from GitHub Releases.

## Getting started

Prerequisites: [Rust](https://rustup.rs), [Node.js](https://nodejs.org) ≥ 20.19,
and the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev      # run the app in dev
npm run tauri build    # produce a release bundle
npm run check          # type-check + build + clippy (-D warnings)
```

## Tech stack

| Layer | Tech |
|---|---|
| Desktop shell | Tauri 2 (Rust backend, native PTY) |
| UI | React 19, shadcn/ui, Radix, Tailwind, Zustand |
| Terminal | xterm.js + WebGL addon |
| Build | Vite, TypeScript |

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds and signs
the Windows + macOS bundles and publishes them — along with the `latest.json`
the in-app updater reads — to a single GitHub Release. Updater artifacts are
signed with a minisign key; macOS bundles are code-signed with a self-signed
identity so per-app permissions (Full Disk Access, Keychain, notifications)
persist across updates.
