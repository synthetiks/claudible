# Creates a Desktop shortcut that launches Claudible. Paths derive from this script's location,
# so it works for any user/install dir - no hardcoded home.
$app = Split-Path -Parent $PSScriptRoot            # repo root (this script lives in <repo>\launch)
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'Claudible.lnk'
$lnk = $ws.CreateShortcut($path)
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$app\launch\claudible.ps1`""
$lnk.WorkingDirectory = $app
$icon = Join-Path $app 'assets\claudible.ico'        # the Claudible logo (headphones + mic)
if (Test-Path $icon) { $lnk.IconLocation = $icon }
else { $fallback = Join-Path $app 'node_modules\electron\dist\electron.exe'; if (Test-Path $fallback) { $lnk.IconLocation = "$fallback,0" } }
$lnk.Description = 'Claudible voice cockpit'
$lnk.Save()
Write-Output ("SHORTCUT -> " + $path)
