# OS Port — Live Status

> **📜 Historical status snapshot (last updated 2026-06-23).** Superseded by shipped releases v0.3.0–v0.6.0: native Windows has had multiple real hardware installs and the Linux AppImage is boot-verified. Only the macOS runtime smoke remains hardware-gated. See READMEs *Platform support* for current reality.

Running progress against `docs/OS-CONVERSION-PLAN.md`. Updated as each piece lands so an interrupted
session can resume cleanly. **Legend:** ✅ done+verified · 🟡 code-complete, runtime-gated · ⬜ not started.

## Phase 0 — the Runner seam ✅ (runtime-confirmed on Windows+WSL)
- 0.1 Seam map (`docs/SEAMS.md`, 74 seams) ✅
- 0.2 Runner interface (`runners/runner.js`) ✅
- 0.3 main.js cutover (28 sites → runner) ✅ — terminal/agents/telemetry/voice all confirmed live
- 0.4 Runner selection (`CLAUDIBLE_RUNNER` + platform auto) ✅
- 0.5 Hooks → shared Node (`hooks/statusline.js`, `hooks/hook.js`) ✅ — confirmed live on a fresh session
- Shared command construction `runners/_shared.js` (wsEnv/bootStr/scriptCmd) ✅

## Part B — Linux native ✅ core (LIVE-tested on this Linux box)
- B1 `runners/posix.js` — bash-direct spawn, identity paths, reuses wsl/*.sh + Node hooks ✅
  (proof: `node test/posix-runner.test.js` — LIVE `runScript('sessions.sh')` returns a real array)
- B2 hooks — reused unchanged (session.sh under bash stages the Node hooks) ✅
- B3 voice — `services.sh` runs natively (Linux) ✅ logic; ⬜ live (needs the services built on a Linux host)
- B4 Electron-on-Linux packaging ✅ **PROVEN locally** — `electron-builder --linux dir` (node 22) built
  `dist/linux-unpacked` with electron 42: the `claudible` binary, all 18 `wsl/*.sh` + 8 `*-tool.js` + 2 hooks
  + main.js ON DISK (asar:false working), node-pty bundled, runtime/docs/test excluded. node-pty also
  COMPILES + SPAWNS a real pty on Linux (verified). AppImage/deb add only FUSE/dpkg packaging on top (CI).
- B5 Linux installer + node-pty: **fix verified** — `node-pty-prebuilt-multiarch` (0.10.x) ships
  `linux-{x64,arm64,arm,ia32}` + `darwin-{x64,arm64}` prebuilds, and `ptyInfo()` already falls back to it.
  Add as an `optionalDependency` when packaging the Linux/mac Electron build (deferred now — it'd bloat
  the Windows install for no current benefit). Installer itself ⬜.

## Part C — macOS native 🟡 (shares PosixRunner; needs the build-tool branches)
- C1 PosixRunner — reused as-is ✅
- C2 voice build branches ✅ (logic complete; mac-smoke-gated): `setup.sh` has the Homebrew branch; `services.sh`
  `listening()` is cross-platform (ss→lsof→netstat — `lsof` is the mac path) + espeak-ng-data resolves the
  Homebrew/`/usr/local` paths. `bash -n` clean. Needs a Mac to runtime-verify.
- C3 hooks/tooling — reused ✅ (port-parity proven on Linux; see the one macOS caveat below)
- C4 Apple `.dmg` + code-sign/notarize ⬜
- **KNOWN macOS-only caveat (tracked, fix when C4 ships):** `wsl/diff-tool.js` reads `/proc/self/environ`
  to reproduce CPython `os.environ`'s surrogateescape decoding of the diff content passed via env. macOS has
  no `/proc` → it falls back to `process.env`, so a diff containing **invalid-UTF-8 bytes** decodes to U+FFFD
  vs python's U+DCxx. Valid-UTF-8 content (the overwhelming norm) is byte-identical everywhere; this only bites
  non-UTF-8 file content shown in a diff, only on macOS. **Fix (do it on a Mac):** pass DIFF/UNTRACKED/CDIFF/CLOG
  to the helper via stdin or temp files (raw bytes) instead of env — then `fs.readFileSync` gives exact bytes on
  every platform and the `/proc` special-case is deleted. Not a WSL/Windows/Linux issue. (`sessions-sync` has a
  similar documented non-issue: a foreign non-integer `ts` re-serializes 1000.0→1000, but ts is never printed.)

## Part A — Windows native (core built; live glue 🟡, NOT runtime-run from this Linux env)
- **A0 voice-on-Windows feasibility — ✅ GREEN.** Proven on the real Windows side: the prebuilt
  `whisper-server.exe` (in `whisper-bin-x64.zip`, 7 MB, with the CPU ggml DLLs) RAN with exit 0 — STT
  works, no compiler. Kokoro = `uv` (winget, light) + CPU-torch (known win wheels, pure Python) →
  feasible; the heavy `uv sync` is deferred to the real install. Windows node = v22.17.1 x64.
- A1/A2 `runners/win.js` — built. **PURE CORE ✅ unit-tested on Linux** (`test/win-runner.test.js`, 25/25):
  `sessionDir`, `claudeProjectsDir` encoding, `pickResumeTarget` (incl. the foreign-session sandbox),
  `claudeArgv`, `settingsJson` (Node hooks via the Windows node path). Live glue 🟡: ConPTY claude.exe
  spawn + the resume-dir read (gated on a Windows smoke).
- A4 tooling — `runScript` reuses ALL 16 `wsl/*.sh` UNCHANGED via **git-bash** (`bash.exe -lc`, already a
  prereq) + `cygpath` app-dir 🟡. Registered as `CLAUDIBLE_RUNNER=win` (opt-in; auto stays on wsl).
- A3 voice — 🟡 **authored + statically verified.** `setup/setup-win.ps1` provisions the A0-proven prebuilt
  `whisper-server.exe` (downloaded from the live whisper.cpp release — URL + `Release/` zip layout verified —
  no compiler) + the ggml-base model + Kokoro (uv `--extra cpu`). `wsl/services.sh` now resolves the whisper
  binary as either the cmake build OR `Release/whisper-server.exe` (DLLs load from the exe dir; model path
  stays cwd-relative). **Wiring fix (caught in review):** `win.js startVoiceServices()` was an empty stub —
  now it runs `services.sh` via git-bash (like posix/wsl), binding `127.0.0.1` (a `CLAUDIBLE_BIND_HOST` bridge,
  default 0.0.0.0 for WSL) so native Windows avoids the 0.0.0.0 Firewall prompt + LAN exposure. pwsh-parsed
  clean + `bash -n` clean + suite green. **Smoke-gated:** whisper bind under git-bash + the Kokoro Windows
  runtime (uvicorn :8880 + espeak-ng-data) need a real Windows box.
- A5 installer — 🟡 **authored + statically verified.** `install.ps1 -Native`: skips WSL, installs Windows
  Claude Code if missing (`npm i -g @anthropic-ai/claude-code` — package + `bin: claude.exe` verified), runs
  `setup-win.ps1`, pins `CLAUDIBLE_RUNNER=win` (User env). pwsh AST-parsed clean. WSL mode stays the default.
  **Smoke-gated:** the end-to-end native install + A6 flip need a Windows box.
- **win.js adversarial review done (3-angle).** Outcomes:
  - ✅ FIXED: the projects-dir encoding mismatch (git-bash MSYS `-c-…` vs claude.exe `C--…`) — env-bridge
    `CLAUDIBLE_PROJ` set by win.js runScript + `${CLAUDIBLE_PROJ:-<sed fallback>}` in the 8 scripts
    (backward-compatible — WSL/Posix byte-identical when unset; override verified live).
  - ✅ FIXED: `MSYS_NO_PATHCONV=1` in runScript env (leading-slash `gh api` mangling).
  - ✅ FIXED earlier: `process.execPath`/electron.exe-as-node → `whichNode()`.
  - ✅ RESOLVED (was blocker 2): the 8 scripts' `python3` JSON transforms were ported to Node
    (`wsl/*-tool.js`, called via `node "$(dirname "$0")/<x>-tool.js"`). **Byte-parity proven** against the
    original python3 (3.10.12 oracle) across 14 adversarial fixtures — emoji/astral surrogate escaping, CJK,
    malformed lines, conditional keys + ordering, binary diffs, multi-commit logs, base64 (BOM+control+emoji),
    git-fixture title-read, cross-engine cache. `test/port-parity.sh` (in `npm test` + CI; 14/14 under both node
    18 and the shipping node 22). Git-for-Windows now needs no python3 for the script fleet; the prereq is gone
    for the runtime path on every OS. Removed 441 lines of inline python. (The optional voice/TTS stack — Kokoro
    — still uses Python, provisioned by `setup.sh`; separate from the core app.)
  - 🔬 SMOKE-only (unverifiable from Linux): claudeProjectsDir drive-letter CASE (`C--` vs `c--`); whether
    cmd.exe runs the leading-double-quote hook command. Both in docs/SMOKE.md.

## Cross-cutting — packaging ✅ config PROVEN on Linux, win/mac CI-gated
- **electron-builder** (`package.json#build`, `asar:false` — required so git-bash/node-by-PATH can read the
  `wsl/*.sh` + `*-tool.js` + hooks on disk). Targets: Windows NSIS (user picks install dir — the friction fix),
  Linux AppImage+deb, mac dmg. Icons: `.ico` (win) + generated square `assets/icon.png` (mac/linux).
  **The Linux target is built + layout-verified locally (see B4)** — same config drives win/mac, so those are
  high-confidence; their artifacts build in CI (can't build a Windows .exe / mac .dmg from Linux).
- **CI matrix** `.github/workflows/build.yml` (win/linux/mac runners; node 22.12 — note: electron-builder 26
  needs node ≥22.12's require(esm); linux adds `node-pty-prebuilt-multiarch`; never auto-publishes — repo stays
  private). `.github/workflows/test.yml` runs the full parity suite on push.
- still ⬜ (hardware-gated): A5/A3 (Windows installer + voice — the NSIS .exe already delivers the GUI install),
  C4 (mac sign/notarize), the Windows/mac live smoke runs.

## Verification reality
- **Linux/Posix**: fully runtime-testable here (and tested).
- **Windows-native / macOS**: I can build + statically verify (parity, review, syntax) but CANNOT run
  from this Linux env — those carry a 🟡 until smoke-tested on real Win/Mac hardware.

## How to smoke-test the native backends (for a tester on real hardware)
- **Windows-native (Part A):** set `CLAUDIBLE_RUNNER=win` before launch (needs native Claude Code on
  PATH + Git for Windows). Then run `docs/SMOKE.md`. Watch: claude.exe spawns (ConPTY), telemetry ticks
  (Node hooks via the Windows node), agents/workspaces/diff work (git-bash runScript). `unset` to revert.
- **Linux-native (Part B):** run Claudible's Electron on a Linux desktop (auto-selects `posix`); needs a
  linux node-pty build. `runScript` is already proven live here.

## Commits so far (newest last)
b37610a seam+WslRunner · 0ff437c cutover · 6c2f367 hooks→Node · 2fc96a6 Posix backend + _shared ·
(this) Windows-native runner core + A0 GREEN
