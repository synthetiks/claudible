# Claudible — Master OS Conversion Plan

Goal: take Claudible from **one shippable target** (Windows + WSL) to **four**, by isolating
every OS-coupled call behind a single seam and then implementing that seam per platform. The
WSL path stays the default and untouched until each native path passes the same smoke test.

| # | Config | Electron host | Claude Code + voice run on | PTY reaches them via | Status |
|---|--------|---------------|----------------------------|----------------------|--------|
| 1 | **Windows + WSL** | Windows | Linux (WSL) | `wsl.exe → bash` | ships today (baseline) |
| 2 | **Windows native** | Windows | Windows | `ConPTY → claude.exe` | Part A — the heavy one |
| 3 | **Linux native** | Linux | Linux | `bash` (direct) | Part B — light |
| 4 | **macOS native** | macOS | macOS | `bash` (direct) | Part C — light |

## Guiding principles
1. **Additive, never destructive.** Every change adds a backend; the WSL backend keeps working at
   every commit. A backend ships only after a green smoke test; default flips per-platform, last.
2. **One seam.** All OS-specific code lives behind a `Runner`. If a `grep` finds `wsl.exe`,
   `wslpath`, `/mnt/c`, or a platform branch *outside* `runners/`, the seam has leaked — fix that
   before continuing.
3. **Debug-first.** Every step below has **Do / Verify / If it breaks / Fallback**. A step isn't
   done until *Verify* is green on real hardware.
4. **Flag-gated.** New backends are selected by `CLAUDIBLE_RUNNER=wsl|win|posix` (env override)
   before any auto-detect. You always have a way back to the known-good path.

## What's already cross-platform (the reuse map)
This is why Linux/macOS are "light": most of the app never touches the OS.

| Subsystem | File(s) | Coupling | Action |
|---|---|---|---|
| Terminal UI, voice client, telemetry/agents/share UI | `renderer/*` | **none** — IPC + `localhost` OpenAI audio API | reuse as-is |
| PTY engine | `node-pty` | cross-platform (ConPTY / forkpty) | reuse as-is |
| Share relay server | `share/server.js` | Node | reuse (only the `cloudflared` binary differs) |
| Voice **client** | `renderer/app.js` → `:2022` / `:8880` | none | reuse as-is |
| Voice **server** (whisper + kokoro) | `setup/setup.sh`, `wsl/services.sh` | OS build/run; **same software everywhere** | per-OS build/run |
| Hooks (telemetry/voice/agents) | `wsl/session.sh`, `wsl/workflows.sh` | bash | **port to Node once** (cross-platform) |
| PTY spawn target | `main.js` | `wsl.exe` vs `claude.exe` vs `bash` | Runner |
| Path handling | `main.js` | `wslpath` ↔ native | Runner |
| Tooling | `main.js`, `wsl/*` | git/gh/cloudflared invocation | Runner |
| Installer | `install.ps1` | PowerShell | per-OS installer |

**Key fact:** the renderer reaches voice purely over `http://localhost:2022` and `:8880`. As long as
a backend binds those ports, **voice is unchanged**. Only the *server* is OS-specific, never the client.

---

## The Smoke Test (universal acceptance gate)
Run this **identically** against every backend. A backend is "done" only when all pass on real
hardware for that OS. Keep it as `docs/SMOKE.md` and check it off per target.

1. **Terminal** — Claude Code TUI renders, accepts input, responds; resize reflows; scrollback works.
2. **Voice in** — hold PTT, speak → text lands in the session (whisper `:2022` hit, 200 OK).
3. **Voice out** — a reply is spoken (kokoro `:8880` hit, audio plays).
4. **Telemetry** — context %, cost, tokens update; the context guardrail trips amber→red.
5. **Agents** — spawn a subagent / a 3-agent workflow → the Agents tab shows them live with tools/tokens.
6. **Workspaces** — create a local + a repo workspace; switch; sessions list correctly.
7. **Session sync** — (repo workspace) a rename/new session round-trips via git.
8. **Share / co-work** — start share, approve a guest, read-only + interactive both work; chat + voice room.
9. **Settings persistence** — set the username, force-kill, relaunch → it survived.
10. **Clean exit** — no orphaned `cloudflared`/voice processes after quit.

---

## Part 0 — Foundation (shared groundwork; do once, before A/B/C)

