<p align="center">
  <img src="assets/logo.png" alt="Claudible logo" width="200">
</p>

<h1 align="center">Claudible</h1>

<p align="center"><b>Multiplayer Claude Code — the collaboration cockpit.</b></p>
<p align="center"><i>Invite anyone into your live Claude Code session to watch, talk, and build together — with fully-local voice, live telemetry, and a real-time agents view baked in.</i></p>

<p align="center">
  <img alt="multiplayer co-work" src="https://img.shields.io/badge/multiplayer-co--work-e08cc0">
  <img alt="voice 100%25 local" src="https://img.shields.io/badge/voice-100%25%20local-5fb487">
  <img alt="platform Windows, Linux, macOS" src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux%20%C2%B7%20macOS-7c5cff">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-6aa9ff">
  <img alt="status public beta" src="https://img.shields.io/badge/status-public%20beta-e0a93b">
</p>

---

## Claude Code is single-player. Claudible makes it multiplayer — and wraps it in a cockpit.

Claude Code is one person, one terminal, one agent. Claudible turns your *running* session into a room your team can join: drop a private, approval-gated link in Slack, a teammate opens it in their browser — laptop or phone — and they're inside your live session. They can watch, chat, or take the keyboard and co-drive the same Claude: pair-program, onboard someone by handing them the wheel, debug together in real time.

Around that session sits the cockpit: fully-local **two-way voice** (talk to it, hear it back), **live context/cost/token telemetry** with a `/compact` guardrail, a **live agents cockpit** (watch subagents and workflow swarms work — tools, tokens, results), and **one-click** slash-commands. All wrapping the real Claude Code TUI, untouched (xterm.js, full scrollback).

