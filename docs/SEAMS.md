# Claudible — Seam Map (Part 0, step 0.1 deliverable)

> **📜 Historical snapshot.** This seam map was the Part-0 inventory taken BEFORE the Runner refactor; every call site listed here has since been routed through `runners/{wsl,win,posix}.js`. Kept as the contract reference.

This document is the **contract for the Runner refactor** (`OS-CONVERSION-PLAN.md` §0.2–0.3). It
inventories every OS-coupled call site in the codebase — today they are all unconditionally
**Windows + WSL** (there is *zero* runtime OS detection anywhere: `process.platform` / `os.platform`
/ `os.type` have **no occurrences** in the source, which is exactly why a `Runner` abstraction is
needed). Each seam is assigned to **one owning Runner method**. After step 0.3, a re-grep for
`wsl.exe`, `wslpath`, `/mnt/c`, `USERPROFILE`, or a platform branch **outside `runners/`** must
return zero hits — that grep is the acceptance gate. The method list in §3 is the canonical §0.2
interface, now backed by evidence; the flat checklist in §4 is the superset the refactor ticks off
(and the basis for the seam count). **Confirmed clean (no seams, do not touch):** `preload.js`
(pure IPC bridge — grep for `wsl.exe|wslpath|/mnt|process.platform|cloudflared|USERPROFILE` returns
nothing), `share/server.js` (binds loopback `127.0.0.1`, Node only), `share/voice-core.js`,
`renderer/*` (IPC + `localhost` audio API only).

> **Dedup rule:** each unique `file:line` appears as a table row **once**, under its primary owning
> method. Genuinely cross-cutting helpers (`wsEnv`, `buildBoot`, the `wslpath` init at `main.js:95`)
> are listed once and cross-referenced, never duplicated. The 23 `runTool` script invocations are
> grouped by script in the §7 table but enumerated line-by-line in the §4 checklist.

---

## 1. `spawnClaude(tabId, { cols, rows, cwd, session, ws }) → ptyProcess`

Launch a Claude Code session inside a PTY. Owns the spawn target, the bootstrap-command
construction, and the home/cwd selection. `buildBoot` + `wsEnv` are construction helpers it owns
(also referenced by `runTool` — see cross-ref).

| file:line | what it does | OS coupling | WSL today | native-Windows needs | native-Posix needs |
|---|---|---|---|---|---|
| `main.js:237` | `nodePty.spawn('wsl.exe', ['-e','bash','-lc', buildBoot(...)])` — spawns the live Claude TUI | hardcoded `wsl.exe`; `-e bash -lc` gateway syntax; ConPTY agent (AttachConsole crash guarded by `patches/node-pty`) | spawn `wsl.exe` → `bash -lc` → `session.sh` → `claude` | ConPTY → resolve `where claude` (`.cmd`/native shim), spawn via `cmd /c claude` or the JS entrypoint; arg-quote `--add-dir` | `bash -lc 'claude …'` directly (login shell so `claude` is on PATH); no wrapper |
| `main.js:238` | PTY options: `name='xterm-256color'`, `cols/rows`, `cwd: process.env.USERPROFILE`, `env: process.env` | `USERPROFILE` is Windows-only; ConPTY-specific dim-ANSI preservation | cwd = Windows `%USERPROFILE%` | cwd = `%USERPROFILE%` | cwd = `$HOME` |
| `main.js:112–121` | `buildBoot(session, ws, tabId)` — builds the `bash -lc` boot string: inlines `CLAUDIBLE_SESSION/EFFORT/TAB` + `wsEnv(ws)`, then `bash '$APPDIR_WSL/wsl/session.sh' '$APPDIR_WSL'` | `${}` expansion, `bash -lc`, `session.sh` path interpolation, falls back to an `echo` if `APPDIR_WSL` is null | constructs the WSL bash command | construct a Windows command (`cmd /c` / direct `claude.exe` with `--add-dir %USERPROFILE%`) — no `session.sh` once hooks are Node (0.5) | construct a `bash -lc 'claude …'` command directly |
| `main.js:103–110` | `wsEnv(ws)` — builds the env prefix `CLAUDIBLE_WS_KIND/SLUG/DIR` for bash interpolation (slug sanitized `[A-Za-z0-9-]`, custom path must be single-quote-free) | bash syntax (`VAR='val'`); assumes `ws.path` is already a guest-side path | inlined into the `bash -lc` string | format as `set VAR=val` / `%VAR%` (cmd) or pass via spawn `env` | bash `VAR='val'` unchanged |
| `wsl/session.sh:103–148` | Claude exec: `resume_one()` / `FRESH` arrays — `claude --dangerously-skip-permissions --resume <id> --add-dir "$HOME"`; foreign sessions drop skip-perms and `--add-dir`; `EFF[@]` effort array | bash array syntax, `exec` builtin, `$HOME`, `--dangerously-skip-permissions`, `--add-dir` quoting | runs inside `session.sh` in WSL | the same flags via Windows `claude`, home = `%USERPROFILE%` | same flags via host `claude`, home = `$HOME` |
| `wsl/session.sh:15–22` | `SDIR` computation: `~/.claudible/{workspaces,repos,session}/<slug>` or custom `$CLAUDIBLE_WS_DIR` | `$HOME` expansion; custom-path override; slug validation | POSIX `$HOME` paths in WSL | `%USERPROFILE%\.claudible\…` | `$HOME/.claudible/…` (identical) |

