# setup/provision-win.ps1 - per-dependency installer for the self-bootstrapping provisioner (runners/deps.js).
#
# Installs ONE dependency (winget primary, direct-download fallback). Spawned by deps.js installWin() as
#   powershell -NoProfile -ExecutionPolicy Bypass -File provision-win.ps1 -Dep <id>
# and communicates over a tiny line protocol on STDOUT (deps.js attaches readline):
#   "PHASE|message"      PHASE in start|progress|done|error  -> streamed to the System-check row
#   "env|CLAUDIBLE_X=p"  a portable (no-winget / no-UAC) fallback's env var -> main.js persists + applies it
# Anything else on stdout is ignored. Exit 0 = success, non-zero = failure (deps.js reports it).
#
# Idempotent: each dep is presence-checked, so re-running a present dep is a no-op. Reuses install.ps1's Node
# winget block + setup-win.ps1's uv block. STATUS: authored + statically verified; the winget path is the
# proven one (it's what install.ps1 uses). The portable fallbacks are the no-UAC route and need a Windows
# smoke test (docs/SMOKE.md) - most Win10/11 boxes have winget, so the fallback is the exception, not the rule.

# 'voice' is DELIBERATELY absent from this set, and that is load-bearing rather than an oversight. On Windows
# voice does not come through here at all: main.js's preflight:install intercepts id==='voice' when
# runner.id==='win' and routes it to ensureVoiceProvisioned, which runs setup/setup-win.ps1 (git clone of
# Kokoro, model download, uv env) - work this per-dep installer has no case for. runners/deps.js says the same
# thing from the other side. The set is what makes that contract fail LOUDLY: if the interception is ever
# refactored away, voice-on-Windows dies here on a PowerShell parameter-binding error naming $Dep, instead of
# silently doing nothing. Adding 'voice' without also adding a real implementation below would trade a loud
# failure for a silent success - exactly backwards. If voice ever DOES belong here, add the switch case first.
param([Parameter(Mandatory = $true)][ValidateSet('node', 'git', 'claude', 'uv', 'cloudflared', 'gh', 'ffmpeg')][string]$Dep)
$ErrorActionPreference = 'Stop'

# ---- C-7.4 known-good checksums (SHA-256), verified against the ACTUAL files fetched below -----------
# Same discipline as setup.sh/setup-win.ps1's checksum blocks: computed by downloading each URL directly
# and hashing the real bytes (Get-FileHash -Algorithm SHA256) -- never guessed, never copied from an
# upstream page. A value starting with 'TBD-' means nobody has verified it yet, and Fetch-Verified below
# FAILS CLOSED on a TBD/missing pin or a mismatch: an unverified binary is never extracted or executed.
# Re-verify by hand and update this block from the official host only, before trusting a new value.
#
# Computed 2026-08-12 by a one-time maintainer-verified fetch made solely for THIS pin-fill:
# each URL below was downloaded to a scratch dir, hashed with Get-FileHash -Algorithm SHA256, the bytes
# deleted immediately after, and the hash lowercased to match Fetch-Verified's comparison. None of these
# values were copied from a webpage.
#   node-v22.12.0-win-x64.zip   -- https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip
#     34872043 bytes observed. Cross-checked against https://nodejs.org/dist/v22.12.0/SHASUMS256.txt
#     (published by nodejs.org itself) -- MATCH. Cross-check is a tiebreak aid only; the pin below is the
#     value this session computed from the downloaded bytes, not the value copied from that file.
#   node-v22.12.0-win-arm64.zip -- https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-arm64.zip
#     30538928 bytes observed. Cross-checked against the same SHASUMS256.txt -- MATCH.
#   PortableGit -- github.com/git-for-windows/git releases/latest resolved (at pin time) to tag
#     v2.55.0.windows.4; its single asset matching ^PortableGit-.*-64-bit\.7z\.exe$ is
#     PortableGit-2.55.0.4-64-bit.7z.exe, browser_download_url frozen into $GIT_PORTABLE_URL below.
#     58915456 bytes observed, hashed from those exact bytes.
#   cloudflared -- github.com/cloudflare/cloudflared releases/latest resolved (at pin time) to tag
#     2026.7.3; asset cloudflared-windows-amd64.exe, browser_download_url frozen into $CLOUDFLARED_URL
#     below. 54213360 bytes observed, hashed from those exact bytes.
$PINS = @{
  'node-x64'    = '2b8f2256382f97ad51e29ff71f702961af466c4616393f767455501e6aece9b8'
  'node-arm64'  = '17401720af48976e3f67c41e8968a135fb49ca1f88103a92e0e8c70605763854'
  'PortableGit' = '016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5'
  'cloudflared' = '8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841'
}
$NODE_PIN = 'v22.12.0'
# Frozen at pin time (2026-08-12) from releases/latest tag v2.55.0.windows.4 -- see the pin comment above.
$GIT_PORTABLE_URL = 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/PortableGit-2.55.0.4-64-bit.7z.exe'
# Frozen at pin time (2026-08-12) from releases/latest tag 2026.7.3 -- see the pin comment above.
$CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-windows-amd64.exe'

