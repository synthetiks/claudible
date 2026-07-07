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
pkg() {   # install system packages via apt (Debian/WSL) or brew (macOS); fail if neither exists
  if have apt-get; then sudo apt-get update -y >/dev/null 2>&1; sudo apt-get install -y "$@" >/dev/null 2>&1
  elif have brew; then brew install "$@" >/dev/null 2>&1
  else return 1; fi
}

case "$dep" in
  node)
    # Presence isn't enough — Claudible needs >=22.12, and the distro 'nodejs' package is often older. Gate on
    # VERSION (not just `have node`) so the System-check wizard can actually self-heal an outdated node.
    nok() { have node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' >/dev/null 2>&1; }
    nok && ok
    if have apt-get; then curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1; sudo apt-get install -y nodejs >/dev/null 2>&1
    elif have brew; then brew install node@22 >/dev/null 2>&1; brew link --overwrite --force node@22 >/dev/null 2>&1
    else err "no apt/brew to install node"; fi
    nok && ok || err "node is still older than 22.12 — upgrade from https://nodejs.org"
    ;;
  git)         have git && ok;  pkg git        || err "no apt/brew to install git";  have git && ok  || err "git still missing" ;;
  gh)          have gh && ok;   pkg gh         || err "could not install gh (see https://cli.github.com)"; have gh && ok || err "gh still missing" ;;
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
  *) err "unknown dependency: $dep" ;;
esac
