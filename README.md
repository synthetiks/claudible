<p align="center">
  <img src="assets/logo.png" alt="Claudible logo" width="200">
</p>

<h1 align="center">Claudible</h1>

<p align="center"><b>The ultimate command center for Claude Code — a sleek interface, live telemetry, and hands-free voice, in one.</b></p>

---

Claude Code is brilliant — but it lives in a bare terminal. **Claudible wraps it in a real interface** — an obsidian-dark UI with one-click controls, a live meter for context, cost, and tokens, and a guardrail that flips amber → red with a one-tap `/compact` before you blow the window. The actual Claude Code TUI runs inside, untouched — Claudible gives it a face, a dashboard, and a voice.

And when you want to go hands-free, **full voice control** is built in: hold a key, speak, and your words drop into the live session; replies are read back in a natural voice. **Not a reskin — a control surface.** And it's **100% local**: no cloud, no telemetry, nothing recorded.

> **Windows 11 + WSL2** · fully local · MIT

## Features
- 🖥️ **The real Claude Code, embedded** — the actual TUI (xterm.js) with full scrollback, dressed in a sleek obsidian-dark UI. Your session, untouched.
- 📊 **Live telemetry** — context %, cost, and tokens at a glance, with a **context guardrail** that turns amber → red and offers a one-tap `/compact` before you run out of room.
- 🎛️ **One-click controls** — clear the input, save the session, and fire `/effort`, `/compact`, `/status` & friends from buttons — no commands to memorize.
- 🎙️ **Hands-free voice in** — push-to-talk (hold **Right-Ctrl**) or click **Talk**; your speech is transcribed locally and typed straight into the live session.
- 🔊 **Spoken replies** — Claude's answers read back in a natural voice (voice picker + "always speak" toggle).
- 🔒 **100% local** — Whisper + Kokoro run on your machine. No cloud, no telemetry, nothing recorded.

## Prerequisites
- **Windows 11 + WSL2** (Ubuntu)
- **Claude Code CLI** installed inside WSL (`claude` on your PATH)
- **Node.js 20+** on Windows
- Inside WSL: `ffmpeg`, `python3`, [`uv`](https://docs.astral.sh/uv/) (the voice setup checks for these)

## Install & run
```powershell
git clone https://github.com/thecrazydev1/claudible
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

---

*Built by the_crazydev with Claude.*
