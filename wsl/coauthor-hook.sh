#!/usr/bin/env bash
# Claudible — C-10.6: installs/refreshes (or removes) the prepare-commit-msg hook that credits live-session
# guests as Co-authored-by trailers on commits the USER makes in their own project. Resolves the SAME
# per-workspace repo as checkpoint.sh / diff.sh, then runs the tested lib/coauthorHook.js (via coauthor-tool.js).
# Subcommands: sync <b64Entries> | uninstall. Emits ONE JSON line.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # resolve the script dir as an ABSOLUTE path BEFORE we cd into the repo
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it
. "$HERE/_git-safe.sh"                                  # belt: neutralize command-executing .git/config keys before any git call here

. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution

cd "$SDIR" 2>/dev/null || { printf '{"ok":false,"error":"no workspace dir"}\n'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '{"ok":false,"repo":false,"error":"not a git repo"}\n'; exit 0; }

# win-native: subshell unsets MSYS_NO_PATHCONV so git-bash converts node's /c/.. script path (no-op on WSL)
(unset MSYS_NO_PATHCONV; node "$HERE/coauthor-tool.js" "$@")
