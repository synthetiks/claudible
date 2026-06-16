# Architecture

Claudible is a thin, local cockpit around the **real Claude Code CLI**. It doesn't reimplement Claude Code — it embeds it and adds voice + a live meter.

## The pieces
- **Electron app (Windows)** — `main.js` (main process), `preload.js` (context-isolated bridge), `renderer/` (the UI: terminal + voice controls + meter).
- **Embedded terminal** — `node-pty` (ConPTY) spawns `wsl.exe -e bash -lc "<bootstrap>"`, rendered with **xterm.js**. You see and drive the real Claude Code TUI.
- **Bootstrap** — `wsl/session.sh` installs a statusLine + `Stop`/`UserPromptSubmit` hooks into a dedicated session dir (`~/.claudible/session`, kept out of your repos and global `~/.claude`), then `exec claude --continue` (resume) or fresh.
- **Voice services (WSL)** — `wsl/services.sh` keeps local **Whisper** (STT :2022) and **Kokoro** (TTS :8880) running; `setup/setup.sh` installs them.

## The three planes
1. **INPUT** — mic → main process → local Whisper → text → `pty.write()` into the live TUI. Hold **Right-Ctrl** (push-to-talk) or click **Talk**.
2. **OUTPUT** — Claude Code's `Stop` hook appends the reply to `runtime/hooks.ndjson` → the app reads it → local Kokoro speaks it.
3. **METER** — Claude Code's statusLine writes `runtime/status.json` → the app polls it → context % / cost / tokens.

## Why files for the bridge
`runtime/status.json` and `runtime/hooks.ndjson` live on the **Windows** filesystem so the Electron app reads them natively, avoiding the flaky `\\wsl.localhost` (9P) file-watch boundary. The app passes its **own folder** to `session.sh` (converted with `wslpath`), so there are **no hardcoded paths** — it works for any user and install location. The session `.jsonl` is buffered by Claude Code, which is why live output comes from hooks, not the transcript.

## Privacy
Speech-to-text and text-to-speech are **local** (localhost services). No cloud speech, no telemetry. The only things written to disk are ephemeral session state under `runtime/` (gitignored) and whatever you explicitly export with **Save Session**.

## Platform
Windows 11 + WSL2 today. The only OS coupling is the `wsl.exe` spawn, `wslpath`, ConPTY, and the PowerShell launchers. A macOS/Linux port would spawn `bash -lc` directly and skip `wslpath`; node-pty, xterm.js, the hooks/status bridge, and the OpenAI voice contract are already cross-platform.
