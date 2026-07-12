#!/usr/bin/env bash
# Claudible — provision a new WORKSPACE (a directory each session library lives in).
#   local  -> a private folder under ~/.claudible/workspaces/<slug> (never leaves the machine)
#   repo   -> a private GitHub repo created + cloned to ~/.claudible/repos/<slug> so you can build it together
# Args: $1 = kind (local|repo), $2 = slug (strict [A-Za-z0-9-], the dir/repo leaf name).
# Emits a single JSON line for the renderer: {ok:true,...} or {ok:false,error:...}.
# Owner is resolved at runtime (gh api user) — never hardcoded — and the .claude/ runtime is kept
# OUT of repos so transcripts/secrets are never committed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # absolute BEFORE any cd (see diff.sh)
. "$HERE/_git-safe.sh"                                  # defense in depth: this repo is one WE create, so its config is ours — but no script may run git in a workspace without the neutralizer. Enforced tree-wide by test/adopt-workspace.test.js so the next git-touching script can't silently skip it.

kind="${1:-}"
slug="${2:-}"
case "$slug" in
  '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}'; exit 0 ;;   # alnum/dash only, no leading/trailing dash
esac

case "$kind" in
  local)
    pdir="${3:-}"                                          # optional custom parent dir (absolute WSL path from the app)
    # $pdir had NO guard: a `"`, `\` or control byte in the chosen folder's name reached the printf below and
    # produced JSON main.js couldn't parse — AFTER mkdir had already created the folder, which was then orphaned.
    # Same charset as lib/pathSafe.js (which now rejects it upstream) and as the other three workspace scripts.
    case "$pdir" in *\'* | *\"* | *\\* | *[[:cntrl:]]*) printf '{"ok":false,"error":"bad dir"}'; exit 0 ;; esac
    if [ -n "$pdir" ]; then dir="$pdir/$slug"; else dir="$HOME/.claudible/workspaces/$slug"; fi
    # win-native: normalize to a real Windows path (C:/..) so the stored ws.path drives node-pty/claude.exe + the project-dir key correctly, instead of a /c/.. form read as a stray C:\c\.. (no-op on WSL/Posix). Mirrors clone-workspace.sh.
    if command -v cygpath >/dev/null 2>&1; then dir="$(cygpath -m "$dir" 2>/dev/null || printf '%s' "$dir")"; fi
    if [ -e "$dir" ]; then printf '{"ok":false,"error":"a workspace with that name already exists there"}'; exit 0; fi
    if mkdir -p "$dir/.claude"; then
      printf '{"ok":true,"kind":"local","slug":"%s","path":"%s"}' "$slug" "$dir"
    else
      printf '{"ok":false,"error":"could not create the folder"}'
    fi
    ;;

  repo)
    command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
    owner="$(gh api user --jq .login 2>/dev/null)"
    if [ -z "$owner" ]; then printf '{"ok":false,"error":"gh is not authenticated — run: gh auth login"}'; exit 0; fi
    dir="$HOME/.claudible/repos/$slug"
    # win-native: normalize to a Windows path so gh/git.exe clone into the real dir, not a stray C:\c\.. (no-op off Windows).
    if command -v cygpath >/dev/null 2>&1; then dir="$(cygpath -m "$dir" 2>/dev/null || printf '%s' "$dir")"; fi
    if [ -e "$dir" ]; then printf '{"ok":false,"error":"a repo workspace with that name already exists locally"}'; exit 0; fi
    mkdir -p "$HOME/.claudible/repos" 2>/dev/null
    # Create the private repo with an initial commit (--add-readme) so the clone has a real default branch.
    if ! gh repo create "$owner/$slug" --private --add-readme >/dev/null 2>&1; then
      printf '{"ok":false,"error":"could not create the repo (is the name already taken on GitHub?)"}'; exit 0
    fi
    # Tag it so the SAME user's other devices (and collaborators) discover it in ONE fast query (topics are
    # returned inline by /user/repos — no per-repo scan). Best-effort: discovery also still works via the marker.
    gh repo edit "$owner/$slug" --add-topic claudible-workspace >/dev/null 2>&1 || true
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
    marker_ok=1
    (
      cd "$dir" || exit 1
      git add .gitignore .claudible-workspace >/dev/null 2>&1 && \
      git -c user.name="$owner" -c user.email="$owner@users.noreply.github.com" -c commit.gpgsign=false \
          commit -m "claudible: ignore .claude runtime + mark workspace" >/dev/null 2>&1 && \
      git push >/dev/null 2>&1
    ) || marker_ok=0   # &&-chained so marker_ok reflects the WHOLE publish (a failed commit no longer hides behind an up-to-date push); gpgsign disabled so the commit succeeds for gpg/hook users
    if [ "$marker_ok" = 1 ]; then
      printf '{"ok":true,"kind":"repo","slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s"}' \
        "$slug" "$owner" "$owner" "$slug"
    else
      printf '{"ok":true,"kind":"repo","slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s","note":"repo created, but publishing the discovery marker failed — collaborators may not see it until your next sync"}' \
        "$slug" "$owner" "$owner" "$slug"
    fi
    ;;

  *)
    printf '{"ok":false,"error":"bad kind"}'
    ;;
esac
