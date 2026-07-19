#!/usr/bin/env bash
# Claudible — ADOPT a folder the user already works in as a project. The opposite of create-workspace.sh:
# nothing is provisioned, nothing is moved, nothing is published. We only (a) validate the folder is safe to
# point Claude at, (b) make the `.claude/` runtime dir Claude Code needs, and (c) if the folder is inside a git
# repo, teach THAT repo to ignore the runtime dir locally — via `.git/info/exclude`, never `.gitignore`, because
# .gitignore is a tracked file the user shares with their team and this is a purely local concern.
#
# Args: $1 = the folder's absolute path (already converted to a guest path by the app).
# Emits one JSON line: {ok:true,path,name,repo,claudeTracked,excluded} | {ok:false,error}
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # absolute BEFORE the `cd "$dir"` below (else it resolves against the adopted folder)
# THE reason _git-safe.sh exists: an adopted folder's .git/config is entirely attacker-controlled (a "starter
# template" zip can ship a poisoned .git/), and git runs several config VALUES as shell commands during ordinary
# operations — core.fsmonitor fires on the `git ls-files` / `git check-ignore` calls below. This is the FIRST
# thing a stranger does with the app, and it happens before any trust decision is surfaced. Neutralize first.
. "$HERE/_git-safe.sh"

dir="${1:-}"
[ -n "$dir" ] || { printf '{"ok":false,"error":"no folder given"}'; exit 0; }
# Quotes/backslashes would break either the bash interpolation upstream or the JSON we emit below. main.js
# rejects them too — this is the defense-in-depth copy. Emits the short "bad dir" code (like clone-/create-/
# upgrade-workspace.sh), which renderer humanError() translates to the full sentence — one place to edit the copy.
case "$dir" in *\'* | *\"* | *\\* | *[[:cntrl:]]*) printf '{"ok":false,"error":"bad dir"}'; exit 0 ;; esac
[ -d "$dir" ] || { printf '{"ok":false,"error":"that folder does not exist"}'; exit 0; }

# Canonicalize (resolves `..`, symlinks, trailing slashes) so the registry stores ONE spelling of the folder —
# main.js dedupes adopted projects by exact path string, and `/x/y` vs `/x/y/` vs `/x/./y` must not add three.
cd "$dir" 2>/dev/null || { printf '{"ok":false,"error":"could not enter that folder"}'; exit 0; }
dir="$(pwd -P)"
# win-native: normalize to a real Windows path (C:/..) so the stored ws.path drives node-pty/claude.exe and the
# ~/.claude/projects/<encoded-path> key correctly, instead of a /c/.. form read as a stray C:\c\.. (no-op on WSL).
if command -v cygpath >/dev/null 2>&1; then dir="$(cygpath -m "$dir" 2>/dev/null || printf '%s' "$dir")"; fi
case "$dir" in *\'* | *\"* | *\\* | *[[:cntrl:]]*) printf '{"ok":false,"error":"bad dir"}'; exit 0 ;; esac

# Refuse the paths where adopting would be actively wrong rather than merely odd:
#   * $HOME or / — Claude would be pointed at the user's entire machine, and `git diff` at whatever repo it lands in
#   * anything Claudible already manages — those folders belong to the normal create/clone flows, and a second
#     registry entry pointing into one would make "Remove from Claudible" (which never deletes an adopted
#     folder) and "Delete project" (which trashes a managed one) disagree about the same directory.
[ "$dir" = "/" ] && { printf '{"ok":false,"error":"pick a project folder, not the filesystem root"}'; exit 0; }
home="$HOME"
if command -v cygpath >/dev/null 2>&1; then home="$(cygpath -m "$home" 2>/dev/null || printf '%s' "$home")"; fi
[ "$dir" = "$home" ] && { printf '{"ok":false,"error":"pick a project folder, not your whole home directory"}'; exit 0; }
case "$dir/" in
  "$home/.claudible/"*) printf '{"ok":false,"error":"that folder is already managed by Claudible — use New project instead"}'; exit 0 ;;
esac

name="${dir##*/}"
[ -n "$name" ] || name="project"

# Claude Code reads its project settings + our staged hooks from <folder>/.claude. session.sh creates it anyway;
# doing it here means a failure surfaces as a clean error in the dialog rather than at first launch.
mkdir -p "$dir/.claude" 2>/dev/null || { printf '{"ok":false,"error":"could not create a .claude folder there (permissions?)"}'; exit 0; }

repo=false; claude_tracked=false; excluded=false; origin=""
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  repo=true
  # The folder's OWN remote — the app turns a github.com URL into ws.repoId ('owner/name') so the project card
  # can link to it and workspace discovery won't re-offer the same repo as a "clone me" invite. Quotes/backslashes
  # would break the JSON below; a URL containing them isn't one we can use anyway.
  origin="$(git remote get-url origin 2>/dev/null || true)"
  case "$origin" in *\'* | *\"* | *\\* | *' '*) origin="" ;; esac
  # Already tracked? Then no exclude rule can help (git ignores exclude rules for tracked paths) and Claudible's
  # runtime files will show up as modifications in THEIR repo. Say so honestly; the app warns the user.
  if git ls-files --error-unmatch .claude >/dev/null 2>&1; then
    claude_tracked=true
  elif git check-ignore -q .claude 2>/dev/null; then
    excluded=true                                    # a .gitignore (theirs or ours) already covers it
  else
    # `--git-common-dir` (not --git-dir) so a LINKED WORKTREE writes to the shared repo's info/exclude, which is
    # the one git actually consults. `--show-prefix` anchors the pattern when the adopted folder is a SUBDIR of
    # the repo, so we exclude that folder's .claude and not every .claude in the tree.
    gcd="$(git rev-parse --git-common-dir 2>/dev/null)"
    pfx="$(git rev-parse --show-prefix 2>/dev/null)"
    if [ -n "$gcd" ] && mkdir -p "$gcd/info" 2>/dev/null; then
      pat="/${pfx}.claude/"
      if ! grep -qxF -- "$pat" "$gcd/info/exclude" 2>/dev/null; then
        printf '%s\n' "# claudible: the app's per-project runtime (hooks, statusline, settings) — local only" "$pat" >> "$gcd/info/exclude" 2>/dev/null
      fi
      git check-ignore -q .claude 2>/dev/null && excluded=true
    fi
  fi
fi

printf '{"ok":true,"path":"%s","name":"%s","repo":%s,"claudeTracked":%s,"excluded":%s,"origin":"%s"}' \
  "$dir" "$name" "$repo" "$claude_tracked" "$excluded" "$origin"
