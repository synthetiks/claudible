# Contributing

Thanks for your interest in Claudible! It's an early-stage project, so issues, ideas, and PRs are all
welcome.

## Reporting issues
Open an issue at https://github.com/synthetiks/claudible/issues. Helpful things to include:
- **Which install path you're on** — this matters more than anything else, because the four paths use
  different backends (`runners/wsl.js`, `runners/win.js`, `runners/posix.js`) and a bug is usually specific
  to one of them:
  - Windows + WSL2 (the proven path) — include your WSL2 version and distro
  - Windows native, no WSL (`install.ps1 -Native`, `CLAUDIBLE_RUNNER=win`)
  - Linux
  - macOS
- Node version (`node -v`) and Electron version.
- Whether voice was a **from-scratch** install or a **reused `~/.voicemode`** one.
- Relevant logs from `~/.claudible/logs/` (`kokoro.out`, `whisper.out`) and the cockpit's console.

## Development setup
Node **22.12+** everywhere (Electron 42 requires it), and Claude Code installed and signed in.
`git clone https://github.com/synthetiks/claudible && cd claudible` first, then follow your platform:

**Windows + WSL2** (the most-travelled path)
```
npm install
npm run setup      # installs the local voice services INTO WSL (this is the Windows->WSL wrapper)
npm start
```

**Windows, native (no WSL)** — `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Native`.
Needs **Git for Windows** (`bash.exe`) as well as Node. Pins `CLAUDIBLE_RUNNER=win`; remove that user env
var to fall back to WSL.

**Linux / macOS**
```
npm install            # node-pty COMPILES here: Linux needs build-essential + python3, macOS needs Xcode CLT
bash setup/setup.sh    # NOT `npm run setup` — that one is the Windows->WSL wrapper and will not do what you want
npm start
```
`npm install` failing with a wall of node-gyp/compiler output almost always means the C toolchain is missing
rather than anything wrong with the repo — `node-pty` ships no Linux prebuild, so it compiles from source.

See [README.md](README.md#install--run) for the full per-platform prerequisites, [SETUP.md](SETUP.md) for
Windows + WSL2 troubleshooting, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit
together.

## A few guidelines
- **Keep it portable.** No hardcoded usernames, home directories, or machine-specific paths — everything
  resolves from `$HOME`, `__dirname`, or `$PSScriptRoot` so the app works for any user and install location.
- **The from-scratch voice install is the less-travelled path.** If you touch `setup/setup.sh` or
  `wsl/services.sh`, please test it on a machine without a pre-existing `~/.voicemode`.
- **Respect the runner seam.** `main.js` and the renderer must never touch `wsl.exe`, `wslpath`, `bash` or a
  Windows path directly — everything OS-coupled goes through a `runners/*.js` method (see
  [docs/SEAMS.md](docs/SEAMS.md)). Adding an OS means adding a runner, not branching in main.
- **Say which platforms you actually tested.** The three backends are not equally exercised — the native
  Windows runner in particular is the newest — so "tested on WSL2 only" is genuinely useful information in a
  PR, not an admission.
- **Match the surrounding style.** The code is intentionally compact and comment-dense about *why*, not *what*.
- Before opening a PR, run what CI runs so you don't pass locally and fail CI:
  `npm test` (the full suite), `npm run lint` (ESLint), and
  `shellcheck --severity=error -e SC1091 wsl/*.sh setup/setup.sh`. (`node --check main.js` +
  `bash -n wsl/*.sh` are a fast pre-check but are strictly weaker than the above.)

## License
By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
