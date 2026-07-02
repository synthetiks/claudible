# Security

Claudible is a **local desktop tool**: no accounts, no Claudible-operated servers, no telemetry. It does
have real network surface when you use certain features — here is the honest map of it.

## What to know before you run it

- **Permissions are yours to set.** By default the embedded Claude Code **asks before running tools**,
  exactly like the plain CLI. In **Settings → Permissions** you can opt into a remembered mode:
  *auto-accept edits*, or *bypass permissions* (`--dangerously-skip-permissions --add-dir $HOME`) for the
  frictionless one-click/voice flow. Bypass is powerful — only use it on a machine you trust. The active
  mode is always visible in the status bar.
- **A session synced from a collaborator is ALWAYS sandboxed**, regardless of your permission setting: it
  resumes in normal ask-first mode, without `--add-dir`, and is never auto-resumed. An untrusted transcript
  can never drive tools with your home-directory access.
- **Live share opens network surface — only while you use it.** Clicking **Share** starts a WebSocket
  server on your machine (loopback) and, if `cloudflared` is installed, a public-but-unguessable
  `https://*.trycloudflare.com` quick-tunnel that connects *outward* from your machine. Nobody sees or
  types into your terminal until you approve them by name in the lobby; *interactive* guests share your
  keyboard, so grant that only to people you trust. The link dies when you stop sharing; **New link**
  revokes everyone who held the old one. Guest resume tokens are single-use and IP-bound; a kicked guest's
  tokens are invalidated.
- **The voice services (Whisper :2022, Kokoro :8880) bind `0.0.0.0`** so the Windows app can reach them
  across the WSL2 NIC. On WSL2's default NAT networking they are not exposed to your LAN. If you enable
  WSL2 *mirrored* networking they become reachable from the host's interfaces — don't run mirrored
  networking on an untrusted network.
- **`npm run setup` downloads and builds third-party software** (whisper.cpp, Kokoro) and installs `uv`
  via the upstream `curl … | sh` installer. These are the projects' standard install paths; review
  [`setup/setup.sh`](setup/setup.sh) if you'd rather install them yourself.
- **The voice layer is local; Claude Code is not.** STT/TTS run on your machine and Claudible sends no
  telemetry. The embedded Claude Code sends prompts/code to Anthropic exactly as the normal CLI does.
- **The renderer is locked down**: context isolation on, node integration off, a strict CSP that blocks
  all external requests, microphone-only permissions, and window navigation/popup blocking. Join windows
  are pinned to the tunnel origin.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** on this repository
(*Security → Report a vulnerability*) so details stay private while we fix it. If that's unavailable to
you, open an issue saying only that you've found a security-sensitive bug — no details — and we'll
arrange a private channel.
