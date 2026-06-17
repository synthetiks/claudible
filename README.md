<p align="center">
  <img src="assets/logo.png" alt="Claudible logo" width="200">
</p>

<h1 align="center">Claudible</h1>

<p align="center"><b>The cockpit for Claude Code: an interface you can actually talk to — and invite someone into.</b></p>
<p align="center"><i>Claude Code with a face, a voice, and a co-worker.</i></p>

<p align="center">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-6aa9ff">
  <img alt="platform Windows 11 + WSL2" src="https://img.shields.io/badge/platform-Windows%2011%20%2B%20WSL2-7c5cff">
  <img alt="voice 100%25 local" src="https://img.shields.io/badge/voice-100%25%20local-5fb487">
  <img alt="status private beta" src="https://img.shields.io/badge/status-private%20beta-e0a93b">
</p>

---

**Claudible is a desktop GUI for Claude Code** — it wraps your real Claude Code session in a sleek interface with live telemetry, fully-local push-to-talk voice (talk to it *and* hear it back), and live session sharing so a teammate can pair with you.

Claude Code is brilliant, but it lives in a bare terminal. Claudible gives it three things a terminal can't: a **face**, a **voice**, and a **co-worker**.

**A face.** An obsidian-dark UI with one-click controls, a live meter for context, cost, and tokens, and a guardrail that turns from amber to red and offers a one-tap `/compact` before you run out of room. The actual Claude Code TUI runs inside untouched (real xterm.js, full scrollback), so you keep everything it does and gain a face and a dashboard.

**A voice — fully local.** Hold a key, speak, and your words drop straight into the live session, with replies read back in a natural voice. Speech-to-text *and* text-to-speech run on your own machine (Whisper + Kokoro): no Claude.ai voice sign-in, no cloud transcription, no telemetry from Claudible. It's two-way — you talk and you *hear back* — not just dictation. (The embedded Claude Code talks to Anthropic exactly as it always does; see [Security & privacy](#security--privacy).)

