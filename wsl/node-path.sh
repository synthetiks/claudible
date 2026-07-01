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
# Source this at the top of any script that calls node. Idempotent, safe under `set -u`, no-op if node resolves.
if ! command -v node >/dev/null 2>&1; then
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)                                   # Windows-pure (git-bash): node is node.exe
      for _clc in "/c/Program Files/nodejs" "/c/Program Files (x86)/nodejs"; do
        if [ -x "$_clc/node.exe" ]; then PATH="$_clc:$PATH"; export PATH; break; fi
      done ;;
    *)                                                      # WSL / Linux: use a NATIVE node (never node.exe)
      _clnd="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -n1)"
      for _clc in "$_clnd" /usr/local/bin /usr/bin /snap/bin; do
        if [ -n "$_clc" ] && [ -x "$_clc/node" ]; then PATH="$_clc:$PATH"; export PATH; break; fi
      done ;;
  esac
  unset _clnd _clc 2>/dev/null || true
fi
