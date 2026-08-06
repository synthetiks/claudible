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

# ---- C-7.4 known-good checksums (SHA-256), verified against the ACTUAL files fetched below --------
# Computed 2026-08-06 by downloading each URL directly and hashing the bytes (Get-FileHash -Algorithm
# SHA256) -- not guessed, not copied from an upstream page. If either artifact is ever replaced at the
# same URL (a model re-upload, a corrected release asset) this check will legitimately start failing;
# re-verify by hand and update BOTH this block and setup.sh's matching block before trusting a new value.
# A value starting with 'TBD-' means nobody has verified it yet: the check WARNS instead of failing, loudly,
# so a placeholder can never be mistaken for a real pin.
$KNOWN_HASHES = @{
  # ggml-base.bin -- https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin (~148MB)
  'ggml-base.bin'   = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  # kokoro-v1_0.pth -- https://github.com/remsky/Kokoro-FastAPI/releases/download/v0.1.4/kokoro-v1_0.pth (~327MB)
  'kokoro-v1_0.pth' = '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4'
}
# Kokoro-FastAPI is git-cloned below -- pin the SAME tag the model weights above come from, not HEAD.
# Git itself integrity-tracks a pinned tag (its commit hash), unlike a bare branch clone.
$KOKORO_PIN_TAG = 'v0.1.4'
function Test-Checksum($path, $key) {
  $expected = $KNOWN_HASHES[$key]
  if ((-not $expected) -or ($expected.StartsWith('TBD-'))) { Warn "No verified checksum pinned for $key yet -- skipping integrity check (see setup-win.ps1's KNOWN_HASHES block)."; return $true }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLower()
  if ($actual -ne $expected) {
    Warn "CHECKSUM MISMATCH for $key -- the download does not match the pinned SHA-256."
    Warn "  expected: $expected"
    Warn "  actual:   $actual"
    return $false
  }
  return $true
}

$VOICE = if ($env:CLAUDIBLE_VOICE) { $env:CLAUDIBLE_VOICE } else { Join-Path $env:USERPROFILE '.claudible\voice' }
New-Item -ItemType Directory -Force -Path $VOICE, (Join-Path $env:USERPROFILE '.claudible\logs') | Out-Null

