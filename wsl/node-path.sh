# shellcheck shell=bash
# node-path.sh — make `node` resolvable in the non-interactive shells Claudible spawns, ON ANY INSTALL MODE.
#
# Claudible runs in three modes with different folders/tools:
#   * WSL-pure / mix  → scripts run in WSL (`wsl.exe -e bash -lc`). node is a NATIVE Linux node (nvm/system).
#                       nvm is initialized by ~/.bashrc, which RETURNS EARLY for non-interactive shells, so a
#                       `-lc` shell has NO node on PATH → every `node … || <default>` silently returns the
#                       default (e.g. sessions.sh → [] → the session list looks empty). We must add WSL node —
#                       NEVER Windows node.exe (it can't read POSIX /home/… paths the scripts pass).
#   * Windows-pure    → scripts run in git-bash; node is node.exe (git-bash resolves bare `node`). Usually on
#                       PATH already; if not, add the Windows nodejs dir.
# Source this at the top of any script that calls node. Idempotent, safe under `set -u`.
#
# A resolvable `node` is NOT enough: a distro-packaged node (/usr/bin/node, always on the default
# non-interactive PATH) silently shadows a newer nvm install that only ~/.bashrc would front-load —
# so scripts ran an 18.x while the user's real toolchain is 22.x+. Prefer the highest nvm node
# whenever it is NEWER than whatever currently resolves, not only when nothing resolves at all.
_clhave=""
command -v node >/dev/null 2>&1 && _clhave="$(node -v 2>/dev/null)"
_clhave="${_clhave#v}"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)                                   # Windows-pure (git-bash): node is node.exe
    if [ -z "$_clhave" ]; then
      for _clc in "/c/Program Files/nodejs" "/c/Program Files (x86)/nodejs"; do
        if [ -x "$_clc/node.exe" ]; then PATH="$_clc:$PATH"; export PATH; break; fi
      done
    fi ;;
  *)                                                      # WSL / Linux: use a NATIVE node (never node.exe)
    _clnd="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -n1)"
    if [ -n "$_clnd" ] && [ -x "$_clnd/node" ]; then
      _clnv="${_clnd#"$HOME"/.nvm/versions/node/v}"; _clnv="${_clnv%/bin}"
      # prepend when node is absent, or the nvm one is strictly newer than the one PATH resolves
      if [ "$_clnv" != "$_clhave" ] && { [ -z "$_clhave" ] || [ "$(printf '%s\n%s\n' "$_clhave" "$_clnv" | sort -V | tail -n1)" = "$_clnv" ]; }; then
        PATH="$_clnd:$PATH"; export PATH
      fi
    elif [ -z "$_clhave" ]; then
      for _clc in /usr/local/bin /usr/bin /snap/bin; do
        if [ -x "$_clc/node" ]; then PATH="$_clc:$PATH"; export PATH; break; fi
      done
    fi ;;
esac
unset _clnd _clc _clnv _clhave 2>/dev/null || true