function Emit($phase, $msg) { Write-Host "$phase|$msg"; try { [Console]::Out.Flush() } catch {} }
function EmitEnv($k, $v) { Write-Host "env|$k=$v"; try { [Console]::Out.Flush() } catch {} }
function Tool($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Have-Winget { [bool](Get-Command winget -ErrorAction SilentlyContinue) }
# winget updates the registry PATH, not this process - reload it (same idiom as install.ps1:40) so a just-
# installed tool resolves for the presence check below.
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Try-Winget($id) {
  if (-not (Have-Winget)) { return }
  Emit 'progress' "Installing via winget ($id)... a Windows permission prompt may appear."
  try { Start-Process 'winget' -ArgumentList @('install', '-e', '--id', $id, '--accept-source-agreements', '--accept-package-agreements', '--silent') -Wait -WindowStyle Hidden | Out-Null } catch {}
  Refresh-Path   # success is decided by a presence re-check, not winget's exit code (idempotent: "already installed" != failure)
}
$BIN = Join-Path $env:USERPROFILE '.claudible\bin'   # portable-fallback drop dir (no admin)
function Ensure-Bin { New-Item -ItemType Directory -Force -Path $BIN | Out-Null }
# Classify a download failure AT THE SOURCE (parity with wsl/install-claude.sh's network case): the raw
# Invoke-WebRequest throw is .NET internals ("Exception calling \"GetResponse\"", "The remote name could not
# be resolved: 'nodejs.org'") - the WSL side turned those into actionable English and this side did not.
# Exit here, not throw: the global catch would re-wrap the message we just curated.
function Is-NetworkError($msg) {
  return ($msg -match 'could not be resolved|Unable to connect|connection.*(closed|refused)|timed out|timeout|TLS|SSL|secure channel|proxy|407|network path')
}
function Fetch($url, $out, $what) {
  try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out }
  catch {
    $m = $_.Exception.Message
    if (Is-NetworkError $m) { Emit 'error' "Network problem downloading $what - check your connection (or proxy) and press Install again." }
    else { Emit 'error' "Could not download $what - $m" }
    exit 1
  }
}
# Fetch, then verify against $PINS[$pinKey] before the caller extracts/executes anything. Fails CLOSED:
# a missing/TBD pin or a hash mismatch deletes the download and exits, same discipline as setup.sh/
# setup-win.ps1's verify_checksum / Test-Checksum.
function Fetch-Verified($url, $out, $what, $pinKey) {
  Fetch $url $out $what
  $expected = $PINS[$pinKey]
  if ((-not $expected) -or ($expected.StartsWith('TBD-'))) {
    Remove-Item $out -ErrorAction SilentlyContinue
    Emit 'error' "REFUSING: $what failed SHA-256 verification (or has no pin) - not extracting/executing an unverified binary."
    exit 1
  }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Remove-Item $out -ErrorAction SilentlyContinue
    Emit 'error' "REFUSING: $what failed SHA-256 verification (or has no pin) - not extracting/executing an unverified binary."
    exit 1
  }
}

