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

## 2. Get it
```powershell
git clone https://github.com/thecrazydev1/claudible
cd claudible
npm install
```
`npm install` runs `patch-package`, which reapplies a tiny node-pty fix (the ConPTY guard that stops the embedded terminal from crashing under Electron).

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
- **Embedded terminal shows a Claude login / sign-in prompt** — you're not signed in to Claude Code yet. Complete the login right there in the terminal, or (better) run `claude` once in WSL, finish login, then relaunch Claudible.
- **Embedded terminal shows a `node-pty` / native-module error** — the module needs rebuilding for your Electron version:
  ```powershell
  npm run rebuild
  ```
  This needs **Visual Studio Build Tools** with the *Desktop development with C++* workload.
- **No voice in or out** — confirm the services bound. In WSL: `bash wsl/services.sh` should print `whisper up :2022` and `kokoro up :8880`. Logs live in `~/.claudible/logs/`.
- **"mic blocked"** — see *Enable the microphone* above.
- **Point at your own STT/TTS** — set `CLAUDIBLE_WHISPER` / `CLAUDIBLE_KOKORO` to any OpenAI-compatible audio endpoint.