> **Cross-ref:** `buildBoot`/`wsEnv` also feed `runTool` (§7). They are owned here; `runTool`
> reuses the same env-formatting logic.

---

## 2. `runtimeDir() → string`

Absolute path of the runtime root where hooks write `tabs/<id>/status.json` + `hooks.ndjson`, and
where main reads them natively. Today this is the app dir's `runtime/` on the Windows FS (read
natively, **not** over the 9P `\\wsl.localhost` boundary), while `session.sh` writes to the same
folder via the `/mnt/c` path passed as `$APPDIR`. The seam is the **host↔guest coordination**: main
reads host-native, scripts write guest-side; both must resolve to the same bytes.

| file:line | what it does | OS coupling | WSL today | native-Windows needs | native-Posix needs |
|---|---|---|---|---|---|
| `main.js:81` | `const RT = path.join(__dirname, 'runtime')` — runtime root; pollers read `tabs/<id>/status.json` + `hooks.ndjson` here | app-dir on Windows FS; written from WSL via `$APPDIR`, read natively by main | `<app>\runtime` (host) ↔ `/mnt/c/…/runtime` (guest) | `%USERPROFILE%\.claudible\runtime` (single OS, no translation) | `$HOME/.claudible/runtime` (single OS, no translation) |
| `main.js:86` | `SETTINGS_FILE = path.join(RT, 'settings.json')` — durable username + renderer prefs (sync write) | depends on `RT` being correct per OS | under host `runtime/` | under native runtime dir | under native runtime dir |
| `main.js:130` | `WORKSPACES = path.join(RT, 'workspaces.json')` — workspace registry persistence | depends on `RT` | under host `runtime/` | native | native |
| `main.js:123, 125` | `fs.mkdirSync(RT)`; sweep orphaned `diffaction-*.tmp` via `readdirSync(RT)` + `unlinkSync` | depends on `RT`; fs ops cross-platform | host `runtime/` | native | native |
| `main.js:999` | `fs.readFileSync(path.join(RT,'tabs',rec.runtimeId,'status.json'))` — status poller | path must match where hooks write status | host FS read of WSL-written file | native read of native-written file | native read |
| `main.js:1049` | `fs.openSync/readSync(path.join(RT,'tabs',rec.runtimeId,'hooks.ndjson'))` — hook poller with offset cursor + truncation detect | path must match hook output location | host FS read of WSL-written ndjson | native | native |
| `main.js:1064` | `fs.appendFileSync(path.join(RT,'tabs',rec.runtimeId,'hooks.ndjson'), …)` — test hook injection | depends on `RT` | host append | native | native |
| `main.js:1188` | `const tmp = path.join(RT, name)` — diff-action temp file (then handed to `diff-apply.sh` as a guest path, see §7) | host temp path that must be translatable to a guest path | written host-side, passed as `$APPDIR_WSL/runtime/<name>` | native temp + native arg | native temp + native arg |
| `wsl/session.sh:25, 32–34` | `APPDIR="${1:?…}"`; `RT="$APPDIR/runtime/tabs/$TAB"`; `STATUS/HOOKS` derived; exported as `CLAUDIBLE_STATUS/HOOKS` | guest-side `/mnt/c` path from `buildBoot`; per-tab isolation | guest writes to `/mnt/c/…/runtime/tabs/<tab>` | hooks (Node, 0.5) write to native runtime dir passed in | hooks write to native runtime dir passed in |

> **Coordination contract:** `spawnClaude` must pass `runtimeDir()` (translated via `toGuestPath`
> on WSL) as `$APPDIR` so hooks write to the exact `tabs/<id>/` location the pollers read.

---

## 3. `toHostPath(p)` / `toGuestPath(p)` → string

Path translation between the Electron host's filesystem and the runner's execution space. Identity
on every native runner; `wslpath` on WSL.