## 🤝 Multiplayer — your session, shared
Click **Share** and Claudible hands you a private invite link to your *live* session — reusable, approval-gated (each guest waits in a lobby until you approve them by name, up to 8), and **read-only** (watch + chat) or **interactive** (type into the same session) per share. Guests get a chat, a voice room, and a mobile-friendly viewer; with [`cloudflared`](https://github.com/cloudflare/cloudflared) the link is a free `https://…trycloudflare.com` tunnel that works across networks (without it, localhost/LAN). Nothing is hosted by us — the tunnel connects *out* from your machine. → [details + security](#live-session-sharing--pair-programming)

## 🧰 The cockpit — a Swiss-army knife for Claude Code
- 🖥️ **The real Claude Code, embedded** — the actual TUI (xterm.js, full scrollback) in an obsidian-dark UI. Your session, untouched.
- 🎙️ **Two-way local voice** — hold a key and talk; hear replies read back. Whisper + Kokoro run **on your machine** — no cloud, no Claude.ai voice sign-in, no telemetry from Claudible. (The embedded Claude Code talks to Anthropic exactly as the normal CLI does.)
- 📊 **Live telemetry** — context %, cost, and tokens at a glance, with a guardrail (amber → red) and a one-tap `/compact` before you run out of room.
- 🛰️ **Live agents cockpit** — watch your subagents and workflow swarms work in real time: their task, tool-by-tool activity, token burn, **which model runs each agent**, and final results.
- 🎛️ **One-click controls** — fire `/effort`, `/compact`, `/status` & friends from buttons; no commands to memorize.
- 🕘 **Session history + one-click Revert** — a per-prompt activity feed (who ran what, when, and what changed: "3 files (+42/−10)"), with a git-backed snapshot per turn so you can roll the code back to any of the last 10 prompts — and undo the revert. Live guests see the feed too.
- 🗂️ **Projects + session sync** — organize sessions per repo, and (with `gh`) keep shared sessions in sync with collaborators.

## Prerequisites
*(These cover the **Windows + WSL2** path — the recommended default. The native Windows, Linux, and macOS
sections under [Install & run](#install--run) list their own, lighter requirements.)*
- **Windows 11 + WSL2** (Ubuntu, or any Debian-family default distro)
- **Claude Code CLI** installed **and signed in** inside WSL (`claude` on your PATH; run `claude` once and complete login first — Claudible embeds your already-authenticated session)
- **Git for Windows** — to clone the repo. The one-line installer below **auto-installs it via winget** if you don't have it; otherwise grab it from [git-scm.com](https://git-scm.com/download/win).
- **Node.js 22.12+** on Windows (Electron 42 requires it) — and that's the *only* Windows-side tooling: **no compiler, no Python, no Visual Studio Build Tools** (the one native module, `node-pty`, ships a ready-to-run N-API prebuilt).
- Inside WSL, for the voice setup: `git`, `cmake`, `build-essential`, `ffmpeg`, `espeak-ng`, `python3`, and [`uv`](https://docs.astral.sh/uv/) — `npm run setup` checks for these and prints the exact apt line if any are missing
- **Optional, for remote co-work:** [`cloudflared`](https://github.com/cloudflare/cloudflared) on Windows (`winget install Cloudflare.cloudflared`, or point `CLAUDIBLE_CLOUDFLARED` at the binary). Without it, **Share** still works but the invite link is **localhost/LAN-only**.
- **Optional, for private-repo projects + session sync:** the GitHub CLI [`gh`](https://cli.github.com/) installed and signed in **inside WSL** (`gh auth login`).

## Install & run

**Two ways in:**

| | ⬇️ **Download the app** | 🛠️ **Build from source** |
|---|---|---|
| **For** | Most people — just want to run it | Developers · Linux · terminal users |
| **Windows** | Double-click `Claudible-Setup.exe` | `install.ps1` (clone + build) |
| **Linux / macOS** | *(installers coming)* | `bash setup/setup.sh` |
| **Comes from** | [**Releases**](https://github.com/thecrazydev1/claudible/releases) | `git clone` |

Claudible is in **public beta** — expect fast releases and the occasional rough edge; [issues](https://github.com/thecrazydev1/claudible/issues) are very welcome.

---

### ⬇️ Download — Windows installer (no terminal, no clone)

The simplest path. **No git, no `npm`, no PowerShell scripts, no `system32` snags** — the app is prebuilt.

1. Open **[Releases](https://github.com/thecrazydev1/claudible/releases)** and download the latest **`Claudible-Setup-<version>-x64.exe`**.
2. Double-click it. It's **unsigned** during beta, so Windows SmartScreen shows *“Windows protected your PC”* → click **More info → Run anyway** (one time).
3. Launch Claudible from the Start menu / Desktop shortcut. **On first run it sets up local voice automatically** — the Whisper + Kokoro models are a few-hundred-MB download, so you'll see a *“Setting up voice…”* note while it works in the background (it's resumable; reopen if interrupted).

**Already needs to be on the PC** (the same native-Windows prerequisites — the installer just skips the clone/build):
- **Claude Code for Windows**, signed in — run `claude` once in any terminal and log in. *(This is what Claudible embeds; it can't run without it.)*
- **Node.js 22.12+** for Windows ([nodejs.org](https://nodejs.org)) — Claude Code's hooks need a real `node`.
- **Git for Windows** ([git-scm.com](https://git-scm.com/download/win)) — provides the `bash.exe` the voice services run through.

> 🧪 The native-Windows runtime (esp. voice) is the newest path — if voice doesn't come up, the WSL build below is the proven one, and the log is at `%USERPROFILE%\.claudible\logs\`.

---

### 🛠️ Build from source

For developers, Linux, and terminal users who'd rather `git clone` and run a script (no installer). One `Runner` seam picks the backend per OS. Maturity, honestly: **Windows + WSL2** is the battle-tested path; **Linux** is verified (native backend live-tested, packaged AppImage boot-tested); **native Windows** and **macOS** are code-complete with runtime smoke tests in progress.

<details open><summary><h3>🪟 Windows 11 + WSL2 — recommended</h3></summary>

**Run in Windows PowerShell, not inside WSL.** (Claudible is a *Windows* Electron app that embeds Claude Code running in WSL; running it from inside WSL installs the Linux Electron and dies on `libnspr4.so`.) You need **WSL2** + a **signed-in Claude Code** inside it (see [Prerequisites](#prerequisites)).

**One line** — asks where to install (Enter for the default), installs git if you don't have it, clones, installs everything, and launches:
```powershell
$dir = (Read-Host "Install folder for Claudible (Enter for default) [$HOME\claudible]").Trim().Trim('"'); if (-not $dir) { $dir = "$HOME\claudible" }; if (!(Get-Command git -ErrorAction SilentlyContinue)) { winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements; $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); if (Test-Path "$env:ProgramFiles\Git\cmd\git.exe") { $env:Path = "$env:ProgramFiles\Git\cmd;$env:Path" } }; git clone https://github.com/thecrazydev1/claudible "$dir"; if (Test-Path "$dir\install.ps1") { powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install.ps1" } else { Write-Host "`n[!] install.ps1 is missing after clone -- your antivirus most likely quarantined it (a false positive). To fix: allow/exclude the folder `"$dir`" in your antivirus, then run these two lines:`n    git -C `"$dir`" restore install.ps1`n    powershell -NoProfile -ExecutionPolicy Bypass -File `"$dir\install.ps1`"`nPer-antivirus steps are in `"$dir\SETUP.md`" (the Antivirus section)." -ForegroundColor Yellow }
```
It **prompts for an install folder** (Enter for the default `…\claudible`, or paste any path), **auto-installs Git for Windows** via winget if it's missing, clones, then `install.ps1` checks Windows Node (offers to install it via winget), runs `npm install`, builds the local voice services in WSL — installing their Linux deps for you (it may ask for your WSL sudo password) — then makes a Desktop shortcut and launches. **First run only:** the voice build compiles whisper.cpp and downloads ~480 MB of models, so it can churn for 10–20 min; if it's interrupted, just run the line again — it resumes.

> **No `winget`?** (older Windows) Install Git from **[git-scm.com/download/win](https://git-scm.com/download/win)** with the defaults, **reopen PowerShell**, then run the line above.

<details><summary>Prefer to run the steps by hand?</summary>

```powershell
git clone https://github.com/thecrazydev1/claudible
cd claudible
npm install        # deps + node-pty's N-API prebuilt + the small JS patch (no compiler needed)
npm run setup      # builds the WSL voice services (installs their deps; ~480 MB models on first run)
npm start          # opens the cockpit
```
Optional Desktop shortcut: `powershell -NoProfile -ExecutionPolicy Bypass -File launch\make-shortcut.ps1`
</details>
</details>

<details><summary><h3>🪟 Windows — native (no WSL) · new</h3></summary>

A WSL-free path: native Windows Claude Code + **prebuilt** voice services (no compiler), driven by the `win` runner.
**Needs:** Windows **Node 22.12+** and **Git for Windows** (`bash.exe`). The installer installs Claude Code for Windows if it's missing.
```powershell
git clone https://github.com/thecrazydev1/claudible
cd claudible
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Native
```
> Run it through `powershell -ExecutionPolicy Bypass -File …` as shown — Windows blocks `.\install.ps1` directly under its default `Restricted` policy ("running scripts is disabled on this system"). The `Bypass` applies to this one launch only and changes nothing on the machine. Also: clone into your **home/projects folder, not `C:\WINDOWS\system32`** (and use a normal, non-Admin PowerShell).

This: installs Claude Code (`npm i -g @anthropic-ai/claude-code`) if absent → runs `setup\setup-win.ps1`, which downloads the prebuilt `whisper-server.exe` + the speech model and sets up Kokoro (CPU) via [`uv`](https://docs.astral.sh/uv/) — **no Visual Studio / Python / cmake** → pins `CLAUDIBLE_RUNNER=win`. Remove that user env var to fall back to WSL.

> 🧪 **Newer path — runtime smoke test in progress.** Terminal + telemetry are expected solid; the Windows **voice** runtime (Kokoro `:8880`) is the most likely rough edge. If anything snags, the **WSL path above is the proven one**.
</details>

<details><summary><h3>🐧 Linux · verified backend</h3></summary>

**Needs:** **Node 22.12+**, a **C toolchain** (`build-essential` + `python3` — `node-pty` compiles on install), **Claude Code on your PATH** (`claude`, signed in), and the voice build deps — `bash setup/setup.sh` installs them via `apt` (`git cmake build-essential ffmpeg espeak-ng python3` + [`uv`](https://docs.astral.sh/uv/)).
```bash
git clone https://github.com/thecrazydev1/claudible
cd claudible
npm install            # builds node-pty for Linux (needs build-essential + python3)
bash setup/setup.sh    # whisper.cpp + Kokoro (~480 MB models on first run)  ·  NOT `npm run setup` (that's the Windows→WSL wrapper)
npm start              # auto-selects the native Linux backend (no WSL involved)
```
Packaged installers build with `npm run dist:linux` (AppImage + `.deb`); the 0.6.0 AppImage is built and boot-verified. The native backend (`runScript` + a real node-pty spawn) is live-tested.
</details>

<details><summary><h3>🍎 macOS · new</h3></summary>

Same backend as Linux, with **Homebrew** for the voice build deps.
**Needs:** **Node 22.12+**, **Claude Code on your PATH**, **Xcode Command Line Tools** (`xcode-select --install`), and `brew install cmake ffmpeg espeak-ng`.
```bash
git clone https://github.com/thecrazydev1/claudible
cd claudible
npm install
bash setup/setup.sh    # detects Homebrew for the build deps  ·  NOT `npm run setup` (Windows→WSL only)
npm start
```
A signed **`.dmg`** is the planned release artifact (`npm run dist:mac`).

> 🧪 **Newer path — runtime smoke test pending** (needs a Mac to build/sign + verify voice).
</details>

Full steps + troubleshooting for the Windows + WSL2 path: **[SETUP.md](SETUP.md)**. (Linux/macOS: the steps above are the complete guide.)

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

There's a **human↔human chat** alongside the terminal, names for the host and each guest, and a **mobile-friendly** browser viewer so someone can follow along from a phone. Rotate the invite anytime without dropping current guests. Nothing is hosted by us — the tunnel connects *out* from your machine; see [Security & privacy](#security--privacy) for what that exposes.

### How joining works — and why it's safe
When you click **Share**, Claudible starts a tiny web server **on your own machine** (loopback). If
[`cloudflared`](https://github.com/cloudflare/cloudflared) is installed, it wraps that in a free Cloudflare
**quick-tunnel** and gives you a `https://<random>.trycloudflare.com` link; without it, the link is
`localhost`/LAN-only. A guest opens the link in any browser (laptop or phone), enters a name, and **waits in a
lobby** until you approve them — they see nothing until you do. Read-only guests can only watch + chat;
interactive guests share your keyboard, so only grant that to people you trust.

**We don't host anything.** There's no Claudible server in the middle: the page, the live terminal, and the chat
are all served **by your machine**. The Cloudflare tunnel is just a temporary last-mile pipe (like a disposable
port-forward) that connects *out* from your computer — so the link is **ephemeral**: it exists only while you're
sharing and dies the instant you stop or go offline. Click **New link** to invalidate the old one and lock out
anyone who held it.

> **A guest can't reach the link?** The address is a `*.trycloudflare.com` tunnel, so a guest's
> network/ISP/VPN — or Cloudflare's own edge — can occasionally block or rate-limit it. That's a *network* issue,
> not your session or their identity. Fix: have them try a **different network** (a phone hotspot is the quickest
> test) or send a **fresh link**. Only people you explicitly approve ever get in, so opening it up that way is safe.

## Security & privacy
- **Permissions are yours to set.** By default the embedded Claude Code **prompts before running tools**, exactly like the normal CLI. In **Settings** you can pick a remembered mode: **Accept edits**, or **Bypass permissions** (`--dangerously-skip-permissions --add-dir $HOME`) for a frictionless one-click/voice flow — that's powerful, so only use it on a machine you trust. A session **synced from a collaborator is ALWAYS sandboxed** (normal prompting, no `--add-dir`, never auto-resumed) regardless of your setting, so an untrusted transcript can't drive tools with full `$HOME` access.
- **Voice is local; Claude Code is not.** Speech-to-text (Whisper) and text-to-speech (Kokoro) run entirely on your machine, and Claudible sends no telemetry. The embedded **Claude Code** sends your prompts and code to Anthropic exactly as the normal CLI does — Claudible doesn't change that.
- **The voice services bind `0.0.0.0`** so the Windows app can reach them across the WSL2 NIC. On WSL2's default NAT networking they aren't exposed to your LAN; if you enable WSL2 *mirrored* networking they become reachable from the host's interfaces, so don't run mirrored networking on an untrusted network.
- **Live co-work is off until you click Share, and exposes your session for as long as it's on.** The quick-tunnel URL is public-but-unguessable; anyone with the link reaches the lobby, but **no one sees or touches your terminal until you approve them**, and **interactive** access lets an approved guest type into a Claude Code session that runs with skipped permissions — so only share interactive with people you trust, prefer read-only otherwise, and stop sharing (or rotate the link) when you're done.

## Platform support
**Windows (WSL2 or native), Linux, and macOS.** Every OS-coupled call goes through one `Runner` seam
(`runners/{wsl,posix,win}.js`), selected by `CLAUDIBLE_RUNNER` or the platform:
- **Windows + WSL2** — spawns `wsl.exe`, embeds Claude Code in Linux. The most-tested path.
- **Windows native** — runs Windows `claude.exe` directly (ConPTY) and the `wsl/*.sh` fleet via Git-for-Windows `bash`; no WSL.
- **Linux** — spawns `bash -lc` directly; native backend live-tested, AppImage builds.
- **macOS** — shares the Linux backend + Homebrew/`lsof` voice branches; `.dmg` is the planned artifact.

The script fleet is **Python-free** (the JSON transforms were ported to Node, byte-parity proven), so the only
per-OS runtime is Node + a shell. See [docs/OS-CONVERSION-PLAN.md](docs/OS-CONVERSION-PLAN.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License
[MIT](LICENSE).

---

*Built by the_crazydev with Claude.*
