# Security

Claudible is a **local desktop tool**: no accounts, no telemetry, and — in its default build — no
Claudible-operated servers (the optional presence relay below ships **inert**; it is off unless a team
self-hosts one). It does have real network surface when you use certain features — here is the honest map of it.

## What to know before you run it

- **Permissions are yours to set.** By default the embedded Claude Code **asks before running tools**,
  exactly like the plain CLI. In **Settings → Permissions** you can opt into a remembered mode:
  *auto-accept edits*, or *bypass permissions* (`--dangerously-skip-permissions --add-dir $HOME`) for the
  frictionless one-click/voice flow. Bypass is powerful — only use it on a machine you trust. The active
  mode is always visible in the status bar.
- **A session synced from a collaborator is ALWAYS sandboxed**, regardless of your permission setting: it
  resumes in normal ask-first mode, without `--add-dir`, and is never auto-resumed. An untrusted transcript
  can never drive tools with your home-directory access.
- **Turning on collaboration syncs your full transcripts to the repo.** When you enable "Collaborate in
  Claudible" / session sync on a repo-backed project, each session's **complete transcript** — your prompts,
  the code and tool output, **anything Claude read during the session (file contents, secrets, command
  output)**, and a small per-turn identity block (your display name, `gh` login, git email, and machine
  name) — is committed to the private repo's history on the `claudible/sessions` branch, where every
  collaborator with git access can read it. This is how shared sessions appear on everyone's machine. It is
  disclosed in-app before you turn it on, stays on until you turn it off, and only ever writes to the
  **private** repo you chose — nothing leaves for a third party. Don't enable it on a repo whose collaborators
  shouldn't see a given session's contents.
- **Live share opens network surface — only while you use it.** Clicking **Share** starts a WebSocket
  server on your machine (loopback) and, if `cloudflared` is installed, a public-but-unguessable
  `https://*.trycloudflare.com` quick-tunnel that connects *outward* from your machine. Nobody sees or
  types into your terminal until you approve them by name in the lobby; *interactive* guests share your
  keyboard, so grant that only to people you trust. The link dies when you stop sharing; **New link**
  revokes everyone who held the old one. Guest resume tokens are single-use and IP-bound; a kicked guest's
  tokens are invalidated.
  - *Known, accepted exposure:* a guest's private resume token travels as a `?r=` query parameter on the
    WebSocket URL and is held in the tab's `sessionStorage` (so a refresh silently reconnects). It is
    therefore visible in that browser's own history/URL bar. This is mitigated — the token is per-guest,
    IP-bound, single-use, revoked on kick, and expires after a short grace window — and is bounded to a
    session the host already approved. Moving it into an `HttpOnly` cookie is deliberately deferred (it
    would risk the reconnect flow over the `SameSite=None` tunnel) and is tracked as a hardening item.
  - *Known, accepted exposure:* the share page's static assets (`/guest.js`, the bundled xterm files) are
    served without the page's token check. The content is public library/UI code — nothing session- or
    host-specific — so the only thing an unauthenticated request learns is "a Claudible share is running
    here", and every response already discloses that via the `X-Claudible-Share` header (which the tunnel
    verifier needs on all responses, 404s included). Gating the assets would therefore add a token
    round-trip for zero information hidden; the real upgrade is the same `HttpOnly`-cookie migration
    deferred above, and the two are tracked as one item.
- **Live-session presence relay (opt-in, self-hosted, OFF by default).** A team may deploy the tiny
  Cloudflare Worker in [`relay/`](relay/) to make "went live"/"ended" reach collaborators in under a second
  instead of the default ~3–5s git path. When enabled (`CLAUDIBLE_RELAY_URL`, or a maintainer bakes a URL
  into `lib/presenceRelay.js`), each connecting app sends that operator's Worker: the connecting GitHub
  login, timestamps, a **hashed** repo identity (repo names never appear in URLs/logs), and the same
  presence payload already committed to the `claudible/sessions` branch — never transcripts or terminal
  content. The GitHub token is used for one read-only push-permission check per connection and is not
  stored or logged. Git remains the source of truth; the relay is a preview layer that no-ops when unset.
  The maintainer who deploys it becomes its operator — the "no Claudible-operated servers" line above holds
  only while no relay URL is configured.
- **"Share live" advertises the link to your repo collaborators.** In a *synced project*, the **Share live**
  action in a session's `▾` menu (not the plain **Share** button) additionally publishes the invite URL and
  its join token to `live/<your-login>.json` on the project's shared `claudible/sessions` branch. That is the
  point of it — it's how a teammate sees the **● LIVE** badge and can click **Join** unprompted — but it does
  mean **anyone with git access to that repo can read the link**. They still cannot enter unseen: every guest
  waits for your by-name lobby approval. Ending the share clears the advertisement. To share with exactly one
  person, use the plain **Share** button and hand them the link yourself.
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