try {
  switch ($Dep) {

    'node' {
      Emit 'start' 'Installing Node.js...'
      if (-not (Tool 'node')) { Try-Winget 'OpenJS.NodeJS.LTS' }
      if (-not (Tool 'node')) {
        Emit 'progress' 'winget unavailable - downloading the Node.js zip (no admin needed)...'
        Ensure-Bin
        $a = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        # PINNED version only -- a floating index.json "latest LTS" resolution is unverifiable by
        # construction (the SHA-256 pins above are for THIS exact version; a moving target would make
        # those pins meaningless).
        $url = "https://nodejs.org/dist/$NODE_PIN/node-$NODE_PIN-win-$a.zip"
        $zip = Join-Path $env:TEMP 'node-claudible.zip'
        Fetch-Verified $url $zip 'Node.js' "node-$a"
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
      Emit 'start' 'Installing Git for Windows...'
      if (-not (Tool 'git')) { Try-Winget 'Git.Git' }
      if (-not (Tool 'git')) {
        Emit 'progress' 'winget unavailable - downloading PortableGit (no admin needed)...'
        Ensure-Bin
        # PINNED URL only -- a floating releases/latest API resolution is unverifiable by construction
        # (the SHA-256 pin above is for THIS exact asset; a moving target would make that pin meaningless).
        $sfxUrl = $GIT_PORTABLE_URL
        $sfx = Join-Path $env:TEMP 'PortableGit.7z.exe'
        Fetch-Verified $sfxUrl $sfx 'PortableGit' 'PortableGit'
        $dest = Join-Path $BIN 'git'
        Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Emit 'progress' 'Extracting Git...'
        Start-Process -FilePath $sfx -ArgumentList @("-o`"$dest`"", '-y') -Wait -WindowStyle Hidden | Out-Null   # 7-Zip SFX: silent extract
        Remove-Item $sfx -ErrorAction SilentlyContinue
        $bash = Join-Path $dest 'bin\bash.exe'
        if (-not (Test-Path $bash)) { Emit 'error' 'PortableGit did not extract a bash.exe.'; exit 1 }
        EmitEnv 'CLAUDIBLE_GIT_BASH' $bash
      }
      Emit 'done' 'Git ready.'
    }

    'uv' {
      Emit 'start' 'Installing uv...'
      if (-not (Tool 'uv')) { Try-Winget 'astral-sh.uv' }
      if (-not (Tool 'uv')) {
        Emit 'progress' 'Installing uv via the astral.sh script...'
        try { & powershell -NoProfile -ExecutionPolicy ByPass -Command 'irm https://astral.sh/uv/install.ps1 | iex' } catch {}
        $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
      }
      if (-not (Tool 'uv') -and -not (Test-Path (Join-Path $env:USERPROFILE '.local\bin\uv.exe'))) { Emit 'error' 'uv not found after install.'; exit 1 }
      Emit 'done' 'uv ready.'
    }

    'claude' {
      Emit 'start' 'Installing the Claude Code CLI...'
      if ($env:CLAUDIBLE_NODE) { $env:Path = (Split-Path $env:CLAUDIBLE_NODE) + ';' + $env:Path }   # portable Node fallback: make its bundled npm visible
      if (-not (Tool 'npm')) { Refresh-Path }
      if (-not (Tool 'npm')) { Emit 'error' 'npm not found - install Node first.'; exit 1 }
      Emit 'progress' 'npm install -g @anthropic-ai/claude-code ...'
      # KEEP THE REASON. This used to throw npm's entire output away and judge the install by the exit code
      # alone, so the two failures that actually happen were both invisible: a plain install error nobody could
      # read, and - worse - an install that exits 0 with the Windows program skipped (it ships as an optional
      # piece; npm skips it quietly and leaves a launcher that cannot start). Ask for the optional piece,
      # keep every line in a log, and prove the result RUNS before reporting success.
      $logDir = Join-Path $env:USERPROFILE '.claudible\logs'
      New-Item -ItemType Directory -Force -Path $logDir | Out-Null
      $log = Join-Path $logDir 'claude-install.log'
      $out = & cmd /c 'npm install -g @anthropic-ai/claude-code --include=optional --foreground-scripts 2>&1'   # cmd /c sidesteps PowerShell native-stderr quirks
      $code = $LASTEXITCODE
      $out | Out-File -FilePath $log -Encoding ascii
      $tail = (($out | Select-Object -Last 3) -join ' ') -replace '[\r\n]+', ' '   # one line: the report channel is line-based
      if ($code -ne 0) { Emit 'error' "npm install of Claude Code failed - $tail (full log: $log)"; exit 1 }
      Refresh-Path
      $verOut = & cmd /c 'claude --version 2>&1'
      $verCode = $LASTEXITCODE
      if (($verCode -ne 0) -or (-not (Tool 'claude'))) {
        $vt = (($verOut | Select-Object -Last 2) -join ' ') -replace '[\r\n]+', ' '
        Emit 'error' "npm reported success but Claude Code will not start - $vt $tail (full log: $log)"
        exit 1
      }
      Emit 'done' 'Claude Code installed - sign in next.'
    }

    'cloudflared' {
      Emit 'start' 'Installing cloudflared...'
      if (-not (Tool 'cloudflared')) { Try-Winget 'Cloudflare.cloudflared' }
      if (-not (Tool 'cloudflared')) {
        Emit 'progress' 'Downloading the cloudflared binary...'
        Ensure-Bin
        $exe = Join-Path $BIN 'cloudflared.exe'
        # PINNED URL only -- a floating releases/latest/download resolution is unverifiable by construction
        # (the SHA-256 pin above is for THIS exact asset; a moving target would make that pin meaningless).
        Fetch-Verified $CLOUDFLARED_URL $exe 'cloudflared' 'cloudflared'
        if (-not (Test-Path $exe)) { Emit 'error' 'cloudflared download failed.'; exit 1 }
        EmitEnv 'CLAUDIBLE_CLOUDFLARED' $exe
      }
      Emit 'done' 'cloudflared ready.'
    }

    'gh' {
      Emit 'start' 'Installing the GitHub CLI...'
      if (-not (Tool 'gh')) { Try-Winget 'GitHub.cli' }
      if (-not (Tool 'gh')) { Emit 'error' 'winget unavailable - install the GitHub CLI from https://cli.github.com and reopen.'; exit 1 }
      Emit 'done' 'GitHub CLI ready - sign in with: gh auth login'
    }

    'ffmpeg' {
      # Same winget id setup-win.ps1's own (bundled-into-Voice) install already uses - keep the two in sync.
      # Idempotent by construction: if the row is clicked after Voice already installed ffmpeg, Tool 'ffmpeg'
      # is true and this is a no-op done immediately; setup-win.ps1's own `Get-Command ffmpeg` guard is the
      # other half of that same idempotency, so installing this row first makes ITS ffmpeg step a no-op too.
      Emit 'start' 'Installing ffmpeg...'
      if (-not (Tool 'ffmpeg')) { Try-Winget 'Gyan.FFmpeg' }
      if (-not (Tool 'ffmpeg')) { Emit 'error' 'winget unavailable - install ffmpeg from https://www.gyan.dev/ffmpeg/builds/ (or winget install -e --id Gyan.FFmpeg) and reopen.'; exit 1 }
      Emit 'done' 'ffmpeg ready.'
    }
  }
  exit 0
}
catch {
  # Last-resort classification - anything the per-download Fetch didn't already curate. Network shapes get
  # the actionable line; everything else keeps the real message (renderer-side installErrText de-fangs the
  # known .NET internals as the final layer).
  $m = $_.Exception.Message
  if (Is-NetworkError $m) { Emit 'error' 'Network problem during the install - check your connection (or proxy) and press Install again.' }
  else { Emit 'error' $m }
  exit 1
}
