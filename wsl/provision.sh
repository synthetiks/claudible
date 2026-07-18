#!/usr/bin/env bash
# wsl/provision.sh — install ONE dependency on WSL / native Linux / macOS for the self-bootstrapping
# provisioner (runners/deps.js installPosix). Claude itself uses install-claude.sh; this handles the rest.
# Emits a single JSON line {"ok":bool[,"error":str]}. Mirrors setup/setup.sh's apt/brew/curl branches.
# (node via the distro package may be older than 22.12 — the proven WSL voice path is the recommended one;
# detection will flag an outdated node so the user can upgrade.)

dep="$1"
ok()  { printf '{"ok":true}\n'; exit 0; }
err() { printf '{"ok":false,"error":"%s"}\n' "$(printf '%s' "$1" | tr -d '\000-\037"\\')"; exit 0; }
have() { command -v "$1" >/dev/null 2>&1; }
# Run a command with root privileges — directly if we already ARE root, else via sudo, but ONLY if sudo can run
# WITHOUT a password. This script is invoked through runScript() with NO TTY and NO stdin (wsl.js: cp.execFile
# 'wsl.exe' '-e' 'bash' '-lc'), so a sudo that needs a password can never succeed — it fails instantly. When that
# is the case as_root returns the sentinel 2, so callers can report the accurate "run this yourself" message
# instead of the misleading "no apt/brew" one the old code emitted for what is really a permissions problem.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; return $?; fi
  sudo -n true 2>/dev/null || return 2
  sudo "$@"
}
pkg_err() {   # $1 = dep, $2 = the failing pkg() exit code → the accurate, actionable error
  case "$2" in
    2) err "installing $1 needs admin rights, and this installer has no way to prompt for your password — open your WSL/Linux terminal and run:  sudo apt-get install -y $1" ;;
    1) err "no package manager (apt or brew) found — install $1 manually, then retry" ;;
    *) err "$1 could not be installed automatically — install it manually, then retry" ;;
  esac
}
pkg() {   # install system packages via apt (Debian/WSL, needs root) or brew (macOS, no root); distinct exit codes
  if have apt-get; then
    as_root true || return 2                                       # can't get root non-interactively → tell the truth
    as_root apt-get update -y >/dev/null 2>&1; as_root apt-get install -y "$@" >/dev/null 2>&1
  elif have brew; then brew install "$@" >/dev/null 2>&1
  else return 1; fi
}

case "$dep" in
  node)
    # Presence isn't enough — Claudible needs >=22.12, and the distro 'nodejs' package is often older. Gate on
    # VERSION (not just `have node`) so the System-check wizard can actually self-heal an outdated node.
    nok() { have node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' >/dev/null 2>&1; }
    nok && ok
    if have apt-get; then
      as_root true || err "installing Node needs admin rights, and this installer has no way to prompt for your password — open your WSL/Linux terminal and run:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -  &&  sudo apt-get install -y nodejs"
      if [ "$(id -u)" = 0 ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
      else curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1; fi
      as_root apt-get install -y nodejs >/dev/null 2>&1
    elif have brew; then brew install node@22 >/dev/null 2>&1; brew link --overwrite --force node@22 >/dev/null 2>&1
    else err "no apt/brew to install node"; fi
    nok && ok || err "node is still older than 22.12 — upgrade from https://nodejs.org"
    ;;
  git)         have git && ok;  pkg git; rc=$?; have git && ok;  pkg_err git "$rc" ;;
  gh)          have gh && ok;   pkg gh;  rc=$?; have gh && ok
               [ "$rc" = 2 ] && err "installing gh needs admin rights, and this installer can't prompt for your password — open your WSL/Linux terminal and run:  sudo apt-get install -y gh  (or see https://cli.github.com)"
               err "could not install gh automatically — see https://cli.github.com" ;;
  cloudflared)
    have cloudflared && ok
    pkg cloudflared && { have cloudflared && ok; }   # brew (macOS) / apt (rare on stock WSL) → else fall back to Cloudflare's official release below
    arch="$(uname -m)"; case "$arch" in x86_64|amd64) a=amd64 ;; aarch64|arm64) a=arm64 ;; armv7l) a=arm ;; *) a=amd64 ;; esac
    if [ "$(uname -s)" = "Darwin" ]; then
      # macOS ships a .tgz, NOT a bare binary — downloading cloudflared-linux here would drop a Linux ELF that
      # `have` still finds on PATH (so `ok` would falsely report success while `cloudflared` never runs). Pull the
      # darwin tarball and extract its binary instead.
      tgz="$(mktemp)"; ex="$(mktemp -d)"
      if curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$a.tgz" -o "$tgz" 2>/dev/null && [ -s "$tgz" ] && tar -xzf "$tgz" -C "$ex" 2>/dev/null && [ -f "$ex/cloudflared" ]; then
        chmod +x "$ex/cloudflared"; sudo mv "$ex/cloudflared" /usr/local/bin/cloudflared 2>/dev/null || { mkdir -p "$HOME/.local/bin"; mv "$ex/cloudflared" "$HOME/.local/bin/cloudflared"; }
      fi
      rm -f "$tgz" 2>/dev/null; rm -rf "$ex" 2>/dev/null
    else
      tmp="$(mktemp)"
      if curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$a" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        chmod +x "$tmp"; sudo mv "$tmp" /usr/local/bin/cloudflared 2>/dev/null || { mkdir -p "$HOME/.local/bin"; mv "$tmp" "$HOME/.local/bin/cloudflared"; }
      fi
    fi
    have cloudflared && ok || err "could not install cloudflared (https://developers.cloudflare.com/cloudflared/)"
    ;;
  uv)
    have uv && ok
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
    { [ -x "$HOME/.local/bin/uv" ] || have uv; } && ok || err "uv install failed"
    ;;
  voice)
    # Reuse setup.sh unchanged (it's also the direct `npm run setup` entry point) rather than duplicating its
    # whisper.cpp/Kokoro build+download logic here. It isn't JSON-shaped — it's `say()` progress lines for a
    # terminal — so capture it and translate: exit 0 -> ok; non-zero -> its own last say() line is already the
    # actionable message ("run this, then re-run `npm run setup`"), which is exactly what a failure here should show.
    _here="$(cd "$(dirname "$0")" && pwd)"
    _log="$(mktemp)"
    "$_here/../setup/setup.sh" >"$_log" 2>&1
    _rc=$?
    if [ "$_rc" -eq 0 ]; then rm -f "$_log"; ok; fi
    # say()'s bold/reset codes (\033[1m / \033[0m) survive as literal "[1m"/"[0m" once err()'s tr strips only the
    # ESC byte, not the whole escape sequence — strip the full CSI sequence here so the wizard shows clean text.
    _msg="$(sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$_log" | grep -v '^[[:space:]]*$' | tail -n 4 | tr '\n' ' ')"
    rm -f "$_log"
    err "${_msg:-voice setup failed - run: npm run setup}"
    ;;
  *) err "unknown dependency: $dep" ;;
esac
