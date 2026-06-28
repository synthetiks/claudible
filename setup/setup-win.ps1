# Claudible - native-Windows voice setup (no WSL). Installs Whisper (STT) + Kokoro (TTS) under
# %USERPROFILE%\.claudible\voice using the A0-proven approach: the PREBUILT whisper-server.exe
# (no cmake / no C++ compiler) + Kokoro via uv with CPU torch. Mirrors setup/setup.sh, which builds
# the same services inside WSL.
#
# STATUS: authored + statically verified (pwsh parse/AST). The download URLs + zip layout are verified
# against the live releases (whisper-bin-x64.zip -> Release\whisper-server.exe + ggml CPU DLLs;
# ggml-base.bin from huggingface; remsky/Kokoro-FastAPI). The whisper binary itself is A0-proven (ran
# exit 0 on Windows). The Kokoro RUNTIME on Windows (uvicorn bind + espeak-ng-data) still needs a smoke
# test on a real Windows box - see docs/SMOKE.md. Run from the repo root:
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup\setup-win.ps1
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host "`n[claudible setup-win] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }

$VOICE = if ($env:CLAUDIBLE_VOICE) { $env:CLAUDIBLE_VOICE } else { Join-Path $env:USERPROFILE '.claudible\voice' }
New-Item -ItemType Directory -Force -Path $VOICE, (Join-Path $env:USERPROFILE '.claudible\logs') | Out-Null

# --- 1. uv (Python package manager for Kokoro) ------------------------------------------------------
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Say 'Installing uv...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id astral-sh.uv --accept-source-agreements --accept-package-agreements
  }
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    # winget absent or PATH not refreshed - use uv's own installer (same script setup.sh uses).
    Warn 'Falling back to the astral.sh uv installer...'
    powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
  }
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Warn "uv isn't on PATH yet - open a NEW PowerShell and re-run this script."
    exit 1
  }
}

