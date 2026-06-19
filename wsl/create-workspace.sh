#!/usr/bin/env bash
# Claudible — provision a new WORKSPACE (a directory each session library lives in).
#   local  -> a private folder under ~/.claudible/workspaces/<slug> (never leaves the machine)
#   repo   -> a private GitHub repo created + cloned to ~/.claudible/repos/<slug> so you can build it together
# Args: $1 = kind (local|repo), $2 = slug (strict [A-Za-z0-9-], the dir/repo leaf name).
# Emits a single JSON line for the renderer: {ok:true,...} or {ok:false,error:...}.
# Owner is resolved at runtime (gh api user) — never hardcoded — and the .claude/ runtime is kept
# OUT of repos so transcripts/secrets are never committed.
set -u

kind="${1:-}"
slug="${2:-}"
case "$slug" in
  '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}'; exit 0 ;;   # alnum/dash only, no leading/trailing dash
esac

case "$kind" in
  local)
    dir="$HOME/.claudible/workspaces/$slug"
    if [ -e "$dir" ]; then printf '{"ok":false,"error":"a workspace with that name already exists"}'; exit 0; fi
    if mkdir -p "$dir/.claude"; then
      printf '{"ok":true,"kind":"local","slug":"%s"}' "$slug"
    else
      printf '{"ok":false,"error":"could not create the folder"}'
    fi
    ;;

  repo)
    command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
    owner="$(gh api user --jq .login 2>/dev/null)"
    if [ -z "$owner" ]; then printf '{"ok":false,"error":"gh is not authenticated — run: gh auth login"}'; exit 0; fi
    dir="$HOME/.claudible/repos/$slug"
    if [ -e "$dir" ]; then printf '{"ok":false,"error":"a repo workspace with that name already exists locally"}'; exit 0; fi
    mkdir -p "$HOME/.claudible/repos" 2>/dev/null
    # Create the private repo with an initial commit (--add-readme) so the clone has a real default branch.
    if ! gh repo create "$owner/$slug" --private --add-readme >/dev/null 2>&1; then
      printf '{"ok":false,"error":"could not create the repo (is the name already taken on GitHub?)"}'; exit 0
    fi
    # Clone via gh so it uses gh's auth (no credential-helper prompt). On failure, roll back so the
    # same name is retryable: drop the half-clone, and best-effort delete the just-created repo
    # (needs the delete_repo scope — ignored if absent, hence the honest fallback message).
    if ! gh repo clone "$owner/$slug" "$dir" >/dev/null 2>&1; then
      rm -rf "$dir" 2>/dev/null
      gh repo delete "$owner/$slug" --yes >/dev/null 2>&1
      printf '{"ok":false,"error":"clone failed; if a private repo was left at github.com/%s/%s, delete it or pick another name"}' "$owner" "$slug"; exit 0
    fi
    # Keep Claude's runtime + transcripts OUT of the repo (no committed secrets), then push that rule up.
    printf '.claude/\n' > "$dir/.gitignore"
    mkdir -p "$dir/.claude" 2>/dev/null
    # A committed marker so a collaborator's Claudible can DISCOVER this repo as a workspace (sessions-discover.sh).
    printf '{"claudible":true,"slug":"%s"}\n' "$slug" > "$dir/.claudible-workspace"
    (
      cd "$dir" || exit 0
      git add .gitignore .claudible-workspace >/dev/null 2>&1
      git -c user.name="$owner" -c user.email="$owner@users.noreply.github.com" \
          commit -m "claudible: ignore .claude runtime + mark workspace" >/dev/null 2>&1
      git push >/dev/null 2>&1
    )
    printf '{"ok":true,"kind":"repo","slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s"}' \
      "$slug" "$owner" "$owner" "$slug"
    ;;

  *)
    printf '{"ok":false,"error":"bad kind"}'
    ;;
esac
