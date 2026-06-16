# Claudible

**Talk to Claude Code. Hear it talk back.**

Claudible is a local, private, voice-control desktop cockpit that wraps the **real Claude Code CLI** in an embedded terminal. You speak — your words are typed into the live Claude Code session; Claude's replies are read back aloud. No cloud speech, no telemetry, nothing recorded.

> **Windows 11 + WSL2 only** (today). See [Platform support](#platform-support).

## Features
- 🎙️ **Push-to-talk** (hold **Right-Ctrl**) or click **Talk** → local Whisper transcribes → typed into the live Claude Code TUI
- 🔊 Claude's replies **spoken** via local Kokoro TTS (voice picker, "always speak" toggle)
- 🖥️ The **real Claude Code terminal**, embedded (xterm.js) — full TUI, scrollback, your own session
- 📊 Live session **meter** — context %, cost, tokens — with a **context guardrail** (the bar turns amber→red and becomes a one-tap `/compact`)
- 🧹 One-click **clear input** and **save session**
- 🔒 **Fully local** — speech never leaves your machine

## Prerequisites
- **Windows 11 + WSL2** (Ubuntu)
- **Claude Code CLI** installed inside WSL (`claude` on your PATH)
- **Node.js 20+** on Windows
- Inside WSL: `ffmpeg`, `python3`, [`uv`](https://docs.astral.sh/uv/) (the voice setup checks for these)

## Install & run
```powershell
git clone https://github.com/<you>/claudible
cd claudible
npm install        # installs deps + reapplies the small node-pty fix (patch-package)
npm run setup      # installs the local voice services in WSL (first run pulls a ~150 MB model)
npm start          # opens the cockpit
```
Optional Desktop shortcut: `powershell -ExecutionPolicy Bypass -File launch\make-shortcut.ps1`

Full steps + troubleshooting: **[SETUP.md](SETUP.md)**.

## Configuration
| Env var | Default | Meaning |
|---|---|---|
| `CV2_WHISPER` | `http://localhost:2022` | STT endpoint — any OpenAI `/v1/audio/transcriptions` |
| `CV2_KOKORO` | `http://localhost:8880` | TTS endpoint — any OpenAI `/v1/audio/speech` |
| `CLAUDIBLE_VOICE` | `~/.claudible/voice` | where the local voice services are installed |

Claudible speaks the **OpenAI audio API**, so you can point it at any compatible STT/TTS (LM Studio, your own server) instead of the bundled local ones.

## Platform support
Windows 11 + WSL2 today — it spawns `wsl.exe` and embeds Claude Code running in Linux. macOS/Linux is a clean future port (spawn `bash -lc` directly, skip `wslpath`); everything else is already cross-platform. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License
[MIT](LICENSE).
