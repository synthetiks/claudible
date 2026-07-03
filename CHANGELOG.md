# Changelog

All notable changes to Claudible are documented here.

## [0.7.0] — 2026-07-03

### Session history grew up — and is now ON by default
- **Live multiplayer feed:** the per-prompt history streams to connected guests (full log on join, per-entry updates live) — a joined cockpit shows "Session History · from the host". Same privacy rules as the terminal mirror: private workspaces never leave the machine.
- **"Changes: 3 files (+42/−10)"** on every entry (per-file breakdown on hover), computed when the turn settles.
- **The first prompt is revertable** (a checkpoint now seeds at session start, not after the first full turn), and entries authored on another machine hide their Revert button (their snapshots live in that machine's clone).
- `sessionHistory` **defaults on**; explicit off still respected.

### The model knows who's talking (multiplayer identity)
- Every turn now tells the embedded Claude **who typed the prompt** (host vs a named co-driving guest), **which machine** it's on (stable machine-id + both hostname views), and **which Claudible flavor** is running (WSL / native Windows / Linux). No more addressing the host while a guest is driving, or stale machine identity after a synced transcript.

### Session switching fixed (the "empty session" bug)
- The resume fallback can no longer mistake a tab-switch **kill** for a resume **refusal** — the thing that minted multiplying "(empty session)" stubs.
- Killed tabs' WSL-side processes are now **actually reaped** (ConPTY kills never crossed the WSL boundary; zombies survived for days), including a startup sweep for crash leftovers — and each session generation gets its own runtime dir so a zombie can never pollute the live tab's telemetry.
- Promptless stub sessions are hidden from the session picker and refused by sync in both directions.
- A slow workspace clone can no longer stomp the session you just clicked.

### Permissions you can trust
- A permission-mode change that fails to save **says so** (and the registry write is now atomic) instead of silently reverting on relaunch.
- The status bar always shows the active mode (`perms: ask first / auto-accept edits / bypass`).
- The native-Windows runner now prints the collaborator-session sandbox notice instead of sandboxing silently.

### Agents cockpit
- Every agent tile shows **which model runs it** (fable 5 / sonnet 5 / opus 4.8 …), read live from the agent's transcript.

### Public-beta hygiene
- SECURITY.md rewritten to match the shipped app (real network-surface map, the actual permission model, private vulnerability reporting); README/SETUP/docs scrubbed of private-repo instructions and stale "pending" claims; Linux window icon + "Git for Windows" label fixed off-Windows.

## [0.6.0] — 2026-07-02

A big feature + polish release: a full session-history/revert system, a visual redesign, and a large security & reliability pass.

### Session History + one-click Revert (new, ships behind the `sessionHistory` setting)
- A per-prompt **activity feed** in the Repo Review drawer — who drove each turn, when, on which machine — built on a single append-only event log.
- **Git-backed per-prompt checkpoints** with a **one-click Revert** (and an Undo): roll the working tree back to the code as it was going into any of the last 10 prompts. Reversible — it snapshots the current tree first, and never touches gitignored files or your commits.

### Redesign
- **Soft-seam UI** — regions separate by stepped background shades instead of hard borders; chips became quiet filled pills.
- **Frameless "blackboard" terminal** — the terminal reads as the app's own surface, not a card in a card; sleeker command bar + tighter spacing.
- **Live Agents cockpit** — watch a subagent/workflow swarm think in parallel: type-hued tiles, each with a live "current tool" line, over a telemetry hero (running/done/tokens). The parallelism a bare terminal can't show.
- **Elevated all 6 themes** — vivid, mutually-distinct green/blue accents and deeper contrast, WCAG-validated (ink ≥ 15:1, accents ≥ 4.5:1). Fixed themes where green and blue had collapsed into one color.
- **Live runtime identity** injected into the model's context each turn (which machine/user, live-session state) — so a transcript synced from another machine no longer confuses the model.

### Security & reliability
- **Live share:** a kicked guest can no longer regain access via a still-valid resume token; presence now clears on the workspace you actually advertised on; host-controlled peer strings are escaped in the UI; relayed voice frames are size-capped.
- **Session history:** co-drive prompts are attributed to the guest who typed them (not the host); a stale checkpoint ref is cleared when the setting toggles.
- **Voice:** STT/TTS calls now time out instead of hanging ~5 min on a stuck local service; the mic-blocked state surfaces in embedded browsers.
- **Sync/diff:** the diff is bounded by bytes (multibyte diffs no longer vanish); a deleted workspace's debounced push is cancelled; the out-of-sync resolve targets the right workspace.
- **Terminal:** an unfocused text selection no longer shows a stray grey highlight band.

## [0.5.4] — Frictionless install

Making a fresh install "paste one line and go," to production standards.

### Install
- **No compiler, no Python, no Visual Studio Build Tools.** `node-pty` — the one native module — ships ABI-stable **N-API** prebuilts that load under Electron unchanged, so the forced `electron-rebuild` step was a no-op left over from node-pty's pre-N-API (0.x) days — and the *sole* reason the install pulled in a multi-GB C++ toolchain (and, via node-gyp, Python). Removed it; `install.ps1` now just verifies the shipped prebuilt for your CPU arch is present. Proven safe: the npm-published prebuilt is **byte-identical** to the binary this app already runs on under Electron 42. (A source build stays available as `npm run rebuild` for the rare arch with no prebuilt.)
- **Self-bootstrapping one-liner.** The install command installs **Git for Windows** via winget if it's missing (refreshing PATH in-session) and lets you **choose the install folder** (Enter for the default) — one paste, with no prerequisites beyond WSL2 + a signed-in Claude Code.
- **Antivirus quarantine self-diagnoses.** Some antivirus engines false-positive on `install.ps1` and quarantine it; the installer now detects the resulting gap and prints plain-English recovery (allow the folder → `git restore install.ps1` → re-run) instead of a cryptic "file not found," with per-AV steps in SETUP.md.

### Cross-OS portability (the multi-OS conversion)
- **The runtime script fleet no longer needs `python3`.** The 8 helper scripts shelled out to `python3` for their JSON transforms (session list, transcript, diff, workflows, agent-tokens, plugins, skills, sync-titles). All 9 transforms were ported to Node (`wsl/*-tool.js`), so the scripts now need only Node — which already runs the app and the hooks. This unblocks the native-Windows backend (Git for Windows ships no Python) and drops a prerequisite for the terminal/telemetry/agents/workspaces path on **every** OS. (The optional local **voice/TTS** stack — Kokoro — still uses Python; `setup.sh` provisions it. That's a separate, opt-in concern from the core app.) The port is **byte-faithful**: `test/port-parity.sh` diffs each new Node helper against the original `python3` across 14 deliberately-nasty fixtures (emoji/astral surrogate escaping, CJK, malformed JSON lines, conditional keys + ordering, binary diffs, multi-commit logs, base64 with BOM+control chars, a git-fixture title-read, cross-engine cache) — 14/14 identical under both node 18 and the shipping node 22. (Removed 441 lines of inline Python.)
- **One-click installers via electron-builder.** A packaging config (`package.json#build`) + CI matrix (`.github/workflows/build.yml`) produce a Windows NSIS installer (you pick the folder), a Linux AppImage/deb, and a macOS dmg — no git clone, npm, or build toolchain for end users. `asar: false` keeps the bash scripts + Node helpers + hooks readable on disk (they're executed by PATH). The Linux target is **built + layout-verified locally** (electron 42, node-pty bundled, the right files included/excluded); Windows/mac artifacts build in CI.
- **Native Linux + macOS backends.** A `Runner` seam routes every OS-coupled call through `runners/{wsl,posix,win}.js`; the Posix backend is live-tested on Linux (runScript + a real node-pty spawn). macOS shares it (one documented non-UTF-8 diff caveat tracked for when the dmg ships).
- **WSL-free native-Windows path (authored, smoke-gated).** `install.ps1 -Native` provisions native Windows Claude Code + the prebuilt voice services (`setup/setup-win.ps1`: the A0-proven `whisper-server.exe` with no compiler, + Kokoro on CPU torch) and pins the `win` runner. Download URLs + zip layout + the npm package are verified against live sources; the PowerShell is AST-parsed clean. The end-to-end native install + voice runtime still need a Windows smoke test (`docs/SMOKE.md`) — the WSL path remains the proven default.

## [0.5.3] — 2026-06-26
- Fixed session-sync setup failing on native Windows ("could not set up sync", missing sessions) — the same literal-`/c/…` path root cause as 0.5.2, one level deeper in git's config.

## [0.5.2] — 2026-06-26
- Custom workspace folders land where you chose them on native Windows (a `C:\Games\…` pick no longer becomes `C:\c\Games\…`): paths now cross the MSYS boundary in mixed `C:/…` form.

## [0.5.1] — 2026-06-26
- Desktop shortcut is created reliably on every install; Claude-connect detection works when native Windows keeps credentials in Credential Manager; clone failures surface a real error instead of silence.

## [0.5.0] — 2026-06-25
- **Cross-device workspace sync**: make a local workspace synced (and shareable) in one click, GitHub-backed; fast one-call discovery of your synced workspaces on any device. Engine live-tested against real GitHub.

## [0.4.0] — 2026-06-25
- **First-run Get-Started wizard**: connect Claude → pick a workspace → connect GitHub, shown once — replacing the cold open.

## [0.3.1] — 2026-06-24
- Fixed the first real native-Windows install crash (CreateProcess error 193): `claude` now resolves to a runnable `.cmd`/`.exe`, not npm's extensionless shim.

## [0.3.0] — 2026-06-24
- **Claudible ships as a prebuilt Windows installer** — double-click `.exe`, no clone/npm/PowerShell — while the git-clone path stays for devs, Linux, and terminal users.

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
