# Security

Claudible is a **local, single-user desktop tool**. It has no server, no accounts, and no network
surface of its own beyond two localhost voice services. Still, it's worth understanding what it does.

## What to know before you run it
- **The embedded Claude Code runs with `--dangerously-skip-permissions` and `--add-dir $HOME`.** That's
  intentional — it keeps the voice and one-click flow frictionless — but it means the embedded Claude
  can read and act across your home directory without per-action confirmation. Run Claudible on a
  machine you trust, the same way you'd run `claude` with permissions skipped. To change it, edit the
  `exec claude …` lines in [`wsl/session.sh`](wsl/session.sh).
- **The voice services (Whisper :2022, Kokoro :8880) bind `0.0.0.0`** so the Windows app can reach them
  across the WSL2 NIC. On WSL2's default NAT networking they are not exposed to your LAN. If you enable
  WSL2 *mirrored* networking, they become reachable from the host's network interfaces — don't run
  mirrored networking on an untrusted network.
- **`npm run setup` downloads and builds third-party software** (whisper.cpp, Kokoro) and installs `uv`
  via the upstream `curl … | sh` installer. These are the projects' standard install paths; review
  [`setup/setup.sh`](setup/setup.sh) if you'd rather install them yourself.
- **The voice layer is local; Claude Code is not.** STT/TTS run on your machine and Claudible sends no
  telemetry. The embedded Claude Code sends prompts/code to Anthropic exactly as the normal CLI does.

## Reporting a vulnerability
Please open an issue at https://github.com/thecrazydev1/claudible/issues. For anything you'd prefer not
to disclose publicly, note that in the issue and we'll arrange a private channel before sharing details.
