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
