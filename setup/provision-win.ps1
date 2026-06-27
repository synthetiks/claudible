# setup/provision-win.ps1 — per-dependency installer for the self-bootstrapping provisioner (runners/deps.js).
#
# Installs ONE dependency (winget primary, direct-download fallback). Spawned by deps.js installWin() as
#   powershell -NoProfile -ExecutionPolicy Bypass -File provision-win.ps1 -Dep <id>
# and communicates over a tiny line protocol on STDOUT (deps.js attaches readline):
#   "PHASE|message"      PHASE in start|progress|done|error  → streamed to the System-check row
#   "env|CLAUDIBLE_X=p"  a portable (no-winget / no-UAC) fallback's env var → main.js persists + applies it
# Anything else on stdout is ignored. Exit 0 = success, non-zero = failure (deps.js reports it).
#
# Idempotent: each dep is presence-checked, so re-running a present dep is a no-op. Reuses install.ps1's Node
# winget block + setup-win.ps1's uv block. STATUS: authored + statically verified; the winget path is the
# proven one (it's what install.ps1 uses). The portable fallbacks are the no-UAC route and need a Windows
# smoke test (docs/SMOKE.md) — most Win10/11 boxes have winget, so the fallback is the exception, not the rule.

param([Parameter(Mandatory = $true)][ValidateSet('node', 'git', 'claude', 'uv', 'cloudflared', 'gh')][string]$Dep)
$ErrorActionPreference = 'Stop'

