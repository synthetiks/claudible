# OS Port — Live Status

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
- B4 Electron-on-Linux packaging (AppImage/deb) ⬜
- B5 Linux installer + node-pty: **fix verified** — `node-pty-prebuilt-multiarch` (0.10.x) ships
  `linux-{x64,arm64,arm,ia32}` + `darwin-{x64,arm64}` prebuilds, and `ptyInfo()` already falls back to it.
  Add as an `optionalDependency` when packaging the Linux/mac Electron build (deferred now — it'd bloat
  the Windows install for no current benefit). Installer itself ⬜.

## Part C — macOS native 🟡 (shares PosixRunner; needs the build-tool branches)
- C1 PosixRunner — reused as-is ✅
- C2 voice build branches in `setup.sh`/`services.sh` (brew vs apt, `lsof` vs `ss`, espeak path) — IN PROGRESS
- C3 hooks/tooling — reused ✅
- C4 Apple `.dmg` + code-sign/notarize ⬜

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
- A3 voice — `whisper-server.exe` + Kokoro uvicorn on Windows (A0-proven approach) — installer-side, ⬜
- A5 installer (`install.ps1 -Native`) ⬜  ·  A6 e2e + flip — gated on a Windows smoke test ⬜
- **win.js adversarial review done (3-angle).** Outcomes:
  - ✅ FIXED: the projects-dir encoding mismatch (git-bash MSYS `-c-…` vs claude.exe `C--…`) — env-bridge
    `CLAUDIBLE_PROJ` set by win.js runScript + `${CLAUDIBLE_PROJ:-<sed fallback>}` in the 8 scripts
    (backward-compatible — WSL/Posix byte-identical when unset; override verified live).
  - ✅ FIXED: `MSYS_NO_PATHCONV=1` in runScript env (leading-slash `gh api` mangling).
  - ✅ FIXED earlier: `process.execPath`/electron.exe-as-node → `whichNode()`.
  - ⚠ GATE (blocker 2): **8 of the 16 scripts shell out to `python3`**, which Git-for-Windows lacks — the
    A5 installer MUST put Python on PATH (or those 8 degrade to empty). Documented in win.js header; not a
    terminal/telemetry blocker.
  - 🔬 SMOKE-only (unverifiable from Linux): claudeProjectsDir drive-letter CASE (`C--` vs `c--`); whether
    cmd.exe runs the leading-double-quote hook command. Both in docs/SMOKE.md.

## Cross-cutting ⬜
- electron-builder packaging per OS · CI matrix · the "millions" packaged-installer bar

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
