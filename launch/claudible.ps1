# Claudible launcher - bring up the local voice services in WSL, then open the cockpit.
$ErrorActionPreference = "SilentlyContinue"
$app = Split-Path -Parent $PSScriptRoot           # repo root (this script lives in <repo>\launch)
# forward slashes: single backslashes get stripped crossing into WSL, so a raw C:\... reaches wslpath mangled
$appWsl = (wsl.exe wslpath -u ($app -replace '\\','/')).Trim()   # e.g. /mnt/c/Users/you/claudible

# 1. ensure WSL voice services (Kokoro + Whisper) are running
wsl.exe -e bash -lc "bash '$appWsl/wsl/services.sh'"

# 2. launch the Electron cockpit (detached so it lives independently of this script)
Set-Location $app
Start-Process -FilePath "cmd.exe" -ArgumentList '/c','npm','start' -WorkingDirectory $app -WindowStyle Hidden