# --- 2. Whisper - PREBUILT whisper-server.exe (no compiler) -----------------------------------------
$whisperExe = Join-Path $VOICE 'whisper\Release\whisper-server.exe'
if (-not (Test-Path $whisperExe)) {
  Say 'Installing Whisper (prebuilt whisper.cpp server - no compiler needed)...'
  # Resolve the latest release's whisper-bin-x64.zip; fall back to the pinned, verified v1.9.1 asset.
  $zipUrl = $null
  try {
    $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'
    $asset = $rel.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
    if ($asset) { $zipUrl = $asset.browser_download_url }
  } catch { }
  if (-not $zipUrl) { $zipUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip' }
  $tmpZip = Join-Path $env:TEMP 'whisper-bin-x64.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $tmpZip
  # The zip contains Release\whisper-server.exe + the ggml CPU DLLs (verified). Extract so the exe lands
  # at $VOICE\whisper\Release\whisper-server.exe with its DLLs alongside.
  Remove-Item -Recurse -Force (Join-Path $VOICE 'whisper\Release') -ErrorAction SilentlyContinue
  Expand-Archive -Path $tmpZip -DestinationPath (Join-Path $VOICE 'whisper') -Force
  Remove-Item $tmpZip -ErrorAction SilentlyContinue
  if (-not (Test-Path $whisperExe)) { Warn "whisper-server.exe not found after extract - check $zipUrl layout."; exit 1 }
} else { Say 'Whisper already installed.' }

# base speech model (~150 MB) - canonical whisper.cpp model host. Placed at models\ggml-base.bin so the
# server (started from $VOICE\whisper) finds it via `-m models\ggml-base.bin` (matches setup.sh/services.sh).
$model = Join-Path $VOICE 'whisper\models\ggml-base.bin'
if (-not (Test-Path $model)) {
  Say 'Downloading base speech model (~150 MB)...'
  New-Item -ItemType Directory -Force -Path (Split-Path $model) | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' -OutFile $model
} else { Say 'Whisper model already present.' }

# --- 3. Kokoro - FastAPI TTS (CPU torch via uv) -----------------------------------------------------
$kokoro = Join-Path $VOICE 'kokoro'
if (-not (Test-Path (Join-Path $kokoro '.git'))) {
  Say 'Installing Kokoro (TTS)...'
  Remove-Item -Recurse -Force $kokoro -ErrorAction SilentlyContinue
  git clone --depth 1 https://github.com/remsky/Kokoro-FastAPI $kokoro
  # $ErrorActionPreference='Stop' does NOT catch a native-exe non-zero exit, so check it explicitly and clean up
  # the partial clone — else the Test-Path guard above treats a half-clone as "already installed" on the next run.
  if ($LASTEXITCODE -ne 0) { Remove-Item -Recurse -Force $kokoro -ErrorAction SilentlyContinue; Warn 'Kokoro clone failed (network?). Re-run setup-win.ps1.'; exit 1 }
}
# CPU-only torch (matches setup.sh): the --extra cpu pulls torch+cpu, not the multi-GB CUDA wheel.
Say 'Installing/refreshing Kokoro CPU dependencies (this is the heavy step)...'
Push-Location $kokoro
try { uv sync --extra cpu } finally { Pop-Location }
# Pop-Location is a cmdlet so it leaves $LASTEXITCODE = uv's exit; a failed sync means broken voice deps — abort
# loudly instead of letting install.ps1 pin the win runner on a non-functional TTS stack.
if ($LASTEXITCODE -ne 0) { Warn 'uv sync failed - Kokoro CPU deps not installed. Re-run setup-win.ps1.'; exit 1 }

# model weights (~327 MB) - the repo gitignores *.pth, so a clone has none. download_model.py pulls them from the
# Kokoro-FastAPI v0.1.4 GitHub release and only checks existence + that config.json is JSON; an interrupted run, or
# a proxy/antivirus that rewrites GitHub-release responses, can leave a partial/!json file. So: treat a too-small
# .pth as missing, WIPE partials before each attempt (else they fool the next run's guard), and fall back to a
# direct download of the same release assets when the Python downloader can't produce a valid model.
$kRel   = 'https://github.com/remsky/Kokoro-FastAPI/releases/download/v0.1.4'
$kDir   = Join-Path $kokoro 'api\src\models\v1_0'
$kModel = Join-Path $kDir 'kokoro-v1_0.pth'
$kConf  = Join-Path $kDir 'config.json'
function Test-Kokoro { (Test-Path $kModel) -and ((Get-Item $kModel -EA SilentlyContinue).Length -gt 100MB) -and (Test-Path $kConf) }
if (-not (Test-Kokoro)) {
  Say 'Downloading Kokoro model weights (~327 MB)...'
  Remove-Item -Recurse -Force $kDir -ErrorAction SilentlyContinue          # clear any partial from a prior failed run
  Push-Location $kokoro
  try { uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0; if ($LASTEXITCODE -ne 0) { Warn "  model downloader exited $LASTEXITCODE — will try the direct fallback" } } catch { Warn "  model downloader errored: $($_.Exception.Message)" } finally { Pop-Location }
  if (-not (Test-Kokoro)) {
    Warn 'Python downloader did not produce a valid model - falling back to a direct download of the release assets...'
    New-Item -ItemType Directory -Force -Path $kDir | Out-Null
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$kRel/kokoro-v1_0.pth" -OutFile $kModel
      Invoke-WebRequest -UseBasicParsing -Uri "$kRel/config.json"     -OutFile $kConf
    } catch { Warn "  direct download failed: $($_.Exception.Message)" }
  }
  if (-not (Test-Kokoro)) {
    Remove-Item -Recurse -Force $kDir -ErrorAction SilentlyContinue        # don't leave a partial that fools the next run
    Warn 'Kokoro model could not be downloaded. The usual cause is a network/corporate proxy/antivirus blocking GitHub'
    Warn 'release assets. Try another network, or download these two files in a browser and drop them in the folder below:'
    Warn "    $kRel/kokoro-v1_0.pth"
    Warn "    $kRel/config.json"
    Warn "  -> $kDir"
    exit 1
  }
  Say 'Kokoro model ready.'
} else { Say 'Kokoro model already present.' }

Say 'Done. Native-Windows voice services are provisioned. Start Claudible with the win runner (install.ps1 -Native sets it up).'
Write-Host "  NOTE: the Kokoro runtime on Windows (uvicorn :8880 + espeak-ng phonemizer data) is not yet smoke-tested" -ForegroundColor Yellow
Write-Host "  on a real Windows box - if TTS doesn't bind, check $env:USERPROFILE\.claudible\logs\kokoro.out." -ForegroundColor Yellow