| file:line | what it does | OS coupling | WSL today | native-Windows needs | native-Posix needs |
|---|---|---|---|---|---|
| `main.js:95` | `APPDIR_WSL = cp.execFileSync('wsl.exe', ['wslpath','-u', __dirname.replace(/\\/g,'/')])` — converts the app dir `C:\…` → `/mnt/c/…` for all guest-side script args | `wsl.exe` + `wslpath`; backslash→forward-slash (single backslashes are stripped at the WSL arg boundary); `/mnt/c` assumption | `wslpath -u` transform | identity (`__dirname` is already native) | identity |
| `main.js:814` | `wslpath -u res.filePaths[0]` — user-picked folder (workspace **accept-invite** clone dir) → guest path | `wsl.exe`+`wslpath`; Electron dialog returns `C:\…` | `wslpath` reverse | identity | identity |
| `main.js:861` | `wslpath -u res.filePaths[0]` — user-picked folder (workspace **create** parent dir) → guest path | `wsl.exe`+`wslpath`; dialog `C:\…` | `wslpath` reverse | identity | identity |

> **Cross-ref:** the `.replace(/\\/g,'/')` normalization at `95/814/861` is internal to these
> calls. `dialog.showOpenDialog` / `app.getPath('desktop')` (e.g. export at `main.js:1134/1162`) are
> Electron's own cross-platform abstraction and need **no** Runner method.
> **Open question (8 scripts):** Claude Code's own transcript store
> `$HOME/.claude/projects/<sed-encoded SDIR>` is a *distinct* path seam from app-dir translation —
> see §8.

---

## 4. `installHooks(projectDir) → void`

Write Claude Code `settings.json` + the statusLine/hook command lines for this OS. **Critical
finding:** today this is **fused into the spawn** — `session.sh` regenerates the scripts + settings
on *every* launch as part of the boot string, not a separate setup phase. Part 0.3/0.5 must split
it out. Installation target is the **session-isolated** `$SDIR/.claude` (not global `~/.claude`) —
this is correct for Claudible's isolation model and diverges from the plan's A2/B2 "global" wording
(flag for plan update). Part 0.5 replaces these bash heredocs with `node hooks/*.js`, at which point
`installHooks` returns structured settings JSON instead of generating shell scripts.

