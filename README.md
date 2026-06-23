<p align="center">
  <img src="assets/logo.png" alt="Claudible logo" width="200">
</p>

<h1 align="center">Claudible</h1>

<p align="center"><b>Multiplayer Claude Code — the collaboration cockpit.</b></p>
<p align="center"><i>Invite anyone into your live Claude Code session to watch, talk, and build together — with fully-local voice, live telemetry, and a real-time agents view baked in.</i></p>

<p align="center">
  <img alt="multiplayer co-work" src="https://img.shields.io/badge/multiplayer-co--work-e08cc0">
  <img alt="voice 100%25 local" src="https://img.shields.io/badge/voice-100%25%20local-5fb487">
  <img alt="platform Windows 11 + WSL2" src="https://img.shields.io/badge/platform-Windows%2011%20%2B%20WSL2-7c5cff">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-6aa9ff">
  <img alt="status private beta" src="https://img.shields.io/badge/status-private%20beta-e0a93b">
</p>

---

## Claude Code is single-player. Claudible makes it multiplayer — and wraps it in a cockpit.

Claude Code is brilliant, but it's **one person, one terminal, one agent.** Claudible turns your *running* session into a **room your team can join:** drop a private, approval-gated link in Slack, a teammate opens it in their browser — laptop or phone — and they're *inside your live session.* They watch, they chat, or they **take the keyboard** and co-drive the same Claude. Pair-program with AI *and* humans, build a repo together, onboard someone by handing them the wheel, debug in real time.

And around that, Claudible is a **Swiss-army knife for Claude Code** — everything you wish the terminal had, in one place: fully-local **two-way voice** (talk to it, hear it back), **live context/cost/token telemetry** with a `/compact` guardrail, a **live agents cockpit** (watch your subagents and workflow swarms work — tools, tokens, results), and **one-click** slash-commands. All wrapping the *real* Claude Code TUI, untouched (xterm.js, full scrollback).

> **Windows 11 + WSL2** · voice is fully local · MIT

## 🤝 Multiplayer — your session, shared
Click **Share** and Claudible hands you a private invite link to your *live* session. It's **reusable and approval-gated** — up to 8 people can open it, each waiting in a lobby until you approve them by name. Pick the mode per share:
- **Read-only** — guests watch the live terminal and chat, but can't type.
- **Interactive** — guests type into the *same* Claude Code session you're driving.