# --- 0. Stop any voice server that is still running -------------------------------------------------
# A LIVE server blocks its own reinstall on Windows: it holds its .venv / model files open, Windows refuses
# to delete an open file, and the `Remove-Item ... -ErrorAction SilentlyContinue` guards below swallow that
# failure. The directory then survives as a husk (typically just .venv), the git clone aborts with
# "already exists and is not an empty directory", and setup exits 1 - "Voice setup didn't finish (code 1)"
# on a machine whose voice looked fine, because the survivor was still answering on its port. Observed on a
# real box during the v0.9.1 smoke. So: stop them FIRST, every run. They are about to be replaced anyway,
# and the app restarts them (services.sh port-checks, so it is idempotent).
function Stop-VoiceServers {
  $stopped = 0
  Get-Process -Name 'whisper-server' -ErrorAction SilentlyContinue | ForEach-Object { $stopped++; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  # Match Kokoro's python on its COMMAND LINE (its venv lives under the voice dir), never by name: killing
  # every python.exe on the machine would take out unrelated work.
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'claudible' -and $_.CommandLine -match 'kokoro|uvicorn' } |
    ForEach-Object { $stopped++; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($stopped) { Say "Stopped $stopped running voice service(s) so their files can be replaced."; Start-Sleep -Seconds 2 }
}
Stop-VoiceServers

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

# --- 1b. ffmpeg - whisper-server decodes incoming audio with it ------------------------------------
# setup.sh installs ffmpeg on BOTH other platforms (apt on Linux, brew on macOS); this file simply never
# did, so whisper-server.exe started, loaded its CPU backend, then died on every transcription with
# "ffmpeg is not found. Please ensure that ffmpeg is installed and ... in your system's PATH" - STT was
# dead on arrival for every native-Windows install (found by the v0.9.1 smoke). Not fatal if it can't be
# installed: TTS is independent, so warn and continue rather than abort the whole voice setup.
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Say 'Installing ffmpeg (whisper needs it to decode audio)...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
    # winget updates the machine PATH, but THIS process keeps its stale copy - refresh it so the
    # verification below (and anything this script spawns later) can actually see the new exe.
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  }
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Warn 'ffmpeg is not on PATH - speech-to-text will not work until it is (text-to-speech is unaffected).'
    Warn 'Install it with:  winget install -e --id Gyan.FFmpeg   then restart Claudible.'
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
  # try/catch + a size floor around the download/extract: with $ErrorActionPreference='Stop', a network blip in
  # Invoke-WebRequest/Expand-Archive otherwise throws a raw .NET stack trace instead of the friendly Warn pattern
  # every other failure in this file uses (the model downloads below got this hardening in 03ad76f; this step
  # didn't). The zip is a few MB, so a sub-100KB file is a truncated download, not a real archive.
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $tmpZip
    if ((-not (Test-Path $tmpZip)) -or ((Get-Item $tmpZip).Length -lt 100KB)) { throw 'download was truncated' }
    # The zip contains Release\whisper-server.exe + the ggml CPU DLLs (verified). Extract so the exe lands
    # at $VOICE\whisper\Release\whisper-server.exe with its DLLs alongside.
    Remove-Item -Recurse -Force (Join-Path $VOICE 'whisper\Release') -ErrorAction SilentlyContinue
    Expand-Archive -Path $tmpZip -DestinationPath (Join-Path $VOICE 'whisper') -Force
  } catch {
    Remove-Item $tmpZip -ErrorAction SilentlyContinue
    Warn "Couldn't download or extract Whisper from $zipUrl - check your network and retry.  ($($_.Exception.Message))"; exit 1
  }
  Remove-Item $tmpZip -ErrorAction SilentlyContinue
  if (-not (Test-Path $whisperExe)) { Warn "whisper-server.exe not found after extract - check $zipUrl layout."; exit 1 }
} else { Say 'Whisper already installed.' }

# base speech model (~150 MB) - canonical whisper.cpp model host. Placed at models\ggml-base.bin so the
# server (started from $VOICE\whisper) finds it via `-m models\ggml-base.bin` (matches setup.sh/services.sh).
# Size guard (real file is ~140MB, mirrors Test-Kokoro below) - an interrupted download leaves a small/truncated
# file that a bare Test-Path would treat as "present" forever, so wipe it before retrying.
$model = Join-Path $VOICE 'whisper\models\ggml-base.bin'
function Test-Whisper { (Test-Path $model) -and ((Get-Item $model -EA SilentlyContinue).Length -gt 100MB) }
if (-not (Test-Whisper)) {
  Say 'Downloading base speech model (~150 MB)...'
  Remove-Item -Force $model -ErrorAction SilentlyContinue     # clear any truncated partial from a prior failed run
  New-Item -ItemType Directory -Force -Path (Split-Path $model) | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' -OutFile $model
  if (-not (Test-Whisper)) { Remove-Item -Force $model -ErrorAction SilentlyContinue; Warn 'Whisper model download failed or was truncated - check your network, then re-run setup-win.ps1.'; exit 1 }
  if (-not (Test-Checksum $model 'ggml-base.bin')) { Remove-Item -Force $model -ErrorAction SilentlyContinue; Warn 'Whisper model failed its integrity check - a corrupted or tampered download must never be used. Check your network, then re-run setup-win.ps1.'; exit 1 }
} else { Say 'Whisper model already present.' }

