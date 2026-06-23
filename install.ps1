# Claudible - one-shot installer. Run in Windows PowerShell from the cloned repo root:
#   .\install.ps1            # WSL mode (default): WSL2 + a signed-in Claude Code in WSL + the WSL voice build.
#   .\install.ps1 -Native    # native Windows (NO WSL): provisions Windows Claude Code + the prebuilt voice
#                             # services, and pins the `win` runner. STATUS: authored + statically verified;
#                             # the native runtime path needs a Windows smoke test (docs/SMOKE.md) - the WSL
#                             # mode remains the proven default.
# It handles Windows Node, dependencies, the voice build, a Desktop shortcut, and launch. The only things it
# can't conjure are git (the README one-liner installs that before the clone) and, in WSL mode, WSL2 itself.
param([switch]$Native)
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
Set-Location $app
function Step($n, $m) { Write-Host "`n[$n] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "`n$m" -ForegroundColor Yellow; exit 1 }
Write-Host "=== Claudible installer ===" -ForegroundColor Cyan

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

  Step '2/4' 'Building the local voice services in WSL (you may be asked for your WSL sudo password)...'
  npm run setup
  if ($LASTEXITCODE -ne 0) { Die "Voice setup did not finish - see the messages above. Fix what it reported, then re-run: npm run setup" }
}

Step '3/4' 'Creating the Desktop shortcut...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'launch\make-shortcut.ps1')

Step '4/4' 'Launching Claudible...'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm','start' -WorkingDirectory $app -WindowStyle Hidden
Write-Host "`n[OK] Done. Claudible is starting, and there's a 'Claudible' shortcut on your Desktop." -ForegroundColor Green