| file:line | what it does | OS coupling | WSL today | native-Windows needs | native-Posix needs |
|---|---|---|---|---|---|
| `wsl/session.sh:40` | `mkdir -p "$SDIR/.claude" "$RT"` — create the session-local config + runtime dirs | POSIX `mkdir -p`; `$SDIR`/`$HOME` expansion | bash in WSL | `fs.mkdirSync` (Node) / `CreateDirectory` | `mkdir -p` / Node |
| `wsl/session.sh:44–56` | generate `statusline.sh` (`#!/usr/bin/env bash`, reads stdin, writes `$CLAUDIBLE_STATUS`, formats via `python3`) | bash + `python3` + `chmod +x` | bash heredoc in WSL | Node hook (0.5): `node hooks/statusline.js` | same Node hook |
| `wsl/session.sh:58–66` | generate `hook.sh` (`#!/usr/bin/env bash`, appends one JSON line to `$CLAUDIBLE_HOOKS`, `chmod +x`) | bash + `chmod +x` | bash heredoc in WSL | Node hook (0.5): `node hooks/hook.js` | same Node hook |
| `wsl/session.sh:68–78` | generate `settings.json` — `statusLine` command + `hooks` matchers (`Stop`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse` on `Task\|Agent`), each invoking `bash '$SDIR/.claude/hook.sh'` | command invocation is `bash '…'` (OS-specific); the matchers themselves are Claude schema (portable) | `bash`-invoked scripts in `$SDIR/.claude` | settings at `%USERPROFILE%\.claude\settings.json`, commands = `node <abs>\hooks\x.js` | settings at `~/.claude/settings.json`, commands = `node <abs>/hooks/x.js` |

> **Hidden deps:** `bash` + `python3` + `chmod` are implicit WSL runtime assumptions. The 0.5 Node
> port removes all three. **Output shapes** (`status.json` object, `hooks.ndjson` one-JSON-per-line)
> are portable; the seam is the *invocation method*, not the content.

---

## 5. `startVoiceServices()` / `voiceHealth()`

Bring up / probe whisper (STT) + kokoro (TTS). The renderer reaches them purely over
`http://localhost:2022` and `:8880` (`main.js:79–80`), so **the client is OS-agnostic** — only the
*server launch* and *port-listen probe* are coupled. Today the services run **in WSL** and bind
`0.0.0.0` so the Windows host reaches them across the WSL2 NAT NIC; native runners must bind
`127.0.0.1` (no LAN exposure). The starter (`services.sh`) is distinct from the *installer*
(`setup.sh`, §6).

| file:line | what it does | OS coupling | WSL today | native-Windows needs | native-Posix needs |
|---|---|---|---|---|---|
| `main.js:79–80` | `WHISPER`/`KOKORO` default to `http://localhost:2022` / `:8880` (env-overridable) | hardcoded localhost:port pair; reachability depends on bind host | host reaches WSL NIC at 127.0.0.1 | services bind 127.0.0.1 (same host) | services bind 127.0.0.1 (same host) |
| `main.js:148–154` | `startVoiceServices()` → `cp.execFile('wsl.exe', ['-e','bash','-lc', "bash '$APPDIR_WSL/wsl/services.sh'"])` (async, on window load; idempotent) | `wsl.exe` + bash; `APPDIR_WSL` path | exec `services.sh` in WSL | spawn `whisper-server.exe` + kokoro uvicorn directly (Node) | exec `services.sh` natively on host |
| `wsl/services.sh:9–10` | `listening()` via `ss -tln | grep :PORT` (warns if `ss` absent) — **this is `voiceHealth`** | `ss` (iproute2, Linux); absent on macOS | `ss` in WSL | `netstat`/`Get-NetTCPConnection` | **Linux:** `ss`; **macOS:** `lsof -i`/`netstat` |
| `wsl/services.sh:35–50` | start Kokoro: `cd $VOICE/kokoro && nohup uv run … uvicorn api.src.main:app --host 0.0.0.0 --port $KOKORO_PORT` with `MODEL_DIR/VOICES_DIR/USE_GPU=false/USE_ONNX=false/ESPEAK_DATA_PATH` | `nohup`; bind `0.0.0.0` (WSL NIC); espeak-data search `/usr/lib/x86_64-linux-gnu/espeak-ng-data`, `/usr/share/espeak-ng-data` | bash in WSL | Node-spawned uvicorn, bind 127.0.0.1, espeak via MSI + `ESPEAK_DATA_PATH` | bind 127.0.0.1; **macOS:** espeak-ng-data via Homebrew prefix (Linux paths don't exist) |
| `wsl/services.sh:52–63` | start Whisper: `cd $VOICE/whisper && nohup ./build/bin/whisper-server --host 0.0.0.0 --port $WHISPER_PORT -m models/ggml-base.bin --inference-path /v1/audio/transcriptions --convert` | `nohup`; bind `0.0.0.0`; local build path | bash in WSL | spawn `whisper-server.exe`, bind 127.0.0.1 | bind 127.0.0.1; macOS may use a prebuilt/Metal build |

---

## 6. `setup(opts) → Promise`

Install/build everything for this backend — drives the per-OS installer. The current installer
surface is **all Windows + WSL**. Note the critic's refinement: `setup.sh`/`services.sh` are
**Debian/Linux-specific**, not generic POSIX — `apt-get`+`sudo`, `ss`, and hardcoded espeak-ng-data
paths break on macOS, so the native-Posix column is itself a **Linux-vs-macOS** split.

| file:line | what it does | OS coupling | WSL today | native-Windows needs | native-Posix needs |
|---|---|---|---|---|---|
| `package.json:44` | `"setup": "wsl.exe -e bash setup/setup.sh"` — OS coupling baked into the build manifest | hardcoded `wsl.exe` in npm script | `wsl.exe bash setup.sh` | dispatch a Windows voice-setup (Node: download prebuilt whisper + model + ffmpeg, `uv sync` kokoro) | run `setup.sh` on host (bash) |
| `package.json:45` | `"rebuild": "electron-rebuild -f -w node-pty"` — native-module rebuild | node-pty native ABI | rebuild on Windows | same | same |
| `install.ps1:15–34` | Node 22.12+ check; `winget install OpenJS.NodeJS.LTS`; live-session PATH refresh | PowerShell, winget, `%ProgramFiles%`, registry PATH | one-shot Windows installer | (Windows-native mode of the same installer, `-Native`, skips WSL) | `apt`/`brew` + `npm` installer |
| `install.ps1:42–53` | node-pty prebuilt check: `node_modules\node-pty\prebuilds\win32-$arch\pty.node`; fallback `npm run rebuild` (needs Python 3 + VS C++ BuildTools) | `win32-$arch`, ConPTY prebuilt, MSVC toolchain | verify Windows prebuilt | verify Windows prebuilt | verify `linux-$arch`/`darwin-$arch` prebuilt (see §8 multiarch gap) |
| `install.ps1:55–58` | WSL presence probe: `Get-Command wsl.exe` + `wsl.exe -e true` (working distro) | `wsl.exe` — Windows+WSL only; **this is `detect()`** | gate that WSL exists | native-Windows: detect `where claude`, no WSL gate | detect `claude` on PATH |
| `install.ps1:60–62` | `npm run setup` — drives the WSL voice build | Windows→WSL boundary | runs `setup.sh` in WSL | Windows voice setup | host `setup.sh` (apt) / brew |
| `setup/setup.sh:22–37` | apt prereqs: probe `git cmake make g++ ffmpeg python3 espeak-ng curl`; else `sudo apt-get install …` | **Debian/Ubuntu** `apt-get`+`sudo` | apt in WSL | N/A (Windows uses prebuilts) | **Linux:** apt; **macOS:** `brew install cmake ffmpeg espeak-ng` |
| `setup/setup.sh:38–47` | install `uv` via `curl https://astral.sh/uv/install.sh \| sh`; add `~/.local/bin` to PATH | POSIX curl-pipe-sh (works everywhere) | in WSL | `uv` Windows installer | Linux/macOS unchanged |
| `setup/setup.sh:49–65` | build whisper.cpp: clone, `cmake -B build -S … -DWHISPER_BUILD_SERVER=ON`, `cmake --build … -j`; download `ggml-base.bin` | cmake + C++ compiler | build in WSL | vendor prebuilt `whisper-server.exe` (no compile for users) | **Linux:** build as-is; **macOS:** clang/Xcode CLT, optional `-DWHISPER_METAL=ON`, or vendor prebuilt |
| `setup/setup.sh:67–89` | Kokoro: clone `Kokoro-FastAPI`, `uv sync --extra cpu` (CPU torch), download weights via `download_model.py` | `uv` + CPU torch wheels | in WSL | `uv sync` on Windows (cpu wheels exist) | Linux/macOS `uv sync` (arm64 + x64 wheels) |
| `patches/node-pty+1.1.0.patch` | guards `conpty_console_list_agent.js` `getConsoleProcessList()` against AttachConsole crash under Electron (applied by `postinstall`/patch-package) | **Windows/ConPTY only**; inert on POSIX | applied at install | applied (Windows-native still ConPTY) | not applied (no ConPTY) — see §8 |

> **cloudflared binary resolution** (`share/cloudflared.js`) is owned by `runTool` (§7), not `setup`.

---

## 7. `runTool(name, args, opts) → Promise<{ok, stdout, stderr, …}>`

Invoke git/gh/cloudflared and the workspace/session/sync/diff bash scripts. **23** of the WSL
`cp.execFile` call sites are this method. The actual git/gh coupling lives *inside* the scripts
(e.g. `sessions-sync.sh` does `gh api user`); `main.js` only orchestrates the shell-out, so the
seam here is the **launcher** (`wsl.exe` + `bash -lc` + `APPDIR_WSL` + `wsEnv`). Grouped by script
below; every individual line is enumerated in the §4… §9 checklist.

| script (via `runTool`) | call sites (`main.js`) | what it does | WSL today | native-Windows / native-Posix |
|---|---|---|---|---|
| `sessions.sh` | 56, 562 | list saved sessions (guest browse + active ws) | `wsl.exe bash sessions.sh` | invoke `bash`/Node directly; scripts run on host OS |
| `transcript.sh` | 66, 1151 | fetch a session transcript (browse + export) | `wsl.exe bash transcript.sh '$sid'` | host bash / Node |
| `sessions-sync.sh` | 487, 585, 635 | presence advertise / sync-delete / pull-push over git worktree | `wsl.exe bash sessions-sync.sh …` | host git+gh |
| `delete-session.sh` | 579 | delete a saved session locally | `wsl.exe bash delete-session.sh '$sid'` | host bash |
| `session-keep.sh` | 599 | keep a collaborator-deleted session locally | `wsl.exe bash session-keep.sh '$sid'` | host bash |
| `clone-workspace.sh` | 708 | clone an invited repo workspace (`gh repo clone`) | `wsl.exe bash clone-workspace.sh …` | host git+gh |
| `sessions-discover.sh` | 724 | discover invited workspaces via `gh` API | `wsl.exe bash sessions-discover.sh` | host gh |
| `create-workspace.sh` | 833 | create local/repo workspace (`git init`/`gh repo create`) | `wsl.exe bash create-workspace.sh …` | host git+gh |
| `delete-workspace.sh` | 902 | soft-delete a workspace folder | `wsl.exe bash delete-workspace.sh …` | host bash |
| `repo-invite.sh` | 932 | add a GitHub collaborator (`gh` API) | `wsl.exe bash repo-invite.sh …` | host gh |
| `skills.sh` | 942, 953 | list / set Claude skills | `wsl.exe bash skills.sh …` | host bash |
| `plugins.sh` | 961, 969, 980 | list / available / toggle plugins | `wsl.exe bash plugins.sh …` | host bash |
| `agent-tokens.sh` | 1025 | poll subagent token consumption | `wsl.exe bash agent-tokens.sh '$sid'` | host bash |
| `workflows.sh` | 1076 | poll workflow/swarm agent state | `wsl.exe bash workflows.sh '$sid'` | host bash |
| `diff.sh` | 1173 | list git diffs in active workspace | `wsl.exe bash diff.sh` | host git |
| `diff-apply.sh` | 1190 | apply/discard a patch (temp file `$APPDIR_WSL/runtime/<name>`, see §2:1188) | `wsl.exe bash diff-apply.sh $mode '…'` | host git + native temp path |

**cloudflared lifecycle** (also `runTool` / a `startTunnel` wrapper):

| file:line | what it does | OS coupling | WSL today | native-Windows / native-Posix |
|---|---|---|---|---|
| `share/cloudflared.js:17–18, 24–26` | `WINGET_REL` winget path `…\Cloudflare.cloudflared_…\cloudflared.exe`; probed under `%LOCALAPPDATA%` | `%LOCALAPPDATA%`, winget path, `.exe` | winget/`%LOCALAPPDATA%` probe | Windows: same; **Posix:** `cloudflared` on PATH (brew/apt) |
| `share/cloudflared.js:28` | candidate list pushes `'cloudflared.exe'` then `'cloudflared'` (Node spawn won't auto-append `.exe`) | `.exe` ordering | `.exe` first | bare `cloudflared` |
| `share/cloudflared.js:37` | `cp.spawn(bin, ['tunnel',…,'--url', …], { windowsHide: true })` | `windowsHide` (Windows-only flag, harmless elsewhere) | spawn with `windowsHide` | same spawn, flag inert on Posix |
| `main.js:451–456` | `startCloudflared(port)` — spawn tunnel, capture URL, attach exit listener | binary resolution via `cloudflared.js` | Windows binary | native binary |
| `main.js:468, 1212` | `cloudflaredProc.kill()` on `share:stop` / app quit | `process.kill` (cross-platform); binary path is the coupling | kill ChildProcess | same |

---

## 8. Packaging / launcher / install-time seams — **no Runner method**

These are OS couplings outside the runtime Runner contract (distribution, desktop integration,
line-endings, native-module packaging). They are tracked here so the refactor neither force-fits
them into `setup()` nor loses them. They appear in the §9 checklist under a separate bucket.

| file:line | what it does | OS coupling | native-Windows / native-Posix |
|---|---|---|---|
| `launch/claudible.ps1:5` | `wsl.exe wslpath -u` app-path translation (`\`→`/`) | `wsl.exe`+`wslpath` | Windows: identity; Posix: a shell launcher |
| `launch/claudible.ps1:8` | bring up voice via `wsl.exe -e bash -lc "bash '$appWsl/wsl/services.sh'"` | `wsl.exe`+bash | native voice start (see §5) |
| `launch/claudible.ps1:11–12` | launch Electron detached: `Start-Process cmd.exe /c npm start -WindowStyle Hidden` | `cmd.exe`, `Start-Process` | Posix: shell launcher invoking electron |
| `launch/make-shortcut.ps1:1–16` | Desktop `.lnk` via `WScript.Shell` COM; `[Environment]::GetFolderPath('Desktop')`; `powershell.exe` TargetPath → `claudible.ps1`; `assets\claudible.ico` (fallback `electron.exe,0`) | Windows COM, `.lnk`, `.ico` | macOS `.app`/alias; Linux `.desktop`; or no-op |
| `main.js:166` | `path.join(__dirname,'assets','claudible.ico')` — window icon | `.ico` is a Windows convention | `.png` on Linux/macOS (non-critical) |
| `.gitattributes:3–4` | force `*.sh` / `*.patch` to `eol=lf` so a Windows clone (`core.autocrlf=true`) doesn't inject CRLF (breaks bash `\r`, blocks patch-package) | clone/distribution-layer coupling | preserve LF when shipping bash scripts to any OS |
| `main.js:157` | pty loader falls back to `require('node-pty-prebuilt-multiarch')`, **but that package is NOT in `package.json`/lock** — the multiarch fallback can never load as shipped | packaging gap, not a branch | a cross-OS runner must actually declare/install a multiarch pty backend |
| `wsl/agent-tokens.sh:18`, `delete-session.sh:23`, `session.sh:91`, `sessions.sh:20`, `sessions-sync.sh:40`, `session-keep.sh:22`, `transcript.sh:22`, `workflows.sh:27` | `PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" \| sed 's#[^A-Za-z0-9]#-#g')"` — Claude Code's own transcript store + cwd→dirname encoding (8 scripts) | `$HOME/.claude/projects` + the sed encoding must match Claude Code's encoder on the target OS | `%USERPROFILE%\.claude\projects` on Windows-native; `$HOME` on Posix. **Open question:** a `claudeProjectsDir(sessionDir)` helper *could* own this, but it lives inside the bash scripts that 0.5 ports to Node — resolve there, not as a top-level interface method |

---

## 9. Derived Runner interface (canonical — ready for `runners/runner.js`)

This is `OS-CONVERSION-PLAN.md` §0.2, now confirmed against the seam evidence above. It is the
**8-method contract** every backend (`wsl.js`, `win.js`, `posix.js`) implements. No new top-level
methods are introduced; every seam above maps onto one of these (packaging/launcher seams in §8 map
to *no* method by design).

```js
// runners/runner.js — the interface every backend implements.
module.exports = {
  id: 'wsl' | 'win' | 'posix',

  // Is this runner usable on this machine? (e.g. WSL: `wsl.exe -e true`; win: `where claude`)
  detect() /* -> boolean | Promise<boolean> */,

  // Launch a Claude Code session in a PTY. Owns buildBoot + wsEnv + home/cwd selection.
  spawnClaude(tabId, { cols, rows, cwd, session, ws }) /* -> ptyProcess */,

  // Absolute path of the runtime root; hooks write tabs/<id>/status.json + hooks.ndjson here,
  // main reads them natively. spawnClaude passes toGuestPath(runtimeDir()) to the bootstrap.
  runtimeDir() /* -> string */,

  // Host<->guest path translation. Identity on native; wslpath on WSL.
  toHostPath(p) /* -> string */,
  toGuestPath(p) /* -> string */,

  // Write Claude Code settings.json + statusLine/hook command lines for this OS.
  // (Today fused into spawn via session.sh; split out in 0.3, Node-ported in 0.5.)
  installHooks(projectDir) /* -> void | Promise<void> */,

  // Bring up / probe whisper(:2022) + kokoro(:8880). Bind 0.0.0.0 on WSL, 127.0.0.1 native.
  startVoiceServices() /* -> void | Promise<void> */,
  voiceHealth() /* -> Promise<{ whisper:boolean, kokoro:boolean }> */,

  // Install/build everything for this backend (drives the per-OS installer).
  setup(opts) /* -> Promise */,

  // Invoke git/gh/cloudflared and the workspace/session/sync/diff scripts.
  runTool(name, args, opts) /* -> Promise<{ ok, stdout, stderr }> */,
};
```

**Open items to record in the plan (not interface changes):**
- `installHooks` writes to the **session-isolated** `$SDIR/.claude`, not global `~/.claude` (plan
  A2/B2 wording says global — update).
- `claudeProjectsDir(sessionDir)` is a *candidate* helper for the 8 `$HOME/.claude/projects` sites,
  but is resolved **inside the 0.5 Node hook port**, not added as a top-level Runner method.
- `node-pty-prebuilt-multiarch` (the multiarch fallback at `main.js:157`) is **not a dependency** —
  a cross-OS runner must add it.

---

## 10. Seam inventory checklist (re-grep target — tick to zero leakage)

Flat list of every OS-coupled `file:line`. After 0.3, a re-grep for `wsl.exe`/`wslpath`/`/mnt/c`/
`USERPROFILE`/platform branches **outside `runners/`** must return nothing. **Seam count basis:**
each line below is one unique `file:line` entry; the total is the `seamCount`.

### spawnClaude (6)
- [ ] `main.js:237` — `nodePty.spawn('wsl.exe', …)` PTY spawn
- [ ] `main.js:238` — PTY opts `cwd: process.env.USERPROFILE`
- [ ] `main.js:112–121` — `buildBoot()` boot-string construction
- [ ] `main.js:103–110` — `wsEnv()` env-prefix construction
- [ ] `wsl/session.sh:103–148` — `claude` exec (resume/fresh, flags, `--add-dir`, effort)
- [ ] `wsl/session.sh:15–22` — `SDIR` computation (`$HOME`/custom path)

### runtimeDir (9)
- [ ] `main.js:81` — `RT = path.join(__dirname, 'runtime')`
- [ ] `main.js:86` — `SETTINGS_FILE`
- [ ] `main.js:130` — `WORKSPACES`
- [ ] `main.js:123, 125` — `mkdirSync(RT)` + orphan-tmp sweep
- [ ] `main.js:999` — status poller read
- [ ] `main.js:1049` — hooks poller read
- [ ] `main.js:1064` — hook test injection append
- [ ] `main.js:1188` — diff-action temp file in `RT`
- [ ] `wsl/session.sh:25, 32–34` — `$APPDIR`/`RT`/`STATUS`/`HOOKS` + exports

### toHostPath / toGuestPath (3)
- [ ] `main.js:95` — `wslpath -u` app-dir init (`APPDIR_WSL`)
- [ ] `main.js:814` — `wslpath -u` accept-invite folder
- [ ] `main.js:861` — `wslpath -u` create-workspace folder

### installHooks (4)
- [ ] `wsl/session.sh:40` — `mkdir -p $SDIR/.claude`
- [ ] `wsl/session.sh:44–56` — generate `statusline.sh`
- [ ] `wsl/session.sh:58–66` — generate `hook.sh`
- [ ] `wsl/session.sh:68–78` — generate `settings.json`

### startVoiceServices / voiceHealth (5)
- [ ] `main.js:79–80` — `WHISPER`/`KOKORO` endpoints
- [ ] `main.js:148–154` — `startVoiceServices()` → `wsl.exe bash services.sh`
- [ ] `wsl/services.sh:9–10` — `ss -tln` port probe (`voiceHealth`)
- [ ] `wsl/services.sh:35–50` — kokoro launch (`0.0.0.0`, espeak paths)
- [ ] `wsl/services.sh:52–63` — whisper launch (`0.0.0.0`)

### setup (11)
- [ ] `package.json:44` — `"setup": "wsl.exe -e bash setup/setup.sh"`
- [ ] `package.json:45` — `"rebuild": electron-rebuild node-pty`
- [ ] `install.ps1:15–34` — Node winget install + PATH refresh
- [ ] `install.ps1:42–53` — node-pty prebuilt check / source-build fallback
- [ ] `install.ps1:55–58` — WSL presence probe (`detect`)
- [ ] `install.ps1:60–62` — `npm run setup` (WSL voice build)
- [ ] `setup/setup.sh:22–37` — apt prereqs (Debian-specific)
- [ ] `setup/setup.sh:38–47` — `uv` install
- [ ] `setup/setup.sh:49–65` — whisper.cpp build + model
- [ ] `setup/setup.sh:67–89` — kokoro `uv sync --extra cpu` + weights
- [ ] `patches/node-pty+1.1.0.patch` — ConPTY AttachConsole guard (Windows-only)

### runTool — scripts (23)
- [ ] `main.js:56` — `sessions.sh` (guest browse)
- [ ] `main.js:66` — `transcript.sh` (guest browse)
- [ ] `main.js:487` — `sessions-sync.sh` (presence advertise)
- [ ] `main.js:562` — `sessions.sh` (active ws list)
- [ ] `main.js:579` — `delete-session.sh`
- [ ] `main.js:585` — `sessions-sync.sh delete`
- [ ] `main.js:599` — `session-keep.sh`
- [ ] `main.js:635` — `sessions-sync.sh` (pull/push)
- [ ] `main.js:708` — `clone-workspace.sh`
- [ ] `main.js:724` — `sessions-discover.sh`
- [ ] `main.js:833` — `create-workspace.sh`
- [ ] `main.js:902` — `delete-workspace.sh`
- [ ] `main.js:932` — `repo-invite.sh`
- [ ] `main.js:942` — `skills.sh list`
- [ ] `main.js:953` — `skills.sh set`
- [ ] `main.js:961` — `plugins.sh list`
- [ ] `main.js:969` — `plugins.sh available`
- [ ] `main.js:980` — `plugins.sh toggle`
- [ ] `main.js:1025` — `agent-tokens.sh`
- [ ] `main.js:1076` — `workflows.sh`
- [ ] `main.js:1151` — `transcript.sh` (export)
- [ ] `main.js:1173` — `diff.sh`
- [ ] `main.js:1190` — `diff-apply.sh`

### runTool — cloudflared (5)
- [ ] `share/cloudflared.js:17–18, 24–26` — winget `%LOCALAPPDATA%` binary path
- [ ] `share/cloudflared.js:28` — `.exe`/bare candidate ordering
- [ ] `share/cloudflared.js:37` — `cp.spawn(… { windowsHide: true })`
- [ ] `main.js:451–456` — `startCloudflared()` spawn
- [ ] `main.js:468, 1212` — `cloudflaredProc.kill()` (stop + quit)

### Packaging / launcher / install-time — no Runner method (8)
- [ ] `launch/claudible.ps1:5` — `wsl.exe wslpath` app-path translation
- [ ] `launch/claudible.ps1:8` — `wsl.exe bash services.sh` voice start
- [ ] `launch/claudible.ps1:11–12` — `Start-Process cmd.exe /c npm start` detached launch
- [ ] `launch/make-shortcut.ps1:1–16` — Desktop `.lnk` via WScript.Shell COM
- [ ] `main.js:166` — `assets/claudible.ico` window icon
- [ ] `.gitattributes:3–4` — `*.sh`/`*.patch` `eol=lf` enforcement
- [ ] `main.js:157` — `node-pty-prebuilt-multiarch` fallback (not in deps — packaging gap)
- [ ] `wsl/{agent-tokens,delete-session,session,sessions,sessions-sync,session-keep,transcript,workflows}.sh` — `$HOME/.claude/projects` transcript store + sed encoding (8 scripts; `agent-tokens.sh:18`, `delete-session.sh:23`, `session.sh:91`, `sessions.sh:20`, `sessions-sync.sh:40`, `session-keep.sh:22`, `transcript.sh:22`, `workflows.sh:27`)

**Total: 74 unique seam entries** (spawnClaude 6 + runtimeDir 9 + path 3 + installHooks 4 +
voice 5 + setup 11 + runTool-scripts 23 + cloudflared 5 + packaging 8).

**Confirmed clean (asserted zero-seam, do not appear above):** `preload.js`, `share/server.js`,
`share/voice-core.js`, `share/guest.js`, `share/replay.js`, `renderer/*`.