function Emit($phase, $msg) { Write-Host "$phase|$msg"; try { [Console]::Out.Flush() } catch {} }
function EmitEnv($k, $v) { Write-Host "env|$k=$v"; try { [Console]::Out.Flush() } catch {} }
function Tool($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Have-Winget { [bool](Get-Command winget -ErrorAction SilentlyContinue) }
# winget updates the registry PATH, not this process — reload it (same idiom as install.ps1:40) so a just-
# installed tool resolves for the presence check below.
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Try-Winget($id) {
  if (-not (Have-Winget)) { return }
  Emit 'progress' "Installing via winget ($id)… a Windows permission prompt may appear."
  try { Start-Process 'winget' -ArgumentList @('install', '-e', '--id', $id, '--accept-source-agreements', '--accept-package-agreements', '--silent') -Wait -WindowStyle Hidden | Out-Null } catch {}
  Refresh-Path   # success is decided by a presence re-check, not winget's exit code (idempotent: "already installed" != failure)
}
$BIN = Join-Path $env:USERPROFILE '.claudible\bin'   # portable-fallback drop dir (no admin)
function Ensure-Bin { New-Item -ItemType Directory -Force -Path $BIN | Out-Null }

try {
  switch ($Dep) {

    'node' {
      Emit 'start' 'Installing Node.js…'
      if (-not (Tool 'node')) { Try-Winget 'OpenJS.NodeJS.LTS' }
      if (-not (Tool 'node')) {
        Emit 'progress' 'winget unavailable — downloading the Node.js zip (no admin needed)…'
        Ensure-Bin
        $a = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $url = $null
        try {
          $idx = Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 'https://nodejs.org/dist/index.json'
          $lts = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version
          if ($lts) { $url = "https://nodejs.org/dist/$lts/node-$lts-win-$a.zip" }
        } catch {}
        if (-not $url) { $url = "https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-$a.zip" }   # pinned LTS fallback
        $zip = Join-Path $env:TEMP 'node-claudible.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
        $dest = Join-Path $BIN 'node'
        Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
        Expand-Archive -Path $zip -DestinationPath $dest -Force
        Remove-Item $zip -ErrorAction SilentlyContinue
        $nodeExe = Get-ChildItem -Path $dest -Recurse -Filter 'node.exe' | Select-Object -First 1
        if (-not $nodeExe) { Emit 'error' 'Node download did not contain node.exe.'; exit 1 }
        EmitEnv 'CLAUDIBLE_NODE' $nodeExe.FullName
        $env:Path = (Split-Path $nodeExe.FullName) + ';' + $env:Path
      }
      if (-not (Tool 'node') -and -not $env:CLAUDIBLE_NODE) { Emit 'error' 'Node not found after install.'; exit 1 }
      Emit 'done' 'Node.js ready.'
    }

    'git' {
      Emit 'start' 'Installing Git for Windows…'
      if (-not (Tool 'git')) { Try-Winget 'Git.Git' }
      if (-not (Tool 'git')) {
        Emit 'progress' 'winget unavailable — downloading PortableGit (no admin needed)…'
        Ensure-Bin
        $sfxUrl = $null
        try {
          $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'claudible' } 'https://api.github.com/repos/git-for-windows/git/releases/latest'
          $sfxUrl = ($rel.assets | Where-Object { $_.name -match 'PortableGit-.*-64-bit\.7z\.exe' } | Select-Object -First 1).browser_download_url
        } catch {}
        if (-not $sfxUrl) { Emit 'error' 'Could not resolve PortableGit (network/proxy?). Install Git from https://git-scm.com/download/win and reopen.'; exit 1 }
        $sfx = Join-Path $env:TEMP 'PortableGit.7z.exe'
        Invoke-WebRequest -UseBasicParsing -Uri $sfxUrl -OutFile $sfx
        $dest = Join-Path $BIN 'git'
        Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Emit 'progress' 'Extracting Git…'
        Start-Process -FilePath $sfx -ArgumentList @("-o`"$dest`"", '-y') -Wait -WindowStyle Hidden | Out-Null   # 7-Zip SFX: silent extract
        Remove-Item $sfx -ErrorAction SilentlyContinue
        $bash = Join-Path $dest 'bin\bash.exe'
        if (-not (Test-Path $bash)) { Emit 'error' 'PortableGit did not extract a bash.exe.'; exit 1 }
        EmitEnv 'CLAUDIBLE_GIT_BASH' $bash
      }
      Emit 'done' 'Git ready.'
    }

    'uv' {
      Emit 'start' 'Installing uv…'
      if (-not (Tool 'uv')) { Try-Winget 'astral-sh.uv' }
      if (-not (Tool 'uv')) {
        Emit 'progress' 'Installing uv via the astral.sh script…'
        try { & powershell -NoProfile -ExecutionPolicy ByPass -Command 'irm https://astral.sh/uv/install.ps1 | iex' } catch {}
        $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
      }
      if (-not (Tool 'uv') -and -not (Test-Path (Join-Path $env:USERPROFILE '.local\bin\uv.exe'))) { Emit 'error' 'uv not found after install.'; exit 1 }
      Emit 'done' 'uv ready.'
    }

    'claude' {
      Emit 'start' 'Installing the Claude Code CLI…'
      if ($env:CLAUDIBLE_NODE) { $env:Path = (Split-Path $env:CLAUDIBLE_NODE) + ';' + $env:Path }   # portable Node fallback: make its bundled npm visible
      if (-not (Tool 'npm')) { Refresh-Path }
      if (-not (Tool 'npm')) { Emit 'error' 'npm not found — install Node first.'; exit 1 }
      Emit 'progress' 'npm install -g @anthropic-ai/claude-code …'
      & cmd /c 'npm install -g @anthropic-ai/claude-code 2>&1' | Out-Null   # cmd /c sidesteps PowerShell native-stderr quirks
      if ($LASTEXITCODE -ne 0) { Emit 'error' 'npm install of Claude Code failed (see %USERPROFILE%\.claudible\logs).'; exit 1 }
      Refresh-Path
      Emit 'done' 'Claude Code installed — sign in next.'
    }

    'cloudflared' {
      Emit 'start' 'Installing cloudflared…'
      if (-not (Tool 'cloudflared')) { Try-Winget 'Cloudflare.cloudflared' }
      if (-not (Tool 'cloudflared')) {
        Emit 'progress' 'Downloading the cloudflared binary…'
        Ensure-Bin
        $exe = Join-Path $BIN 'cloudflared.exe'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe
        if (-not (Test-Path $exe)) { Emit 'error' 'cloudflared download failed.'; exit 1 }
        EmitEnv 'CLAUDIBLE_CLOUDFLARED' $exe
      }
      Emit 'done' 'cloudflared ready.'
    }

    'gh' {
      Emit 'start' 'Installing the GitHub CLI…'
      if (-not (Tool 'gh')) { Try-Winget 'GitHub.cli' }
      if (-not (Tool 'gh')) { Emit 'error' 'winget unavailable — install the GitHub CLI from https://cli.github.com and reopen.'; exit 1 }
      Emit 'done' 'GitHub CLI ready — sign in with: gh auth login'
    }
  }
  exit 0
}
catch {
  Emit 'error' ($_.Exception.Message)
  exit 1
}
