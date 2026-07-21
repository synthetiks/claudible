# Contributing

Thanks for your interest in Claudible! It's an early-stage project, so issues, ideas, and PRs are all
welcome.

## Reporting issues
Open an issue at https://github.com/thecrazydev1/claudible/issues. Helpful things to include:
- Windows + WSL2 version, WSL distro, Node version (`node -v`), and Electron version.
- Whether voice was a **from-scratch** `npm run setup` or a **reused `~/.voicemode`** install.
- Relevant logs from `~/.claudible/logs/` (`kokoro.out`, `whisper.out`) and the cockpit's console.

## Development setup
1. `git clone https://github.com/thecrazydev1/claudible && cd claudible`
2. `npm install` (Node **22.12+** on Windows — Electron 42 requires it)
3. `npm run setup` (installs the local voice services in WSL)
4. `npm start`

See [SETUP.md](SETUP.md) for full prerequisites and troubleshooting, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## A few guidelines
- **Keep it portable.** No hardcoded usernames, home directories, or machine-specific paths — everything
  resolves from `$HOME`, `__dirname`, or `$PSScriptRoot` so the app works for any user and install location.
- **The from-scratch voice install is the less-travelled path.** If you touch `setup/setup.sh` or
  `wsl/services.sh`, please test it on a machine without a pre-existing `~/.voicemode`.
- **Match the surrounding style.** The code is intentionally compact and comment-dense about *why*, not *what*.
- Before opening a PR, run what CI runs so you don't pass locally and fail CI:
  `npm test` (the full suite), `npm run lint` (ESLint), and
  `shellcheck --severity=error -e SC1091 wsl/*.sh setup/setup.sh`. (`node --check main.js` +
  `bash -n wsl/*.sh` are a fast pre-check but are strictly weaker than the above.)

## License
By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
