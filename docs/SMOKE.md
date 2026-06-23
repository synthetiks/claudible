# Claudible — Smoke Test (the universal backend acceptance gate)

Run this **identically** against every backend (`OS-CONVERSION-PLAN.md`). A backend is "done" only
when all 10 pass on real hardware for that OS. After Part 0.3 (the Runner cutover on Windows+WSL),
this is the gate that proves the refactor was byte-faithful — static checks (`node --check`, the
parity test, the re-grep) can't see the running app; this can.

**How to run (Windows + WSL, `CLAUDIBLE_RUNNER` unset → auto-selects `wsl`):**
relaunch Claudible (close it, `npm start` from the install folder), then walk the list. If anything
regresses vs. the pre-refactor build, it's a cutover bug — capture the symptom and the
`CLAUDIBLE_DEBUG=1` log (`.claudible-debug.log`).

| # | Check | Pass = |
|---|-------|--------|
| 1 | **Terminal** | The embedded Claude Code TUI renders, takes input, responds; resize reflows; scrollback works. |
| 2 | **Voice in** | Hold PTT, speak → the text lands in the session (whisper `:2022` hit). |
| 3 | **Voice out** | A reply is spoken (kokoro `:8880` hit, audio plays). |
| 4 | **Telemetry** | Context %, cost, tokens update live; the context guardrail trips amber → red. |
| 5 | **Agents** | Spawn a subagent / a small workflow → the Agents tab shows them live with tools/tokens. |
| 6 | **Workspaces** | Create a local **and** a repo workspace; switch between them; the sessions list is correct. |
| 7 | **Session sync** | In a repo workspace, a rename / new session round-trips via git. |
| 8 | **Share / co-work** | Start Share, approve a guest; read-only **and** interactive both work; chat + voice room. |
| 9 | **Settings persistence** | Set the username, force-kill the app, relaunch → it survived. |
| 10 | **Clean exit** | After quit, no orphaned `cloudflared` / whisper / kokoro processes remain. |

**Why this gate matters for 0.3 specifically:** the cutover routed every `wsl.exe`/`wslpath`/
`node-pty.spawn` call through `runners/wsl.js`. The parity test proves the *command strings* are
byte-identical and the adversarial review confirmed the *async/error semantics* are preserved — but
only this checklist proves the live wsl.exe plumbing, the pty stream, the hook pollers, and the
share/voice stack still behave. 10/10 here = green-light to start Part A/B/C against the seam.

**Quick subset (fast confidence, not a substitute):** #1 (terminal spawns), #4 (telemetry ticks),
#5 (an agent shows up) exercise spawnClaude + the runtime pollers + runScript(workflows.sh) — the
three highest-traffic seam paths. If those three are green the cutover is almost certainly faithful;
run the full 10 before flipping any default.

---

## Native backends — opt-in smoke tests (Part A/B/C, 🟡 until these pass)

The default on Windows is still the proven WSL backend. The native backends are **registered but opt-in**
so they can be smoke-tested without risk. Run the 10-point list above under each, plus the watch-items.

### Windows-native (`runners/win.js`, Part A) — `CLAUDIBLE_RUNNER=win`
**Needs:** native Claude Code on PATH (`where claude`), Windows Node 22.12+ on PATH, Git for Windows
(`bash.exe` — already an install prereq). **No WSL.** Launch with the env var set, e.g. in PowerShell:
`$env:CLAUDIBLE_RUNNER='win'; npm start` (from the install folder). `Remove-Item Env:\CLAUDIBLE_RUNNER` to revert.

**Native install smoke (A5/A3 — authored, never run on Windows yet):** from the cloned repo,
`.\install.ps1 -Native` should: install Windows Claude Code if missing, run `setup\setup-win.ps1` (download the
prebuilt `whisper-server.exe` + ggml-base model; clone Kokoro + `uv sync --extra cpu` + its model), and pin
`CLAUDIBLE_RUNNER=win`. **Watch for, in order:** (1) `uv` resolves after winget/installer (PATH refresh);
(2) `whisper-bin-x64.zip` extracts to `…\whisper\Release\whisper-server.exe`; (3) the model lands at
`…\whisper\models\ggml-base.bin`; (4) `uv sync --extra cpu` finishes (the heavy step); (5) on launch, whisper
binds **`127.0.0.1:2022`** (loopback — no Windows Firewall prompt; check `%USERPROFILE%\.claudible\logs\whisper.out`)
and **Kokoro `127.0.0.1:8880`** — Kokoro on Windows is the **most likely failure** (espeak-ng phonemizer data /
uvicorn); check `kokoro.out`. The win runner starts these by running `wsl/services.sh` through **git-bash** (it
sets `CLAUDIBLE_BIND_HOST=127.0.0.1`). If only voice fails, terminal+telemetry still work.
- **#1 Terminal** — does **claude.exe** spawn in the embedded terminal (ConPTY)? Watch for a `.cmd`-shim
  vs native-exe resolution issue (we spawn via `cmd /c claude …`).
- **#4 Telemetry** — does the meter tick? This proves Claude invokes the **Node hooks via the Windows
  `node.exe`** (NOT electron.exe) with the per-tab path baked as argv. If the meter is dead, check
  `%USERPROFILE%\.claudible\session\.claude\settings.json` — the command should be `"<…\node.exe>" "…statusline.js" "…status.json"`.
- **#5 Agents / #6 Workspaces / diff / skills** — these run the 16 `wsl/*.sh` via **git-bash**. If they're
  empty but the terminal works, git-bash/`cygpath` resolution is the suspect (`CLAUDIBLE_GIT_BASH` overrides the path).
- **No Python needed (resolved):** the script JSON transforms were ported off `python3` to Node
  (`wsl/*-tool.js`, byte-parity proven by `test/port-parity.sh`). Git-for-Windows needs no `python3`; Node is
  already present (it runs the app + hooks). The session list / transcript / skills / plugins / agent-tokens /
  workflows / diff / sync-titles no longer depend on Python on any OS.
- **Verify the projects-dir encoding** (else resume starts fresh + the script fleet reads a phantom dir):
  launch claude in a known session dir, let it write a transcript, then `dir %USERPROFILE%\.claude\projects`
  and confirm the dir name equals `runners/win._internals.claudeProjectsDir(sdir, %USERPROFILE%)`. **Watch
  the drive-letter case** (`C--…` vs `c--…`) — if claude.exe lowercases it, normalize the same way in win.js.
- **Verify the hook command actually runs:** trigger a Stop → a JSON line must land in
  `runtime\tabs\<tab>\hooks.ndjson` and `status.json` must update. If nothing lands, cmd.exe may be stripping
  the leading double-quote — drop the quotes around bare `node` in `settingsJson`.

### Linux-native (`runners/posix.js`, Part B) — auto-selected when Electron runs on Linux
`runScript` is already proven live (test/posix-runner.test.js). The remaining gate is running Claudible's
**Electron on a Linux desktop** + a **linux node-pty build** (1.1.0 ships no linux prebuild — `npm rebuild
node-pty` or a prebuilt). Then run the 10-point list. macOS is the same backend + the Homebrew/`lsof`
build branches (Part C).
