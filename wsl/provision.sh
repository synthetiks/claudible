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
  node)        have node && ok; pkg nodejs npm || err "no apt/brew to install node"; have node && ok || err "node still missing" ;;
  git)         have git && ok;  pkg git        || err "no apt/brew to install git";  have git && ok  || err "git still missing" ;;
  gh)          have gh && ok;   pkg gh         || err "could not install gh (see https://cli.github.com)"; have gh && ok || err "gh still missing" ;;
  cloudflared) have cloudflared && ok; pkg cloudflared || err "could not install cloudflared"; have cloudflared && ok || err "cloudflared still missing" ;;
  uv)
    have uv && ok
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
    { [ -x "$HOME/.local/bin/uv" ] || have uv; } && ok || err "uv install failed"
    ;;
  *) err "unknown dependency: $dep" ;;
esac