This is the seam. It does **not** add a platform — it makes adding one mechanical. The deliverable
is: WSL still works exactly as today, but every OS-coupled line now lives behind `Runner`.

### 0.1 — Map the seams
- **Do:** `grep -nE "wsl\.exe|wslpath|/mnt/c|process\.platform|\.sh\b|cloudflared" main.js preload.js` →
  produce `docs/SEAMS.md` listing every OS-coupled call site.
- **Verify:** the list is exhaustive — re-grep finds nothing new after you start moving code.
- **If it breaks:** a seam you missed will surface later as a hardcoded Windows assumption on Linux;
  that's why the grep is the contract. Re-run it at the end of 0.3 and expect **zero** hits outside `runners/`.

### 0.2 — Define the `Runner` interface
- **Do:** create `runners/runner.js` with the contract every backend implements:
  - `id` / `detect()` → is this runner usable on this machine?
  - `spawnClaude(tabId, { cols, rows, cwd }) → ptyProcess` — launch a Claude Code session in a PTY.
  - `runtimeDir()` — absolute path where hooks write `tabs/<id>/status.json` + `hooks.ndjson`.
  - `toHostPath(p)` / `toGuestPath(p)` — path translation (identity on native; `wslpath` on WSL).
  - `installHooks()` — write Claude Code `settings.json` + hook command lines for this OS.
  - `startVoiceServices()` / `voiceHealth()` — bring up / probe whisper + kokoro.
  - `setup(opts)` — install/build everything for this backend (drives the per-OS installer).
  - `runTool(name, args, opts)` — invoke git/gh/cloudflared.
- **Verify:** `node -e "require('./runners/runner.js')"` loads; the interface compiles.
- **Fallback:** keep the interface tiny; anything not truly OS-specific stays in `main.js`.

### 0.3 — Extract `WslRunner` (pure refactor, zero behavior change)
- **Do:** move the existing Windows+WSL logic out of `main.js` into `runners/wsl.js` implementing the
  interface. `main.js` now calls `runner.spawnClaude(...)` etc. **No logic changes** — just relocation.
- **Verify:** run the **full Smoke Test** on Windows+WSL. All 10 green = the seam is clean.
- **If it breaks:** any regression here is a relocation bug (a dropped env var, a path no longer
  translated). Diff against the pre-refactor `main.js`; the behavior must be identical.
- **Gate:** do not start Part A/B/C until 0.3's smoke test is 10/10. This is the safety net.

### 0.4 — Runner selection
- **Do:** `runners/index.js` → `selectRunner()`: honor `CLAUDIBLE_RUNNER` env first; else auto-detect
  (Windows → `wsl` for now; later `win` when proven; Linux/macOS → `posix`).
- **Verify:** `CLAUDIBLE_RUNNER=wsl npm start` works; an unknown value fails loudly with the valid set.

### 0.5 — Hooks → Node (the cross-platform multiplier)
- **Why:** the telemetry/voice/agents hooks are bash today. Porting them to **Node** once means
  Windows, Linux, and macOS share *identical* hook logic — no per-OS hook rewrite in A/B/C.
