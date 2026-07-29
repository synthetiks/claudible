# Architecture

Claudible is a thin, local cockpit around the **real Claude Code CLI**. It doesn't reimplement Claude Code — it embeds it and adds voice + a live meter.

## The pieces
> Cross-platform note: the descriptions below use the **WSL backend** (the reference implementation) for
> concreteness. Every OS-coupled call actually routes through the `Runner` seam (`runners/{wsl,win,posix}.js`)
> — see **Platform** at the bottom — so "spawns `wsl.exe`" means "spawns via the active runner," which is
> `wsl.exe` on WSL, `claude.exe`/git-bash natively on Windows, and `bash -lc` on Linux/macOS.

- **Electron app** — `main.js` (main process), `preload.js` (context-isolated bridge), `renderer/` (the UI: tab strip + sidebar + terminal + voice controls + meter + command palette).
- **Embedded terminal** — `node-pty` spawns the runner's shell (`wsl.exe -e bash -lc "<bootstrap>"` on the WSL backend), rendered with **xterm.js**. You see and drive the real Claude Code TUI.
- **Tabs** — the app is multi-tab: each tab owns its **own** pty, its own Claude Code session, and its own runtime dir. `main.js` keeps a per-tab record (`{ proc, ws, session, runtimeId, busy, … }`) and tracks which tab is in the foreground; everything below that says "the session" means "that tab's session".
- **Bootstrap** — `wsl/session.sh` installs a statusLine + `Stop`/`UserPromptSubmit` hooks into a dedicated session dir (kept out of your repos and global `~/.claude`; `wsl/_ws-dir.sh` is the single resolver: `~/.claudible/workspaces/<slug>` for a local project, `~/.claudible/repos/<slug>` for a synced repo, an explicit saved path if one is set, and `~/.claudible/session` for a pre-workspaces install), then launches the real `claude`. Each project therefore has its own cwd, so Claude Code's per-cwd history isolates for free.
- **Voice services (WSL)** — `wsl/services.sh` keeps local **Whisper** (STT :2022) and **Kokoro** (TTS :8880) running; `setup/setup.sh` installs them.
- **Live share** — `share/server.js` (an in-process HTTP/WS server) + `share/cloudflared.js` (a quick tunnel) serve `share/guest.html` + `share/guest.js`: a read-only-by-default browser view of one tab's terminal, with chat and voice. `relay/worker.js` is an optional Cloudflare Worker for peer presence and **ships inert** — no `CLAUDIBLE_RELAY_URL`, no connections (see `relay/README.md`).
- **Self-update** — `lib/selfUpdate.js` pulls and relaunches a **clone** install in place (packaged installs have no in-app updater). `lib/buildIdentity.js` captures the running build's git sha at boot, which is what surfaces build drift between two collaborators.

## The three planes
1. **INPUT** — mic → main process → local Whisper → text → `pty.write()` into the live TUI. Hold **Left-Alt** (push-to-talk) or click **Talk**.
2. **OUTPUT** — Claude Code's `Stop` hook appends the reply to that tab's `hooks.ndjson` → the app reads it → local Kokoro speaks it.
3. **METER** — Claude Code's statusLine writes that tab's `status.json` → the app polls it → context % / cost / tokens / plan usage.

## Why files for the bridge
The bridge files live on the **Windows** filesystem so the Electron app reads them natively, avoiding the flaky `\\wsl.localhost` (9P) file-watch boundary. The app passes its **own folder** to `session.sh` (converted with `wslpath`), so there are **no hardcoded paths** — it works for any user and install location. The session `.jsonl` is buffered by Claude Code, which is why live output comes from hooks, not the transcript.

They are **per spawn**, not global — `runtime/tabs/<runtimeId>/{status.json,hooks.ndjson,context.json}`, where `runtimeId` is `<tab>-g<boot-nonce>-<n>`, minted fresh on every pty spawn (`main.js`, `nextRuntimeId()`). Two reasons: concurrent tabs must not truncate or interleave each other's streams, and a killed generation's WSL-side writer outlives the ConPTY kill — giving each generation its own directory means a zombie can never bleed into the session on screen; the app simply stops reading the old dir and reaps it. `session.sh` exports `CLAUDIBLE_STATUS`/`CLAUDIBLE_HOOKS`/`CLAUDIBLE_CONTEXT` so the shared hook and statusline scripts resolve each tab's paths at runtime from that tab's own environment. A packaged Windows build additionally relocates the whole of `runtime/` under `~/.claudible` via `CLAUDIBLE_RUNTIME`, since the installed app dir is read-only.

## Privacy
Speech-to-text and text-to-speech are **local** (localhost services). No cloud speech, no telemetry from Claudible. The only things written to disk are ephemeral session state under `runtime/` (gitignored) and whatever you explicitly export with **Save Session**. The embedded **Claude Code** still sends prompts/code to Anthropic exactly as the normal CLI does — Claudible doesn't intercept or change that. The embedded session's permission mode is a Settings choice — default is normal ask-first prompting; *auto-accept edits* and *bypass* (`--dangerously-skip-permissions --add-dir $HOME`) are opt-in, and a collaborator-synced session is always sandboxed regardless (see the README's *Security & privacy* section).

## Platform
Windows (WSL2 or native), Linux, and macOS. Every OS-coupled call routes through the `Runner` seam (`runners/{wsl,win,posix}.js`): the WSL backend spawns `wsl.exe` + `wslpath`, native Windows drives `claude.exe` under ConPTY with the script fleet on git-bash, and the Posix backend spawns `bash -lc` directly (macOS shares it). node-pty, xterm.js, the hooks/status bridge, and the OpenAI voice contract are cross-platform.