# --- 3. Kokoro - FastAPI TTS (CPU torch via uv) -----------------------------------------------------
$kokoro = Join-Path $VOICE 'kokoro'
if (-not (Test-Path (Join-Path $kokoro '.git'))) {
  Say 'Installing Kokoro (TTS)...'
  Remove-Item -Recurse -Force $kokoro -ErrorAction SilentlyContinue
  # VERIFY the removal. It is silenced above, and on Windows it half-fails whenever any file is open - which is
  # exactly what a still-running Kokoro does to its own .venv. git clone then aborts with "already exists and is
  # not an empty directory", and the old message blamed the NETWORK for a file lock, sending people to check
  # their wifi over a held handle. Stop-VoiceServers ran at the top, so a survivor here is something else
  # holding the folder (an open shell sitting in it, an antivirus scan, an editor) - name that instead.
  if (Test-Path $kokoro) {
    Warn "Could not clear $kokoro - a file in it is still open."
    Warn 'Close anything using that folder (a terminal sitting in it, an editor, an antivirus scan), then re-run setup-win.ps1.'
    exit 1
  }
  git clone --depth 1 --branch $KOKORO_PIN_TAG https://github.com/remsky/Kokoro-FastAPI $kokoro
  # $ErrorActionPreference='Stop' does NOT catch a native-exe non-zero exit, so check it explicitly and clean up
  # the partial clone - else the Test-Path guard above treats a half-clone as "already installed" on the next run.
  if ($LASTEXITCODE -ne 0) { Remove-Item -Recurse -Force $kokoro -ErrorAction SilentlyContinue; Warn 'Kokoro clone failed (network?). Re-run setup-win.ps1.'; exit 1 }
}
# Kokoro asks for misaki[en,ja,ko,zh]; the ja extra drags in pyopenjtalk, which ships NO Windows wheel and
# builds from source with cmake + an MSVC toolchain. A normal Windows box has neither, so `uv sync` died with
# "CMAKE_C_COMPILER not set" / "'nmake' failed" and voice never installed - the whole point of this native
# path is no Visual Studio, no compiler. We speak English here (services.sh serves the en voices), so keep
# misaki[en] and drop the CJK extras: pure wheels, no toolchain. Rewritten in the CLONE, not upstream, and
# idempotent (the regex only matches the un-patched line, and a re-run re-applies it after any git pull).
$pyproj = Join-Path $kokoro 'pyproject.toml'
if (Test-Path $pyproj) {
  $tomlRaw = [System.IO.File]::ReadAllText($pyproj)
  $tomlNew = [regex]::Replace($tomlRaw, 'misaki\[[a-z,]*\]', 'misaki[en]')
  if ($tomlNew -ne $tomlRaw) {
    [System.IO.File]::WriteAllText($pyproj, $tomlNew, (New-Object System.Text.UTF8Encoding $false))
    Say 'Patched Kokoro deps for Windows: English voices only (the CJK extras need a C++ compiler).'
  }
}
# CPU-only torch (matches setup.sh): the --extra cpu pulls torch+cpu, not the multi-GB CUDA wheel.
Say 'Installing/refreshing Kokoro CPU dependencies (this is the heavy step)...'
Push-Location $kokoro
try { uv sync --extra cpu } finally { Pop-Location }
# Pop-Location is a cmdlet so it leaves $LASTEXITCODE = uv's exit; a failed sync means broken voice deps - abort
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
  try { uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0; if ($LASTEXITCODE -ne 0) { Warn "  model downloader exited $LASTEXITCODE - will try the direct fallback" } } catch { Warn "  model downloader errored: $($_.Exception.Message)" } finally { Pop-Location }
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
  if (-not (Test-Checksum $kModel 'kokoro-v1_0.pth')) {
    Remove-Item -Recurse -Force $kDir -ErrorAction SilentlyContinue
    Warn 'Kokoro model failed its integrity check - a corrupted or tampered download must never be used. Re-run setup-win.ps1.'
    exit 1
  }
  Say 'Kokoro model ready.'
} else { Say 'Kokoro model already present.' }

Say 'Done. Native-Windows voice services are provisioned. Start Claudible with the win runner (install.ps1 -Native sets it up).'
Write-Host "  NOTE: the Kokoro runtime on Windows (uvicorn :8880 + espeak-ng phonemizer data) is not yet smoke-tested" -ForegroundColor Yellow
Write-Host "  on a real Windows box - if TTS doesn't bind, check $env:USERPROFILE\.claudible\logs\kokoro.out." -ForegroundColor Yellow