- **Do:** reimplement the hook bodies (the parts of `session.sh`/`conpty`-adjacent logic that write
  `status.json` + `hooks.ndjson`, and `workflows.sh`'s transcript parse) as `hooks/*.js` reading the
  hook JSON on **stdin** and writing the runtime files. Claude Code invokes them as `node <abs>/hooks/x.js`.
  `WslRunner.installHooks()` writes settings pointing at these (via `node` inside WSL).
- **Verify:** on WSL, re-run the Smoke Test items **4 & 5** (telemetry + agents). They must match the
  old bash behavior byte-for-byte (same `status.json` shape, same ndjson lines).
- **If it breaks:** agents tab empty → the `PostToolUse[Task|Agent]` payload shape; telemetry frozen →
  the `Stop`/`UserPromptSubmit` hooks not firing → check `settings.json` path + that `node` resolves
  inside the runner's shell. Token double-count → re-apply the requestId dedup from `workflows.sh`.
- **Decision recorded:** Node hooks are the chosen path (write-once). If a regression risk on WSL is
  unacceptable at this moment, you may defer 0.5 and instead reimplement hooks per-OS in A/B/C — but
  that triples the work; prefer doing it here behind the WSL smoke gate.

**Part 0 deliverable:** adding an OS = writing one `runners/<os>.js` + its installer. WSL untouched.

---

## Part A — Windows native (config 2) — the heavy part

Three subsystems to nativize: Claude Code (ConPTY), hooks (already Node from 0.5), voice (Windows
build/run). Then tooling, installer, flip. **Do A0 first — it's the go/no-go.**

### A0 — Voice-on-Windows feasibility gate (decide first)
- **Why first:** voice is the only piece with real uncertainty. Prove it before building the rest.
- **Do (whisper):** download the **prebuilt** whisper.cpp Windows release (`whisper-bin-x64.zip` from
  `ggml-org/whisper.cpp` releases) → `whisper-server.exe`. Grab `ggml-base.bin` (same model URL as
  `setup.sh`) and a static `ffmpeg.exe`. Run:
  `whisper-server.exe --host 127.0.0.1 --port 2022 -m ggml-base.bin --inference-path /v1/audio/transcriptions --convert`
- **Do (kokoro):** `uv` runs on Windows. `git clone Kokoro-FastAPI`; `uv sync --extra cpu` (CPU torch
  wheels exist for win-x64); `download_model.py`; run uvicorn `api.src.main:app` on `:8880` with the
  same `MODEL_DIR/VOICES_DIR/USE_GPU=false/USE_ONNX=false` env. espeak-ng: Kokoro's bundled loader
  usually suffices; if not, install the espeak-ng Windows MSI and set `ESPEAK_DATA_PATH`.
- **Verify:** `curl -F file=@sample.wav http://127.0.0.1:2022/v1/audio/transcriptions` → text;
  `curl http://127.0.0.1:8880/v1/audio/speech -d '{...}' --output out.wav` → playable wav.
- **If it breaks:** whisper no prebuilt server in the release → build with CMake + MSVC **once** on a
  build box and vendor `whisper-server.exe` (users still download, never compile). kokoro torch wheel
  fails → pin the cpu index URL explicitly; uvicorn won't bind → it's almost always the model path env
  (mirror `services.sh` exactly). espeak crash → install the MSI + set `ESPEAK_DATA_PATH`.
- **GATE:** if native voice is acceptable → Part A proceeds full. If not → Part A ships **terminal +
  Windows Claude Code now**, with voice still served by WSL as a documented interim (`win` runner for
  PTY, `wsl` for voice). Record the decision here.

### A1 — Claude Code via ConPTY
- **Do:** `runners/win.js` `spawnClaude`: detect Windows Claude Code (`where claude` → a `.cmd`/native
  shim). Spawn through node-pty (ConPTY) with `--dangerously-skip-permissions --add-dir %USERPROFILE%`.
  `runtimeDir()` = `%USERPROFILE%\.claudible\runtime`; `toHostPath`/`toGuestPath` = identity.
- **Verify:** `CLAUDIBLE_RUNNER=win npm start` → Smoke Test #1 (terminal). TUI renders, input works.
- **If it breaks:** `claude` not found → PATH detection (also check the npm global + native-installer
  dir). TUI garbled / no color → ConPTY needs the right `cols/rows`; confirm `ptyResize` reaches it.
  Spawning a `.cmd` exits instantly → spawn via `cmd.exe /c claude ...` or resolve the real JS
  entrypoint and spawn `node`. Arg quoting differs from bash — quote `--add-dir` paths.

### A2 — Hooks (reuse 0.5)
- **Do:** `win.js installHooks()` writes `%USERPROFILE%\.claude\settings.json` with statusLine + the
  same Node hook command lines (`node <abs>\hooks\x.js`).
- **Verify:** Smoke Test #4 + #5 (telemetry + agents) under `CLAUDIBLE_RUNNER=win`.
- **If it breaks:** hooks silent → settings path/JSON on Windows; ndjson missing → the hook's cwd/abs
  path resolution; agents empty → tab-id association (how the hook maps a session to a `tabs/<id>`).

### A3 — Voice (wire A0 into the runner)
- **Do:** `win.js startVoiceServices()` launches the A0-proven `whisper-server.exe` + kokoro uvicorn on
  `127.0.0.1:2022/:8880`. A Windows setup path (Node, invoked by the installer) downloads the prebuilt
  whisper + model + ffmpeg and runs `uv sync` for kokoro. Bind `127.0.0.1` (same host — no LAN exposure).
- **Verify:** Smoke Test #2 + #3 (voice in/out) under `CLAUDIBLE_RUNNER=win`.
- **If it breaks:** STT 4xx → whisper endpoint/flags; TTS hang → kokoro still warming (90s window like
  WSL); mic dead → Windows mic privacy setting; nothing binds → check the per-service logs you mirror
  to `%USERPROFILE%\.claudible\logs`.

### A4 — Tooling (git/gh/cloudflared, native)
- **Do:** `win.js runTool()` invokes Windows git/gh/cloudflared directly. Workspace/sync/share code that
  shelled into WSL now shells to Windows binaries.
- **Verify:** Smoke Test #6, #7, #8 (workspaces, sync, share) under `win`.
- **If it breaks:** `gh` auth differs (Windows credential store); cloudflared is already a Windows binary
  today so share should "just work"; path-with-spaces quoting in git invocations.

### A5 — Installer (native path)
- **Do:** `install.ps1` gains a **native mode** (auto when Windows `claude` is present + user opts in, or
  `-Native`): installs/verifies Windows Claude Code, **skips WSL entirely**, runs the Windows voice setup,
  writes the `win` runner selection. No Python/VS (whisper is prebuilt, kokoro is uv).
- **Verify:** on a **fresh Windows VM with no WSL**, run the installer → full Smoke Test 10/10.
- **If it breaks:** debug each prereq independently; the VM with no WSL is the real test that the WSL
  assumption is truly gone.

### A6 — End-to-end + flip
- **Do:** full Smoke Test on Windows-native. Keep WSL the default; expose a UI/CLI toggle. Flip default to
  `win` **only** when claude.exe is present *and* the smoke test is green on ≥2 machines (yours + MK's).
- **Verify:** the 10/10 checklist, plus #10 (no orphans) and #9 (settings survive force-kill).

**Part A done when:** a WSL-free Windows machine runs Claudible with voice, telemetry, agents, and share.

---

## Part B — Linux native (config 3) — light

Linux native is **the WSL backend minus the `wsl.exe` wrapper and `wslpath`**, plus Linux Electron
packaging. The voice build (`setup.sh`) is *already* Linux — it just runs on the host now.

### B1 — `PosixRunner` (spawn bash directly)
- **Do:** `runners/posix.js`: `spawnClaude` = node-pty spawn `bash -lc 'claude --dangerously-skip-permissions
  --add-dir "$HOME" ...'` directly (no `wsl.exe`). `toHostPath/toGuestPath` = identity. `runtimeDir()` =
  `$HOME/.claudible/runtime`. Reuse the WSL runner's command bodies verbatim — drop only the wrapper.
- **Verify:** `CLAUDIBLE_RUNNER=posix npm start` on Linux → Smoke Test #1.
- **If it breaks:** login-shell env (`-l`) needed so `claude` is on PATH; otherwise identical to WSL.

### B2 — Hooks
- **Do:** `posix.js installHooks()` writes `~/.claude/settings.json` pointing at the **same Node hooks**
  (0.5). Nothing OS-specific.
- **Verify:** Smoke #4 + #5.

### B3 — Voice (reuse `setup.sh` natively)
- **Do:** run the existing `setup/setup.sh` **on the host** (not in WSL) — it already builds whisper.cpp
  and installs kokoro for Linux. `services.sh` runs as-is; bind `127.0.0.1` for native (vs `0.0.0.0` for
  the WSL NIC).
- **Verify:** Smoke #2 + #3. This is the biggest reuse win — the Linux voice stack is already proven.
- **If it breaks:** it's the same failure surface as WSL today (apt deps, uv PATH, model download) — the
  existing `setup.sh` diagnostics apply unchanged.

### B4 — Electron on Linux (packaging)
- **Do:** the app currently assumes a Windows host. Add a Linux run/build target (electron on Linux;
  package as AppImage + .deb via electron-builder). Launcher replaces the Windows shortcut.
- **Verify:** the app window opens on a Linux desktop; menu/shortcuts work.
- **If it breaks:** missing system libs (`libnspr4` et al.) → list them as deps; sandbox flags on some
  distros.

### B5 — Tooling + installer
- **Do:** `runTool` → native git/gh/cloudflared. Replace `install.ps1` with a Linux installer (a thin
  `install.sh` that calls `setup.sh` + builds the Electron app), or a unified Node installer.
- **Verify:** Smoke #6–#8; fresh-distro install → 10/10.

**Part B done when:** Claudible runs on a Linux desktop with no Windows/WSL anywhere.

## Part C — macOS native (config 4) — light (Linux's sibling)

Same `PosixRunner` as Linux; the deltas are the voice build deps (brew, not apt) and Apple packaging.

### C1 — `PosixRunner` (reuse)
- **Do:** reuse `runners/posix.js` unchanged (`bash`/`zsh -lc 'claude ...'`).
- **Verify:** `CLAUDIBLE_RUNNER=posix npm start` on macOS → Smoke #1.

### C2 — Voice on macOS
- **Do:** add a **macOS branch** to `setup.sh`: `brew install cmake ffmpeg espeak-ng` (instead of apt);
  whisper.cpp builds with clang (Xcode CLT) — optional `-DWHISPER_METAL=ON` for GPU; kokoro via `uv` on
  macOS (CPU torch wheels exist for arm64 + x64). Or vendor a prebuilt `whisper-server` for macOS to skip
  the build entirely (mirrors the Windows approach).
- **Verify:** Smoke #2 + #3 on both Apple Silicon and Intel if supported.
- **If it breaks:** Xcode CLT missing → `xcode-select --install`; espeak data path; arm64 vs x64 torch wheel.

### C3 — Hooks + tooling (reuse)
- **Do:** same Node hooks; `~/.claude/settings.json`; native git/gh/cloudflared.
- **Verify:** Smoke #4–#8.

### C4 — Apple packaging (the real macOS-specific cost)
- **Do:** electron-builder `.app`/`.dmg`; **code-sign + notarize** (Gatekeeper requires it for
  distribution). This is the one genuinely Mac-only chunk of work.
- **Verify:** a downloaded `.dmg` opens on a clean Mac without a Gatekeeper block.
- **If it breaks:** notarization rejects an unsigned helper → sign all embedded binaries (incl.
  `whisper-server`, `cloudflared`); hardened-runtime entitlements for the mic.

**Part C done when:** a notarized Claudible.dmg runs on a clean Mac with voice + share.

---

## Cross-cutting

### Packaging & distribution (the "installed by millions" bar)
The endgame for all four configs is **electron-builder** producing signed, packaged installers with the
voice binaries pre-placed — so users download an installer, not a git repo. Order: get each backend green
from-source first (this plan), then wrap in electron-builder per OS. Packaging is downstream of correctness.

### CI matrix
- **Do:** GitHub Actions matrix (windows-latest, ubuntu-latest, macos-latest): build the app, run a
  headless subset of the Smoke Test (terminal spawn, voice health endpoints, hook write) per OS.
- **Verify:** the matrix is green before any default flip.

### Risk register
| Risk | Likelihood | Mitigation |
|---|---|---|
| Voice won't run natively on Windows | low (A0 looks green) | A0 gate; prebuilt `whisper-server.exe`; WSL-voice interim fallback |
| Hooks→Node regresses WSL telemetry/agents | medium | 0.5 behind the WSL smoke gate; byte-compare `status.json`/ndjson |
| ConPTY quirks with `.cmd` claude shim | medium | spawn via `cmd /c` or resolve the JS entrypoint |
| macOS notarization friction | medium | sign all embedded binaries; hardened-runtime mic entitlement |
| Seam leakage (hardcoded Windows assumptions) | medium | the 0.1 grep is the contract; re-run after 0.3 and each part |

## Sequencing
1. **Part 0** (Foundation) — gated by WSL Smoke 10/10. Nothing ships, everything depends on it.
2. **Part A0** (voice feasibility) — the single go/no-go; do it early even before finishing A1.
3. **Part A** (Windows native) — highest leverage (kills the WSL prereq for the existing audience).
4. **Part B** (Linux native) — cheap once 0.5 + PosixRunner exist; widens the audience.
5. **Part C** (macOS native) — Linux's sibling + Apple packaging.
6. **Cross-cutting** — electron-builder packaging + CI, per OS, after each is green from-source.

Each Part is self-contained: it can be picked up in isolation, implemented against the Runner seam,
and validated end-to-end with the Smoke Test for that OS — without touching the others.
