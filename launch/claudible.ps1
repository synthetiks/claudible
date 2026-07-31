# Claudible launcher - open the cockpit. The app itself brings up the local voice services.
$ErrorActionPreference = "SilentlyContinue"
$app = Split-Path -Parent $PSScriptRoot           # repo root (this script lives in <repo>\launch)

# Voice services (Kokoro + Whisper) are NOT started here on purpose. main.js starts them on every launch
# (did-finish-load -> runner.startVoiceServices -> wsl/services.sh), so a second launch-side invocation only
# created a cold-boot RACE: both callers saw the port unbound and each spawned their own uvicorn/whisper,
# doubling the ~327MB Kokoro/torch load mid-boot-storm (one dies on EADDRINUSE, the winner can miss its
# readiness window). Letting the app be the single owner removes the race - and makes the old first-boot
# PowerShell hang structurally impossible, since nothing blocking runs here at all. services.sh stays
# idempotent + detaches its daemons (</dev/null) so the app's own async call never hangs either.

# Launch the Electron cockpit (detached so it lives independently of this script).
Set-Location $app
Start-Process -FilePath "cmd.exe" -ArgumentList '/c','npm','start' -WorkingDirectory $app -WindowStyle Hidden
