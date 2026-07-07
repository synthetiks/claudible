# Claudible launcher - bring up the local voice services in WSL, then open the cockpit.
$ErrorActionPreference = "SilentlyContinue"
$app = Split-Path -Parent $PSScriptRoot           # repo root (this script lives in <repo>\launch)
# forward slashes: single backslashes get stripped crossing into WSL, so a raw C:\... reaches wslpath mangled
$appWsl = (wsl.exe wslpath -u ($app -replace '\\','/')).Trim()   # e.g. /mnt/c/Users/you/claudible

# 1. kick the WSL voice services (Kokoro + Whisper) in the BACKGROUND — never gate the app on them.
#    A synchronous wsl.exe call here used to hang the whole launcher on first boot: the freshly-spawned
#    daemons held the WSL pseudo-console open, wsl.exe never returned, and the user stared at a dead
#    PowerShell window until Ctrl+C. Fire-and-forget + the app's own voice health-poll = cockpit opens
#    instantly, voice dots go green whenever the services finish warming up.
Start-Process -FilePath "wsl.exe" -ArgumentList '-e','bash','-lc',"bash '$appWsl/wsl/services.sh' >/dev/null 2>&1" -WindowStyle Hidden

# 2. launch the Electron cockpit (detached so it lives independently of this script)
Set-Location $app
Start-Process -FilePath "cmd.exe" -ArgumentList '/c','npm','start' -WorkingDirectory $app -WindowStyle Hidden
