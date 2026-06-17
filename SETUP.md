# Setup

Claudible runs on **Windows 11 + WSL2**. The Electron app runs on Windows; it embeds the real Claude Code CLI running inside WSL, plus two local voice services (speech-to-text + text-to-speech).

## 1. Prerequisites
- **WSL2 + Ubuntu** — `wsl --install` (in an admin PowerShell), then reboot.
- **Claude Code CLI inside WSL** — `claude` must be on your WSL PATH **and signed in**. Run `claude` once in WSL and complete login *before* launching Claudible (it embeds your existing session and doesn't handle first-time login specially). See the Claude Code docs.
- **Node.js 22.12+ on Windows.** (Electron 42 and its build tooling require it; older Node prints `EBADENGINE` warnings on install.)
- Inside WSL: `git`, `cmake`, `build-essential`, `ffmpeg`, `python3`, and [`uv`](https://docs.astral.sh/uv/). Quick install:
  ```bash
  sudo apt update && sudo apt install -y git cmake build-essential ffmpeg python3 espeak-ng
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```

## 2. Get it — one line (does steps 2–4 for you)
> **Run in Windows PowerShell, not inside WSL** (the Electron app is the Windows side; it reaches into WSL itself — running it inside WSL fails with `libnspr4.so`). The repo is **private during beta, so you must be added as a collaborator first**; your first clone will prompt you to sign in to GitHub.

```powershell
git clone https://github.com/thecrazydev1/claudible "$HOME\claudible"; powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\claudible\install.ps1"
```
`install.ps1` checks/installs Windows **Node 22.12+**, runs `npm install`, builds the voice services in WSL (installing their deps — may ask for your WSL sudo password), makes a Desktop shortcut, and launches. First run downloads ~480 MB of models (10–20 min); re-run the line if interrupted.

<details><summary>Or do it by hand (steps 2–4 below).</summary>

```powershell
git clone https://github.com/thecrazydev1/claudible
cd claudible
npm install
```
`npm install` runs `patch-package` (the tiny node-pty ConPTY fix) and needs **Node 22.12+ for Windows** (not just WSL's Node). Then continue with steps 3–4.
</details>

## 3. Install the voice services
```powershell
npm run setup
```
Installs **Whisper** (STT, port 2022) and **Kokoro** (TTS, port 8880) under `~/.claudible/voice` in WSL, and downloads their models (~150 MB Whisper + ~327 MB Kokoro). If you already have a full [Voicemode](https://github.com/mbailey/voicemode) install at `~/.voicemode`, it's reused automatically and setup is instant.

## 4. Run
```powershell
npm start
```
Optional Desktop shortcut: `powershell -ExecutionPolicy Bypass -File launch\make-shortcut.ps1`

## Enable the microphone
Windows → **Settings → Privacy & security → Microphone** → allow desktop apps to access the mic.

## Troubleshooting
- **`npm start` fails with `libnspr4.so: cannot open shared object file` (or another `error while loading shared libraries`)** — you're running it **inside WSL**. Claudible's Electron app is the Windows side. Clone onto your Windows drive and run `npm install` / `npm start` from **Windows PowerShell** (you can delete the WSL copy under `~/…`). Only `npm run setup` runs in WSL.
- **Embedded terminal shows a Claude login / sign-in prompt** — you're not signed in to Claude Code yet. Complete the login right there in the terminal, or (better) run `claude` once in WSL, finish login, then relaunch Claudible.
- **Embedded terminal shows a `node-pty` / native-module error** — the module needs rebuilding for your Electron version:
  ```powershell
  npm run rebuild
  ```
  This needs **Visual Studio Build Tools** with the *Desktop development with C++* workload.
- **No voice in or out** — confirm the services bound. In WSL: `bash wsl/services.sh` should print `whisper up :2022` and `kokoro up :8880`. Logs live in `~/.claudible/logs/`.
- **"mic blocked"** — see *Enable the microphone* above.
- **Point at your own STT/TTS** — set `CLAUDIBLE_WHISPER` / `CLAUDIBLE_KOKORO` to any OpenAI-compatible audio endpoint.
