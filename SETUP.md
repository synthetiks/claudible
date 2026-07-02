# Setup

Claudible runs on **Windows 11 + WSL2**. The Electron app runs on Windows; it embeds the real Claude Code CLI running inside WSL, plus two local voice services (speech-to-text + text-to-speech).

## 1. Prerequisites
- **WSL2 + Ubuntu** — `wsl --install` (in an admin PowerShell), then reboot.
- **Claude Code CLI inside WSL** — `claude` must be on your WSL PATH **and signed in**. Run `claude` once in WSL and complete login *before* launching Claudible (it embeds your existing session and doesn't handle first-time login specially). See the Claude Code docs.
- **Node.js 22.12+ on Windows.** (Electron 42 and its build tooling require it; older Node prints `EBADENGINE` warnings on install.)
- **Git for Windows** — to clone the repo. The one-liner in step 2 **auto-installs it via winget** if missing; otherwise get it from [git-scm.com/download/win](https://git-scm.com/download/win).
- Inside WSL: `git`, `cmake`, `build-essential`, `ffmpeg`, `python3`, and [`uv`](https://docs.astral.sh/uv/). Quick install:
  ```bash
  sudo apt update && sudo apt install -y git cmake build-essential ffmpeg python3 espeak-ng
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```

## 2. Get it — one line (does steps 2–4 for you)
> **Run in Windows PowerShell, not inside WSL** (the Electron app is the Windows side; it reaches into WSL itself — running it inside WSL fails with `libnspr4.so`). Claudible is in **public beta** — clone away; no account needed.

```powershell
$dir = (Read-Host "Install folder for Claudible (Enter for default) [$HOME\claudible]").Trim().Trim('"'); if (-not $dir) { $dir = "$HOME\claudible" }; if (!(Get-Command git -ErrorAction SilentlyContinue)) { winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements; $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); if (Test-Path "$env:ProgramFiles\Git\cmd\git.exe") { $env:Path = "$env:ProgramFiles\Git\cmd;$env:Path" } }; git clone https://github.com/thecrazydev1/claudible "$dir"; if (Test-Path "$dir\install.ps1") { powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install.ps1" } else { Write-Host "`n[!] install.ps1 is missing after clone -- your antivirus most likely quarantined it (a false positive). To fix: allow/exclude the folder `"$dir`" in your antivirus, then run these two lines:`n    git -C `"$dir`" restore install.ps1`n    powershell -NoProfile -ExecutionPolicy Bypass -File `"$dir\install.ps1`"`nPer-antivirus steps are in `"$dir\SETUP.md`" (the Antivirus section)." -ForegroundColor Yellow }
```
It prompts for an **install folder** (Enter for the default, or paste any path), auto-installs **Git for Windows** via winget if missing, clones, then `install.ps1` checks/installs Windows **Node 22.12+**, runs `npm install`, builds the voice services in WSL (installing their deps — may ask for your WSL sudo password), makes a Desktop shortcut, and launches. First run downloads ~480 MB of models (10–20 min); re-run the line if interrupted. **No winget?** (older Windows) Install Git from [git-scm.com/download/win](https://git-scm.com/download/win), reopen PowerShell, then run the line.

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
- **Antivirus flagged the installer (install stalls, or `install.ps1` "does not exist" even though the folder cloned fine)** — your **antivirus quarantined `install.ps1`**. It's a **false positive**: the installer auto-installs Node/git and launches a hidden window, a pattern scanners treat as suspicious. Every other file clones normally; only that one script gets grabbed. The one-line installer now detects this and prints the same recovery steps. To fix (paths below assume the default folder — swap in your install folder if you chose a custom one):
  1. **Allow it in your antivirus.** *Windows Defender:* Windows Security → *Virus & threat protection → Protection history* → find `install.ps1` → **Restore**, then *Manage settings → Exclusions → Add an exclusion → Folder* → pick your `claudible` folder. *Third-party AV (Avast, AVG, McAfee, Norton, Bitdefender…):* open it → **Quarantine / Protection history** → restore the file, and add the `claudible` folder to its **exceptions / allow-list**.
  2. **Restore the file** — no re-download, it's already in the clone's git data:
     ```powershell
     git -C "$HOME\claudible" restore install.ps1
     ```
  3. **Run it:**
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\claudible\install.ps1"
     ```
  Rather not touch your antivirus? Skip `install.ps1` and run the **manual steps** instead: install **Node 22.12+** for Windows, then from the folder run `npm install`, `npm run setup`, `npm start`.
- **`npm start` fails with `libnspr4.so: cannot open shared object file` (or another `error while loading shared libraries`)** — you're running it **inside WSL**. Claudible's Electron app is the Windows side. Clone onto your Windows drive and run `npm install` / `npm start` from **Windows PowerShell** (you can delete the WSL copy under `~/…`). Only `npm run setup` runs in WSL.
- **Embedded terminal shows a Claude login / sign-in prompt** — you're not signed in to Claude Code yet. Complete the login right there in the terminal, or (better) run `claude` once in WSL, finish login, then relaunch Claudible.
- **Embedded terminal shows a `node-pty` / native-module error** — **rare.** `node-pty` ships an N-API prebuilt that loads under Electron with no compiling, so this only happens on an unusual CPU arch it has no prebuilt for. As a fallback, build it from source:
  ```powershell
  npm run rebuild
  ```
  That fallback — and *only* that fallback — needs **Python 3** plus **Visual Studio C++ Build Tools** (the *Desktop development with C++* workload).
- **No voice in or out** — confirm the services bound. In WSL: `bash wsl/services.sh` should print `whisper up :2022` and `kokoro up :8880`. Logs live in `~/.claudible/logs/`.
- **"mic blocked"** — see *Enable the microphone* above.
- **Point at your own STT/TTS** — set `CLAUDIBLE_WHISPER` / `CLAUDIBLE_KOKORO` to any OpenAI-compatible audio endpoint.
