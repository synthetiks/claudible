<p align="center">
  <img src="assets/logo.png" alt="Claudible logo" width="200">
</p>

<h1 align="center">Claudible</h1>

<p align="center"><b>A command center for Claude Code: a sleek interface, live telemetry, and hands-free voice, all in one.</b></p>

---

Claude Code is brilliant, but it lives in a bare terminal. **Claudible wraps it in a real interface:** an obsidian-dark UI with one-click controls, a live meter for context, cost, and tokens, and a guardrail that turns from amber to red and offers a one-tap `/compact` before you run out of room. The actual Claude Code TUI runs inside untouched, so you keep everything it does and gain a face, a dashboard, and a voice.

When you want to go hands-free, **full voice control** is built in. Hold a key, speak, and your words drop straight into the live session, with replies read back in a natural voice. It's not a reskin, it's a control surface. The voice layer is **fully local** — speech-to-text and text-to-speech run on your machine, and Claudible adds no telemetry of its own. (The embedded Claude Code talks to Anthropic exactly as it always does; see [Security & privacy](#security--privacy).)

> **Windows 11 + WSL2** · fully local · MIT

## Features
- 🖥️ **The real Claude Code, embedded** — the actual TUI (xterm.js) with full scrollback, dressed in a sleek obsidian-dark UI. Your session, untouched.
- 📊 **Live telemetry** — context %, cost, and tokens at a glance, with a **context guardrail** that turns amber → red and offers a one-tap `/compact` before you run out of room.
- 🎛️ **One-click controls** — clear the input, save the session, and fire `/effort`, `/compact`, `/status` & friends from buttons — no commands to memorize.
- 🎙️ **Hands-free voice in** — push-to-talk (hold **Left-Ctrl**) or click **Talk**; your speech is transcribed locally and typed straight into the live session.
- 🔊 **Spoken replies** — Claude's answers read back in a natural voice (voice picker + "always speak" toggle).
- 🔒 **Local voice** — Whisper + Kokoro run on your machine; Claudible adds no telemetry. (Claude Code itself still talks to Anthropic — that's how it works.)

## Prerequisites
- **Windows 11 + WSL2** (Ubuntu, or any Debian-family default distro)
- **Claude Code CLI** installed inside WSL (`claude` on your PATH)
- **Node.js 22.12+** on Windows (Electron 42 requires it)
- Inside WSL, for the voice setup: `git`, `cmake`, `build-essential`, `ffmpeg`, `python3`, and [`uv`](https://docs.astral.sh/uv/) — `npm run setup` checks for these and prints the exact apt line if any are missing

## Install & run
```powershell
git clone https://github.com/thecrazydev1/claudible
cd claudible
npm install        # installs deps + reapplies the small node-pty fix (patch-package)
npm run setup      # installs the local voice services in WSL (first run downloads ~150 MB Whisper + ~327 MB Kokoro models)
npm start          # opens the cockpit (and brings the voice services up if they aren't already)
```
Optional Desktop shortcut: `powershell -ExecutionPolicy Bypass -File launch\make-shortcut.ps1`

Full steps + troubleshooting: **[SETUP.md](SETUP.md)**.

## Configuration
| Env var | Default | Meaning |
|---|---|---|
| `CLAUDIBLE_WHISPER` | `http://localhost:2022` | STT endpoint — any OpenAI `/v1/audio/transcriptions` |
| `CLAUDIBLE_KOKORO` | `http://localhost:8880` | TTS endpoint — any OpenAI `/v1/audio/speech` |
| `CLAUDIBLE_VOICE` | `~/.claudible/voice` | where the local voice services are installed |
| `CLAUDIBLE_WHISPER_PORT` | `2022` | port `services.sh` binds Whisper on |
| `CLAUDIBLE_KOKORO_PORT` | `8880` | port `services.sh` binds Kokoro on |

Claudible speaks the **OpenAI audio API**, so you can point it at any compatible STT/TTS (LM Studio, your own server) instead of the bundled local ones. If you change a port, set the matching `CLAUDIBLE_WHISPER` / `CLAUDIBLE_KOKORO` URL too so the app and the services agree.

## Security & privacy
- **The embedded Claude runs with `--dangerously-skip-permissions` and `--add-dir $HOME`.** This is deliberate — Claudible is a personal, local cockpit and that keeps the voice/one-click flow frictionless — but it means the embedded Claude Code can read and act across your home directory without per-action prompts. Run it on a machine you trust, the same way you'd run `claude` yourself with permissions skipped. To change it, edit the `exec claude …` lines in `wsl/session.sh`.
- **Voice is local; Claude Code is not.** Speech-to-text (Whisper) and text-to-speech (Kokoro) run entirely on your machine, and Claudible sends no telemetry. The embedded **Claude Code** sends your prompts and code to Anthropic exactly as the normal CLI does — Claudible doesn't change that.
- **The voice services bind `0.0.0.0`** so the Windows app can reach them across the WSL2 NIC. On WSL2's default NAT networking they aren't exposed to your LAN; if you enable WSL2 *mirrored* networking they become reachable from the host's interfaces, so don't run mirrored networking on an untrusted network.

## Platform support
Windows 11 + WSL2 today — it spawns `wsl.exe` and embeds Claude Code running in Linux. macOS/Linux is a clean future port (spawn `bash -lc` directly, skip `wslpath`); everything else is already cross-platform. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License
[MIT](LICENSE).

---

*Built by the_crazydev with Claude.*
