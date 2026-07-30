# Peer machine diagnostic — "the live session shows up late for me"

Run this in a normal **Windows PowerShell** window — not WSL bash. The registry, the runtime journal, and
the git clone all live on the Windows side; WSL only executes scripts/the PTY. Do **not** restart Claudible
until told to — steps 1–7 inspect the process as it is right now.

Set `$app` once to your Claudible folder (where `main.js` / `package.json` live — default `%USERPROFILE%\claudible`).

**1 — Right repo/branch:**
```powershell
$app = "$env:USERPROFILE\claudible"; git -C $app remote get-url origin; git -C $app branch --show-current
```
GOOD: `https://github.com/synthetiks/claudible(.git)` and `main`. Anything else → fix this first; nothing below means anything.

**2 — Exact commit on disk:**
```powershell
git -C $app log --oneline -3
```
GOOD: the top commit matches the newest on GitHub `main`. BAD: older hashes → stale files, needs a pull.

**3 — Dirty tree and behind-ness (the silent self-update killer):**
```powershell
git -C $app fetch --quiet origin; git -C $app status --porcelain; git -C $app rev-list --count HEAD..origin/main
```
GOOD: no status output, count `0`. BAD: any status output → local edits — **the installer's self-update
silently skips a dirty tree**, so this machine never updates itself. Count `>0` → behind right now: `git -C $app pull`.

**4 — Content-level proof of the current fast path (immune to git-metadata confusion):**
```powershell
Select-String -Path "$app\main.js" -Pattern "BEACON_MS = |_beaconQualifies|_beaconArm"
```
GOOD: hits including `BEACON_MS = 1500`. BAD: `BEACON_MS = 2000/2500` or no `_beaconArm` → this main.js predates the per-workspace-chain fix.

**5 — Is the RUNNING process this tree (files can be newer than the process):**
```powershell
(Get-Item "$app\.git\logs\HEAD").LastWriteTime
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Sort-Object CreationDate | Select-Object ProcessId,CreationDate | Format-Table -AutoSize
```
Take the **earliest** electron.exe `CreationDate` (that's the main process; ignore a lone much-older zombie).
GOOD: `.git\logs\HEAD` LastWriteTime is **older** than the launch → the process runs what steps 2–4 showed.
BAD: newer → a pull landed under a running app. Fully quit (no electron.exe left in Task Manager), relaunch.

**6 — Dead projects still costing probes:**
```powershell
(Get-Content "$env:USERPROFILE\.claudible\app\workspaces.json" -Raw | ConvertFrom-Json).workspaces | Where-Object kind -eq 'repo' | Select-Object id,label,slug,owner,repoName,syncSessions,needsClone | Format-Table -AutoSize
```
GOOD: every listed repo actually exists on GitHub, or has `syncSessions:False`.
BAD: a deleted repo (e.g. an old `claudible-cowork`) with `syncSessions:True` → on current builds it wastes
its own bounded probe chain; on older builds it stalled EVERY project's detection. Turn its sync off or
delete the project in Claudible.

**7 — Read the journal after a test (UTC timestamps, directly diffable with the host's journal):**
```powershell
Get-Content "$app\runtime\live-timing.log" -Tail 80 | Select-String "advertise:|heartbeat:|beacon:|end:|boot:|relay:"
```
- `advertise:` / `heartbeat:` lines appear only on the HOST's journal.
- `beacon: head moved <ws> (probe Nms)` then `beacon: peers pushed <ws> (+Nms)` — YOUR machine noticing and painting.
- GOOD: `head moved` within ~1–3s of the host's `starting stamp landed` line.
- BAD signatures: gaps that double across tries (3s→6s→…→60s) = that workspace's probe is in failure backoff —
  check THAT repo's remote. No `beacon:` lines at all during a test = old build (step 4), non-qualifying
  project (step 6), or no GitHub connectivity. Silence between tests is normal — the journal only logs changes.

**8 — Watch live during a coordinated test** (start this, host clicks Share, Ctrl+C when done):
```powershell
Get-Content "$app\runtime\live-timing.log" -Tail 5 -Wait | Select-String "advertise:|heartbeat:|beacon:|end:|boot:|relay:"
```