There's a **human↔human chat** alongside the terminal, a **voice room**, names for everyone, and a **mobile-friendly** browser viewer so someone can follow from a phone. With [`cloudflared`](https://github.com/cloudflare/cloudflared) it's a free `https://…trycloudflare.com` tunnel a colleague on any network can reach (without it, localhost/LAN). Nothing is hosted by us — the tunnel connects *out* from your machine. → [details + security](#live-session-sharing--pair-programming)

## 🧰 The cockpit — a Swiss-army knife for Claude Code
- 🖥️ **The real Claude Code, embedded** — the actual TUI (xterm.js, full scrollback) in a sleek obsidian-dark UI. Your session, untouched.
- 🎙️ **Two-way local voice** — hold a key and talk; hear replies read back. Whisper + Kokoro run **on your machine** — no cloud, no Claude.ai voice sign-in, no telemetry from Claudible. (The embedded Claude Code talks to Anthropic exactly as the normal CLI does.)
- 📊 **Live telemetry** — context %, cost, and tokens at a glance, with a guardrail (amber → red) and a one-tap `/compact` before you run out of room.
- 🛰️ **Live agents cockpit** — watch your subagents and workflow swarms work in real time: their task, tool-by-tool activity, token burn, and final results.
- 🎛️ **One-click controls** — fire `/effort`, `/compact`, `/status` & friends from buttons; no commands to memorize.
- 🗂️ **Workspaces + session sync** — organize sessions per repo, and (with `gh`) keep shared sessions in sync with collaborators.

## Prerequisites
- **Windows 11 + WSL2** (Ubuntu, or any Debian-family default distro)
- **Claude Code CLI** installed **and signed in** inside WSL (`claude` on your PATH; run `claude` once and complete login first — Claudible embeds your already-authenticated session)
- **Git for Windows** — to clone the repo. The one-line installer below **auto-installs it via winget** if you don't have it; otherwise grab it from [git-scm.com](https://git-scm.com/download/win).
- **Node.js 22.12+** on Windows (Electron 42 requires it)
- **Visual Studio Build Tools** with the **"Desktop development with C++"** workload — the installer rebuilds the native `node-pty` module for Electron, which needs a C++ compiler. Quick install: `winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`
- Inside WSL, for the voice setup: `git`, `cmake`, `build-essential`, `ffmpeg`, `espeak-ng`, `python3`, and [`uv`](https://docs.astral.sh/uv/) — `npm run setup` checks for these and prints the exact apt line if any are missing
- **Optional, for remote co-work:** [`cloudflared`](https://github.com/cloudflare/cloudflared) on Windows (`winget install Cloudflare.cloudflared`, or point `CLAUDIBLE_CLOUDFLARED` at the binary). Without it, **Share** still works but the invite link is **localhost/LAN-only**.
- **Optional, for private-repo workspaces + session sync:** the GitHub CLI [`gh`](https://cli.github.com/) installed and signed in **inside WSL** (`gh auth login`).

## Install & run
**Run in Windows PowerShell, not inside WSL.** (Claudible's app is a *Windows* Electron app that embeds Claude Code running in WSL; running it from inside WSL installs the Linux Electron and dies on `libnspr4.so`.) During beta the repo is **private — you must be added as a collaborator first**, and you need **WSL2** + a **signed-in Claude Code** inside it (see [Prerequisites](#prerequisites)).

**One line** — asks where to install (Enter for the default), installs git if you don't have it, clones, installs everything, and launches:
```powershell
$dir = (Read-Host "Install folder for Claudible (Enter for default) [$HOME\claudible]").Trim().Trim('"'); if (-not $dir) { $dir = "$HOME\claudible" }; if (!(Get-Command git -ErrorAction SilentlyContinue)) { winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements; $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); if (Test-Path "$env:ProgramFiles\Git\cmd\git.exe") { $env:Path = "$env:ProgramFiles\Git\cmd;$env:Path" } }; git clone https://github.com/thecrazydev1/claudible "$dir"; if (Test-Path "$dir\install.ps1") { powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install.ps1" } else { Write-Host "`n[!] install.ps1 is missing after clone -- your antivirus most likely quarantined it (a false positive). To fix: allow/exclude the folder `"$dir`" in your antivirus, then run these two lines:`n    git -C `"$dir`" restore install.ps1`n    powershell -NoProfile -ExecutionPolicy Bypass -File `"$dir\install.ps1`"`nPer-antivirus steps are in `"$dir\SETUP.md`" (the Antivirus section)." -ForegroundColor Yellow }
```
It **prompts for an install folder** (press Enter for the default `…\claudible`, or paste any path), **auto-installs Git for Windows** via winget if it's missing, clones, then `install.ps1` checks Windows Node (offers to install it via winget), runs `npm install`, builds the local voice services in WSL — installing their Linux deps for you (it may ask for your WSL sudo password) — then makes a Desktop shortcut and launches. **First run only:** the voice build compiles whisper.cpp and downloads ~480 MB of models, so it can churn for 10–20 min; if it's interrupted, just run the line again — it resumes.

> **No `winget`?** (older Windows) Install Git from **[git-scm.com/download/win](https://git-scm.com/download/win)** with the defaults, **reopen PowerShell**, then run the line above.

<details><summary>Prefer to run the steps by hand?</summary>

```powershell
git clone https://github.com/thecrazydev1/claudible
cd claudible
npm install        # deps + the small node-pty patch
npm run rebuild    # rebuild node-pty for Electron's ABI (needs VS Build Tools / Desktop C++)
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
