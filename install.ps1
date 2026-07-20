# Claudible - one-shot installer. Run in Windows PowerShell from the cloned repo root. If Windows blocks it
# ("running scripts is disabled on this system"), launch via ExecutionPolicy Bypass - a one-shot that changes
# nothing on the machine:  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Native]
#   .\install.ps1            # WSL mode (default): WSL2 + a signed-in Claude Code in WSL + the WSL voice build.
#   .\install.ps1 -Native    # native Windows (NO WSL): provisions Windows Claude Code + the prebuilt voice
#                             # services, and pins the `win` runner. STATUS: authored + statically verified;
#                             # the native runtime path needs a Windows smoke test (docs/SMOKE.md) - the WSL
#                             # mode remains the proven default.
# It handles Windows Node, dependencies, the voice build, a Desktop shortcut, and launch. The only things it
# can't conjure are git (the README one-liner installs that before the clone) and, in WSL mode, WSL2 itself.
param([switch]$Native, [switch]$NoUpdate)
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
Set-Location $app
function Step($n, $m) { Write-Host "`n[$n] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "`n$m" -ForegroundColor Yellow; exit 1 }
Write-Host "=== Claudible installer ===" -ForegroundColor Cyan

# Refuse to run from a protected Windows system folder (almost always because the installer was launched from an
# ADMIN PowerShell, which opens in C:\WINDOWS\system32). npm can't create node_modules there -> EPERM. The fix is
# location, not elevation: install into the user's own folder.
if ($app -like "$env:windir\*") {
  Die "Claudible is in a protected Windows system folder:`n  $app`nWindows blocks writes there, so 'npm install' fails with EPERM creating node_modules. Don't 'Run as Administrator' - open a NORMAL PowerShell (it opens in your user folder) and install there instead:`n`n  cd `$env:USERPROFILE`n  git clone https://github.com/thecrazydev1/claudible`n  cd `$env:USERPROFILE\claudible`n  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1$(if ($Native) {' -Native'})`n`nThen remove this stray copy:`n  $app"
}

# Node 22.12+ on Windows - required to run the Electron app.
function Test-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  try { return [version](((& node -v) -replace '^v','').Trim()) -ge [version]'22.12.0' } catch { return $false }
}
if (-not (Test-Node)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die "Node 22.12+ for Windows is required. Install it from https://nodejs.org , then re-run this installer."
  }
  Step 'Node' 'Installing Node.js LTS for Windows via winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { Die "winget could not install Node. Install Node 22.12+ from https://nodejs.org , then re-run this installer." }
  # Refresh PATH in THIS session (winget updates the registry, not the live process) so we keep going
  # in the same run instead of making the user reopen PowerShell.
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  if (Test-Path "$env:ProgramFiles\nodejs\node.exe") { $env:Path = "$env:ProgramFiles\nodejs;$env:Path" }
  if (-not (Test-Node)) {
    Die "Node installed but isn't visible in this window yet. Open a NEW PowerShell and run:`n  powershell -NoProfile -ExecutionPolicy Bypass -File `"$app\install.ps1`""
  }
  Write-Host "  Node ready - continuing." -ForegroundColor Green
}

