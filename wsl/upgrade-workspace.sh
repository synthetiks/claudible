#!/usr/bin/env bash
# Claudible — UPGRADE a local workspace into a SYNCED one, IN PLACE. Turns the workspace folder into a private
# GitHub repo (tagged `claudible-workspace` for fast discovery) so it appears on your other devices and can be
# shared. Done in place (the folder/path is unchanged) so the workspace's existing Claude transcripts stay
# linked — they live under ~/.claude/projects/<encoded-path>/, keyed by the path, which we do NOT move. The
# .claude/ runtime is gitignored; transcripts sync separately on the claudible/sessions branch once sync is on.
# Args: $1 = slug (strict [A-Za-z0-9-]), $2 = the workspace's absolute dir. Emits one JSON line.
set -u
slug="${1:-}"
dir="${2:-}"
case "$slug" in '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}'; exit 0 ;; esac
[ -z "$dir" ] && dir="$HOME/.claudible/workspaces/$slug"   # default local workspace dir when the app passes none
# win-native: normalize to a Windows path (C:/..) so the returned ws.path drives node-pty/claude.exe correctly (no-op off Windows).
if command -v cygpath >/dev/null 2>&1; then dir="$(cygpath -m "$dir" 2>/dev/null || printf '%s' "$dir")"; fi
case "$dir"  in *\'* | *\"*) printf '{"ok":false,"error":"bad dir"}'; exit 0 ;; esac
[ -d "$dir" ] || { printf '{"ok":false,"error":"workspace folder not found"}'; exit 0; }
command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed"}'; exit 0; }
owner="$(gh api user --jq .login 2>/dev/null)"
[ -n "$owner" ] || { printf '{"ok":false,"error":"gh is not authenticated — run: gh auth login"}'; exit 0; }

# Name already on GitHub? Bail BEFORE touching the local folder so the action is safely retryable.
if gh repo view "$owner/$slug" >/dev/null 2>&1; then
  printf '{"ok":false,"error":"a GitHub repo named %s/%s already exists — rename the workspace or remove that repo first"}' "$owner" "$slug"; exit 0
fi

cd "$dir" || { printf '{"ok":false,"error":"could not enter the workspace folder"}'; exit 0; }
# Keep Claude runtime/transcripts OUT of the repo (never commit secrets/conversations).
if [ ! -f .gitignore ] || ! grep -qxF '.claude/' .gitignore 2>/dev/null; then printf '.claude/\n' >> .gitignore; fi
printf '{"claudible":true,"slug":"%s"}\n' "$slug" > .claudible-workspace
if [ ! -d .git ]; then git init -q >/dev/null 2>&1 || { printf '{"ok":false,"error":"git init failed"}'; exit 0; }; fi
git add -A >/dev/null 2>&1
git -c user.name="$owner" -c user.email="$owner@users.noreply.github.com" -c commit.gpgsign=false \
    commit -q -m "claudible: make this workspace syncable" >/dev/null 2>&1 || true   # tolerate "nothing to commit" on a re-run

# Create the private repo FROM this folder and push it, then tag it for one-query discovery. Drop any stale
# origin first so a retry after a half-finished push (remote added, push failed) doesn't dead-end on
# "remote origin already exists".
git remote remove origin >/dev/null 2>&1 || true
if ! gh repo create "$owner/$slug" --private --source=. --remote=origin --push >/dev/null 2>&1; then
  git remote remove origin >/dev/null 2>&1 || true   # leave the folder retryable (no lingering origin)
  printf '{"ok":false,"error":"could not create or push the repo on GitHub (name taken, or no network) — if a repo was created, delete it on GitHub and try again"}'; exit 0
fi
gh repo edit "$owner/$slug" --add-topic claudible-workspace >/dev/null 2>&1 || true
printf '{"ok":true,"kind":"repo","slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s","path":"%s"}' \
  "$slug" "$owner" "$owner" "$slug" "$dir"
