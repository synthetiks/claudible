#!/usr/bin/env bash
# Claudible — git push/pull/status for a REPO workspace, run in that workspace's cwd.
# Args: $1 = op (push|pull|status), $2 = base64(commit message) for push (avoids any shell-injection from
# free-text messages). cwd is derived from CLAUDIBLE_WS_KIND/CLAUDIBLE_WS_SLUG exactly like session.sh.
# Emits one JSON line for the renderer.
set -u

WS_KIND="${CLAUDIBLE_WS_KIND:-legacy}"
WS_SLUG="${CLAUDIBLE_WS_SLUG:-}"
case "$WS_SLUG" in *[!A-Za-z0-9-]*) WS_SLUG="" ;; esac
if [ "$WS_KIND" = "local" ] && [ -n "$WS_SLUG" ]; then
  SDIR="$HOME/.claudible/workspaces/$WS_SLUG"
elif [ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ]; then
  SDIR="$HOME/.claudible/repos/$WS_SLUG"
else
  SDIR="$HOME/.claudible/session"
fi

op="${1:-}"
case "$op" in push|pull|status) ;; *) printf '{"ok":false,"error":"bad op"}'; exit 0 ;; esac

cd "$SDIR" 2>/dev/null || { printf '{"ok":false,"error":"workspace folder not found"}'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '{"ok":false,"error":"this workspace is not a git repo"}'; exit 0; }

jstr() { printf '%s' "$1" | tail -1 | tr -d '\r' | sed 's/\\/\\\\/g; s/"/\\"/g'; }   # last line, JSON-escaped

case "$op" in
  status)
    changes=$(git status --porcelain 2>/dev/null | grep -c .)
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    printf '{"ok":true,"changes":%s,"branch":"%s"}' "${changes:-0}" "$(jstr "${branch:-}")"
    ;;
  push)
    msg=$(printf '%s' "${2:-}" | base64 -d 2>/dev/null)
    [ -z "$msg" ] && msg="Update from Claudible"
    git add -A >/dev/null 2>&1
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      owner=$(gh api user --jq .login 2>/dev/null)
      git -c user.name="${owner:-claudible}" -c user.email="${owner:-claudible}@users.noreply.github.com" \
          commit -m "$msg" >/dev/null 2>&1
    fi
    out=$(git push 2>&1)
    if [ $? -eq 0 ]; then
      tail1=$(printf '%s' "$out" | tail -1)
      [ -z "$tail1" ] && tail1="pushed"
      printf '{"ok":true,"op":"push","detail":"%s"}' "$(jstr "$tail1")"
    else
      printf '{"ok":false,"error":"%s"}' "$(jstr "$out")"
    fi
    ;;
  pull)
    out=$(git pull --ff-only 2>&1)
    if [ $? -eq 0 ]; then
      printf '{"ok":true,"op":"pull","detail":"%s"}' "$(jstr "$out")"
    else
      printf '{"ok":false,"error":"pull needs a fast-forward (you may have local commits): %s"}' "$(jstr "$out")"
    fi
    ;;
esac
