# Changelog

All notable changes to Claudible are documented here.

## [Unreleased] — Frictionless install

Making a fresh install "paste one line and go," to production standards.

### Install
- **No compiler, no Python, no Visual Studio Build Tools.** `node-pty` — the one native module — ships ABI-stable **N-API** prebuilts that load under Electron unchanged, so the forced `electron-rebuild` step was a no-op left over from node-pty's pre-N-API (0.x) days — and the *sole* reason the install pulled in a multi-GB C++ toolchain (and, via node-gyp, Python). Removed it; `install.ps1` now just verifies the shipped prebuilt for your CPU arch is present. Proven safe: the npm-published prebuilt is **byte-identical** to the binary this app already runs on under Electron 42. (A source build stays available as `npm run rebuild` for the rare arch with no prebuilt.)
- **Self-bootstrapping one-liner.** The install command installs **Git for Windows** via winget if it's missing (refreshing PATH in-session) and lets you **choose the install folder** (Enter for the default) — one paste, with no prerequisites beyond WSL2 + a signed-in Claude Code.
- **Antivirus quarantine self-diagnoses.** Some antivirus engines false-positive on `install.ps1` and quarantine it; the installer now detects the resulting gap and prints plain-English recovery (allow the folder → `git restore install.ps1` → re-run) instead of a cryptic "file not found," with per-AV steps in SETUP.md.

## [0.2.0] — Hardening & Polish

A correctness, security, and UX pass across the whole app.

### Security & integrity
- **Live share never spawns a second tunnel.** `share:start` is now concurrency-guarded (single in-flight start) and defensively kills any prior tunnel before spawning, so a double-click or a collab/manual race can no longer orphan a public `cloudflared` tunnel that survives app exit.
- **Guest access can be revoked.** A guest's private reconnect token is now invalidated when they truly leave (after the rejoin grace window), so a departed guest can no longer silently auto-reconnect. **"New link" now fully resets access** — it disconnects current guests and revokes all old tokens, so re-inviting really does lock out everyone who had the old link.
- **Join is pinned to the tunnel host.** Joining a peer (whose handle comes from a shared, collaborator-writable branch) only accepts a `*.trycloudflare.com` (or localhost) origin, and the join window is locked against navigating away or opening popups — closing an arbitrary-origin / token-exfiltration vector.
- **Session bootstrap fails safe.** `session.sh` now aborts if it can't create or enter its session directory, instead of launching Claude with permissions disabled in the wrong directory.

### Reliability (bugs)
- Fixed a workspace/foreground-tab state desync that could read sessions/diffs for the wrong directory.
- Guarded terminal output sends against window-close races.
- Background pollers are now torn down on window close.
- Each diff revert/discard uses its own temp file (no more cross-action races).
- Settings now persist through a synchronous write path, closing the force-kill window.
- Voice/chat no longer replay old turns when a tab's session process restarts.

### Robustness
- Shell scripts report honest success/failure instead of silently succeeding; a missing `python3`/`gh` is surfaced as an error rather than masquerading as "empty".
- The local voice services start/health-check more robustly and recover from an occupied port.
- Synced session deletions (tombstones) survive a sync merge conflict.
- The renderer surfaces a toast on user-initiated failures instead of failing silently; removed a temporary diagnostics handler.

### UI
- Decluttered the top bar (per-session **tokens stay visible**; session **cost moved into the context-bar tooltip**).
- Unified the voice controls and naming everywhere: **Talk** / **Speak** / **Auto-speak**, with a real on/off toggle.
- The command bar now shows a visible scrollbar + arrows so all commands are discoverable; `/clear` is tinted as destructive.

## [0.1.0]
- Initial release.