# Self-update: re-running the installer on an existing clone must build the LATEST code, not the commit it was
# cloned at (a stale build is the root cause of cross-machine live-join skew). Only when this is a CLEAN git
# checkout (never clobber local edits); non-fatal on any failure. Opt out with -NoUpdate.
if ($NoUpdate) {
  # Persist the opt-out so the IN-APP "Update & restart" honors it too (same one-line env-var pattern the
  # -Native branch already uses for CLAUDIBLE_RUNNER). Clearing it: re-run the installer without -NoUpdate.
  [Environment]::SetEnvironmentVariable('CLAUDIBLE_NO_UPDATE','1','User')
  $env:CLAUDIBLE_NO_UPDATE = '1'
} else {
  [Environment]::SetEnvironmentVariable('CLAUDIBLE_NO_UPDATE',$null,'User')
  Remove-Item Env:CLAUDIBLE_NO_UPDATE -ErrorAction SilentlyContinue
}
if (-not $NoUpdate -and (Test-Path (Join-Path $app '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Step 'Update' 'Refreshing to the latest Claudible (git pull)...'
  if (& git -C $app status --porcelain) {
    Write-Host '  Local changes present - skipping auto-update (building your current tree).' -ForegroundColor Yellow
  } else {
    & git -C $app pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Host '  Could not fast-forward - continuing with the current checkout.' -ForegroundColor Yellow }
    else { Write-Host '  Up to date.' -ForegroundColor Green }
  }
}

Step '1/4' 'Installing dependencies (npm install)...'
npm install
if ($LASTEXITCODE -ne 0) { Die "npm install failed (see above)." }
# node-pty is the one native module, and it ships ABI-stable N-API prebuilts (node-addon-api). N-API binaries
# load unchanged under Electron - so there's NO recompile, NO Python, NO C++ toolchain. (The embedded Claude
# terminal you'll run is itself one of these prebuilt ptys.) Just confirm the prebuilt for this CPU arch landed.
$arch = (& node -e "process.stdout.write(process.arch)")
$ptyPrebuilt = Join-Path $app "node_modules\node-pty\prebuilds\win32-$arch\pty.node"
if (Test-Path $ptyPrebuilt) {
  Write-Host "  node-pty ready (prebuilt N-API binary for win32-$arch - no compiler needed)." -ForegroundColor Green
} else {
  # Rare: an unusual Windows arch node-pty ships no prebuilt for. Only here do we fall back to a source build.
  Write-Host "  No prebuilt node-pty for win32-$arch (unusual) - falling back to a one-time source build..." -ForegroundColor Yellow
  npm run rebuild
  if ($LASTEXITCODE -ne 0) {
    Die "node-pty has no prebuilt for win32-$arch and the source build failed. This rare fallback needs Python 3 and the Visual Studio C++ Build Tools:`n  winget install -e --id Python.Python.3.12`n  winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override `"--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`"`nThen re-run: .\install.ps1"
  }
}

if ($Native) {
  # Native Windows path - NO WSL. Ensure native Claude Code, build the prebuilt voice services, pin the win runner.
  Step '2/4' 'Provisioning native Windows Claude Code + voice (no WSL)...'
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host '  Installing Claude Code for Windows (npm i -g @anthropic-ai/claude-code)...' -ForegroundColor Cyan
    npm install -g '@anthropic-ai/claude-code'
    if ($LASTEXITCODE -ne 0) { Die "Couldn't install Claude Code. Install it (https://docs.anthropic.com/en/docs/claude-code) + sign in, then re-run: .\install.ps1 -Native" }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  }
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Die "Claude Code installed but not visible in this window. Open a NEW PowerShell, run 'claude' once to sign in, then re-run: .\install.ps1 -Native" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'setup\setup-win.ps1')
  if ($LASTEXITCODE -ne 0) { Die "Native voice setup did not finish - see above, then re-run: powershell -ExecutionPolicy Bypass -File setup\setup-win.ps1" }
  # Pin the native-Windows backend for every launch. Remove this env var to revert to the WSL backend.
  [Environment]::SetEnvironmentVariable('CLAUDIBLE_RUNNER', 'win', 'User')
  $env:CLAUDIBLE_RUNNER = 'win'
  Write-Host '  Pinned CLAUDIBLE_RUNNER=win (native backend). Remove that user env var to revert to WSL.' -ForegroundColor Green
} else {
  # WSL2 must exist - `npm run setup` and the app both shell into it.
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Die "WSL2 isn't installed. Run 'wsl --install' in an admin PowerShell, reboot, then re-run this installer (or use -Native for a WSL-free install)." }
  & wsl.exe -e true 2>$null
  if ($LASTEXITCODE -ne 0) { Die "WSL has no working default distro. Install one (e.g. 'wsl --install -d Ubuntu' and finish its first-run setup), then re-run this installer." }
  # Confirm the DEFAULT distro is WSL2, not WSL1 - the whole backend (interop, path translation, NAT networking)
  # is authored against WSL2, and a WSL1 distro passes the "a distro runs" check above silently. `wsl -l -v` prints
  # UTF-16 with a `*` on the default distro; strip the NULs and read its VERSION column. Only refuse when we can
  # POSITIVELY read a "1" - an output we can't parse (locale, future format) falls through rather than false-blocking.
  try {
    $wslV = ((& wsl.exe -l -v 2>$null) -join "`n") -replace "`0",''
    $defLine = ($wslV -split "`n" | Where-Object { $_ -match '^\s*\*' } | Select-Object -First 1)
    if ($defLine -and ($defLine -match '(\d)\s*$') -and ($Matches[1] -eq '1')) {
      Die "Your default WSL distro is WSL1, but Claudible needs WSL2. Convert it:  wsl --set-version <distro> 2  (run 'wsl -l -v' for the name), then re-run this installer."
    }
  } catch { }

  Step '2/4' 'Building the local voice services in WSL (you may be asked for your WSL sudo password)...'
  npm run setup
  if ($LASTEXITCODE -ne 0) {
    # Voice is OPTIONAL (runners/deps.js marks it required:false) and retryable from the in-app System
    # Check - a flaky 480MB download must not strand a collaborator without a launchable app. Mirror the
    # shortcut step's warn-and-continue pattern instead of dying here.
    Write-Host '  Voice setup did not finish - continuing WITHOUT voice. Retry later from the in-app System Check, or run: npm run setup' -ForegroundColor Yellow
  }
}

Step '3/4' 'Creating the Desktop shortcut...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'launch\make-shortcut.ps1')
if ($LASTEXITCODE -ne 0) { Write-Host '  (Desktop shortcut step reported an issue - you can still launch via: npm start.)' -ForegroundColor Yellow }

Step '4/4' 'Launching Claudible...'
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm','start' -WorkingDirectory $app -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3   # a hidden fire-and-forget launch used to print success even if the app instantly died; catch an immediate crash
if ($proc.HasExited -and $proc.ExitCode -ne 0) {
  Write-Host "`n[!] Claudible exited immediately (code $($proc.ExitCode)). Launch manually to see the error:`n    cd `"$app`"; npm start" -ForegroundColor Yellow
} else {
  Write-Host "`n[OK] Done. Claudible is starting, and there's a 'Claudible' shortcut on your Desktop." -ForegroundColor Green
}