**A co-worker.** Share your running session over a private invite link and someone joins it live in their browser — on a laptop or a phone. You approve every guest by name, choose **read-only** (they watch and chat) or **interactive** (they type into the same session), and there's a human↔human chat side-channel alongside the terminal. It's a local WebSocket server wrapped in a free Cloudflare quick-tunnel (with [`cloudflared`](https://github.com/cloudflare/cloudflared) installed; otherwise the link stays localhost/LAN) — nothing of yours is hosted by us, the tunnel just connects *out* from your machine.

> **Windows 11 + WSL2** · voice is fully local · MIT

## Features
- 🖥️ **The real Claude Code, embedded** — the actual TUI (xterm.js) with full scrollback, dressed in a sleek obsidian-dark UI. Your session, untouched.
- 📊 **Live telemetry** — context %, cost, and tokens at a glance, with a **context guardrail** (amber → red) and a one-tap `/compact`.
- 🎛️ **One-click controls** — clear the input, save the session, and fire `/effort`, `/compact`, `/status` & friends from buttons — no commands to memorize.
- 🎙️ **Push-to-talk voice in** — hold **Left-Alt** (rebindable) or click **Talk**; your speech is transcribed locally and typed straight into the live session.
- 🔊 **Spoken replies** — Claude's answers read back in a natural voice (voice picker + "always speak" toggle).
- 🔒 **Local voice** — Whisper + Kokoro run on your machine; Claudible adds no telemetry, and voice needs no Claude.ai sign-in.
- 🤝 **Live session sharing / co-work** — *pair-program* by inviting someone into your running session over a private, approval-gated link. The host approves each guest by name, **read-only or interactive**, up to 8 at once, with a human↔human chat side-channel and a mobile-friendly browser viewer. Local server + a free [`cloudflared`](https://github.com/cloudflare/cloudflared) quick-tunnel for cross-network reach (install it for remote; without it the link is localhost/LAN).

## Prerequisites
- **Windows 11 + WSL2** (Ubuntu, or any Debian-family default distro)
- **Claude Code CLI** installed **and signed in** inside WSL (`claude` on your PATH; run `claude` once and complete login first — Claudible embeds your already-authenticated session)
- **Node.js 22.12+** on Windows (Electron 42 requires it)
- Inside WSL, for the voice setup: `git`, `cmake`, `build-essential`, `ffmpeg`, `python3`, and [`uv`](https://docs.astral.sh/uv/) — `npm run setup` checks for these and prints the exact apt line if any are missing
- **Optional, for remote co-work:** [`cloudflared`](https://github.com/cloudflare/cloudflared) on Windows (`winget install Cloudflare.cloudflared`, or point `CLAUDIBLE_CLOUDFLARED` at the binary). Without it, **Share** still works but the invite link is **localhost/LAN-only**.

## Install & run
**Run in Windows PowerShell, not inside WSL.** (Claudible's app is a *Windows* Electron app that embeds Claude Code running in WSL; running it from inside WSL installs the Linux Electron and dies on `libnspr4.so`.) During beta the repo is **private — you must be added as a collaborator first**, and you need **WSL2** + a **signed-in Claude Code** inside it (see [Prerequisites](#prerequisites)).

**One line** — clones, installs everything, and launches:
```powershell
git clone https://github.com/thecrazydev1/claudible "$HOME\claudible"; powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\claudible\install.ps1"
```
`install.ps1` checks Windows Node (offers to install it via winget), runs `npm install`, builds the local voice services in WSL — installing their Linux deps for you (it may ask for your WSL sudo password) — then makes a Desktop shortcut and launches. **First run only:** the voice build compiles whisper.cpp and downloads ~480 MB of models, so it can churn for 10–20 min; if it's interrupted, just run the line again — it resumes.

<details><summary>Prefer to run the steps by hand?</summary>

```powershell
git clone https://github.com/thecrazydev1/claudible
cd claudible
npm install        # deps + the small node-pty patch
npm run setup      # builds the WSL voice services (installs their deps; ~480 MB models on first run)
npm start          # opens the cockpit
```
Optional Desktop shortcut: `powershell -NoProfile -ExecutionPolicy Bypass -File launch\make-shortcut.ps1`
</details>

Full steps + troubleshooting: **[SETUP.md](SETUP.md)**.

## Configuration
| Env var | Default | Meaning |
|---|---|---|
| `CLAUDIBLE_WHISPER` | `http://localhost:2022` | STT endpoint — any OpenAI `/v1/audio/transcriptions` |
| `CLAUDIBLE_KOKORO` | `http://localhost:8880` | TTS endpoint — any OpenAI `/v1/audio/speech` |
| `CLAUDIBLE_VOICE` | `~/.claudible/voice` | where the local voice services are installed |
| `CLAUDIBLE_CLOUDFLARED` | _(auto-detect)_ | path to a `cloudflared` binary for cross-network co-work tunnels |
| `CLAUDIBLE_WHISPER_PORT` | `2022` | port `services.sh` binds Whisper on |
| `CLAUDIBLE_KOKORO_PORT` | `8880` | port `services.sh` binds Kokoro on |

Claudible speaks the **OpenAI audio API**, so you can point it at any compatible STT/TTS (LM Studio, your own server) instead of the bundled local ones. If you change a port, set the matching `CLAUDIBLE_WHISPER` / `CLAUDIBLE_KOKORO` URL too so the app and the services agree.

## Live session sharing & pair programming
Click **Share** to live-share your *running* Claude Code session: Claudible spins up a local viewer and hands you a private invite link. With [`cloudflared`](https://github.com/cloudflare/cloudflared) installed it's a free `https://<random>.trycloudflare.com` quick-tunnel a colleague on another network can reach; without it the link is **localhost/LAN-only**. The link is **reusable and approval-gated**: several people can open it (up to 8), and each one waits in a lobby until you approve them by name. Pick the mode when you share:

- **Read-only** — guests watch the live terminal and can chat, but can't type.
- **Interactive** — guests type into the *same* Claude Code session you're driving.

There's a **human↔human chat** alongside the terminal, names for the host and each guest, and a **mobile-friendly** browser viewer (the cockpit's custom scroll gutter included) so someone can follow along from a phone. Rotate the invite anytime without dropping current guests. Nothing is hosted by us — the tunnel connects *out* from your machine; see [Security & privacy](#security--privacy) for what that exposes.

## Security & privacy
- **The embedded Claude runs with `--dangerously-skip-permissions` and `--add-dir $HOME`.** This is deliberate — Claudible is a personal, local cockpit and that keeps the voice/one-click flow frictionless — but it means the embedded Claude Code can read and act across your home directory without per-action prompts. Run it on a machine you trust, the same way you'd run `claude` yourself with permissions skipped. To change it, edit the `exec claude …` lines in `wsl/session.sh`.
- **Voice is local; Claude Code is not.** Speech-to-text (Whisper) and text-to-speech (Kokoro) run entirely on your machine, and Claudible sends no telemetry. The embedded **Claude Code** sends your prompts and code to Anthropic exactly as the normal CLI does — Claudible doesn't change that.
- **The voice services bind `0.0.0.0`** so the Windows app can reach them across the WSL2 NIC. On WSL2's default NAT networking they aren't exposed to your LAN; if you enable WSL2 *mirrored* networking they become reachable from the host's interfaces, so don't run mirrored networking on an untrusted network.
- **Live co-work is off until you click Share, and exposes your session for as long as it's on.** The quick-tunnel URL is public-but-unguessable; anyone with the link reaches the lobby, but **no one sees or touches your terminal until you approve them**, and **interactive** access lets an approved guest type into a Claude Code session that runs with skipped permissions — so only share interactive with people you trust, prefer read-only otherwise, and stop sharing (or rotate the link) when you're done.

## Platform support
Windows 11 + WSL2 today — it spawns `wsl.exe` and embeds Claude Code running in Linux. macOS/Linux is a clean future port (spawn `bash -lc` directly, skip `wslpath`); everything else is already cross-platform. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License
[MIT](LICENSE).

---

*Built by the_crazydev with Claude.*
