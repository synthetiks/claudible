# Claudible - one-shot installer. Run in Windows PowerShell from the cloned repo root:
#   .\install.ps1
# It handles everything from here: Windows Node, dependencies, the WSL voice build (installing the
# Linux deps for you), a Desktop shortcut, and launch. The only things it can't conjure are git, WSL2
# itself, and a signed-in Claude Code in WSL (see README "Prerequisites").
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
Set-Location $app
function Step($n, $m) { Write-Host "`n[$n] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "`n$m" -ForegroundColor Yellow; exit 1 }
Write-Host "=== Claudible installer ===" -ForegroundColor Cyan

# Node 22.12+ on Windows - required to run the Electron app.
$okNode = $false
$nc = Get-Command node -ErrorAction SilentlyContinue
if ($nc) { try { $okNode = [version](((& node -v) -replace '^v','').Trim()) -ge [version]'22.12.0' } catch {} }
if (-not $okNode) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Step 'Node' 'Installing Node.js LTS for Windows via winget...'
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Die "winget could not install Node. Install Node 22.12+ from https://nodejs.org , then re-run the line below." }
    Die "Node installed. Open a NEW PowerShell (so Node is on PATH) and run:`n  powershell -NoProfile -ExecutionPolicy Bypass -File `"$app\install.ps1`""
  }
  Die "Node 22.12+ for Windows is required. Install it from https://nodejs.org , then run:`n  powershell -NoProfile -ExecutionPolicy Bypass -File `"$app\install.ps1`""
}

Step '1/4' 'Installing dependencies (npm install)...'
npm install
if ($LASTEXITCODE -ne 0) { Die "npm install failed (see above)." }

# WSL2 must exist - `npm run setup` and the app both shell into it.
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Die "WSL2 isn't installed. Run 'wsl --install' in an admin PowerShell, reboot, then re-run this installer." }
& wsl.exe -e true 2>$null
if ($LASTEXITCODE -ne 0) { Die "WSL has no working default distro. Install one (e.g. 'wsl --install -d Ubuntu' and finish its first-run setup), then re-run this installer." }

Step '2/4' 'Building the local voice services in WSL (you may be asked for your WSL sudo password)...'
npm run setup
if ($LASTEXITCODE -ne 0) { Die "Voice setup did not finish - see the messages above. Fix what it reported, then re-run: npm run setup" }

Step '3/4' 'Creating the Desktop shortcut...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'launch\make-shortcut.ps1')

Step '4/4' 'Launching Claudible...'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm','start' -WorkingDirectory $app -WindowStyle Hidden
Write-Host "`n[OK] Done. Claudible is starting, and there's a 'Claudible' shortcut on your Desktop." -ForegroundColor Green
