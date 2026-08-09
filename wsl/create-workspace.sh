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
    command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"authIssue":true,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
    case "$(uname -r 2>/dev/null)" in *[Mm]icrosoft*) case "$(command -v gh 2>/dev/null)" in *.exe|/mnt/*) { printf '{"ok":false,"authIssue":true,"error":"gh resolves to a Windows gh.exe via interop — install the Linux gh inside WSL"}'; exit 0; } ;; esac ;; esac   # a Windows gh.exe leaking through WSL interop reads the WINDOWS credential store and mangles Linux paths
    owner="$(gh api user --jq .login 2>/dev/null)"
    if [ -z "$owner" ]; then printf '{"ok":false,"authIssue":true,"error":"gh is not authenticated — run: gh auth login"}'; exit 0; fi
    dir="$HOME/.claudible/repos/$slug"
    # win-native: normalize to a Windows path so gh/git.exe clone into the real dir, not a stray C:\c\.. (no-op off Windows).
    if command -v cygpath >/dev/null 2>&1; then dir="$(cygpath -m "$dir" 2>/dev/null || printf '%s' "$dir")"; fi
    if [ -e "$dir" ]; then
      # The clone exists locally but isn't in our registry (registry wiped, or a create that timed out after
      # cloning). Recover the TRUE owner from the existing clone's origin remote so the re-attach in main.js isn't
      # left owner-less — an owner-less repo workspace can never be invited/renamed/backfilled (L-2). Fall back to
      # the signed-in user only if the remote can't be read.
      ex_owner="$(git -C "$dir" remote get-url origin 2>/dev/null | sed -n 's#.*github\.com[:/]\([A-Za-z0-9._-]*\)/.*#\1#p' | tr -cd 'A-Za-z0-9-')"
      [ -z "$ex_owner" ] && ex_owner="$owner"
      printf '{"ok":false,"error":"a repo workspace with that name already exists locally","owner":"%s","repoUrl":"https://github.com/%s/%s"}' "$ex_owner" "$ex_owner" "$slug"; exit 0
    fi
    mkdir -p "$HOME/.claudible/repos" 2>/dev/null
    # Name already on GitHub? Bail BEFORE creating anything, with a message that says so plainly — the
    # post-hoc "is the name already taken?" guess stays below only for genuine create failures (network,
    # permissions). Mirrors upgrade-workspace.sh's preflight; keeps the action safely retryable.
    if gh repo view "$owner/$slug" >/dev/null 2>&1; then
      printf '{"ok":false,"error":"a GitHub repo named %s/%s already exists — pick another name or remove that repo first"}' "$owner" "$slug"; exit 0
    fi
    # Create the private repo with an initial commit (--add-readme) so the clone has a real default branch.
    if ! gh repo create "$owner/$slug" --private --add-readme >/dev/null 2>&1; then
      printf '{"ok":false,"error":"could not create the repo on GitHub (network problem, or no repo-create permission) — try again"}'; exit 0
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
    # A SEPARATE PRIVATE REPO FOR THE TRANSCRIPTS, wired as the `claudible-sessions` remote.
    #
    # Sessions used to ride a branch of the code repo itself. That put every prompt, every reply, and
    # everything Claude read along the way — file contents, command output, whatever secrets passed through —
    # one "make public" click away from the world, with no warning and no undo (the branch survives in history,
    # forks and clones). We nearly shipped exactly that on this very project.
    #
    # So the split is structural now, not a thing anyone has to remember: code here, conversations next door,
    # private. sessions-sync.sh prefers this remote and falls back to origin when it is absent, so every
    # project made before this change keeps working untouched.
    #
    # Best-effort by design: if the second repo cannot be created (no permission, name taken, offline) the
    # workspace is still perfectly usable — it just syncs the old way. Failing the whole creation over the
    # sessions repo would be a worse trade than falling back, so we say so in `note` and move on.
    sess_repo="$slug-sessions"
    if gh repo create "$owner/$sess_repo" --private >/dev/null 2>&1; then
      git -C "$dir" remote add claudible-sessions "https://github.com/$owner/$sess_repo.git" >/dev/null 2>&1
      sessions_note=""
    else
      sessions_note=" (transcripts will sync to the project repo — the separate private sessions repo could not be created)"
    fi
    # Keep Claude's runtime + transcripts OUT of the repo (no committed secrets), then push that rule up.
    printf '.claude/\n' > "$dir/.gitignore"
    mkdir -p "$dir/.claude" 2>/dev/null
    # A committed marker so a collaborator's Claudible can DISCOVER this repo as a workspace (sessions-discover.sh).
    # It also names the sessions repo, so a collaborator cloning this project can wire the same `claudible-sessions`
    # remote instead of guessing — and so the pairing survives even if the naming convention ever changes.
    # (The marker lives in the CODE repo and only records a repo NAME, never any transcript content.)
    if [ -n "$sessions_note" ]; then
      printf '{"claudible":true,"slug":"%s"}\n' "$slug" > "$dir/.claudible-workspace"
    else
      printf '{"claudible":true,"slug":"%s","sessionsRepo":"%s/%s"}\n' "$slug" "$owner" "$sess_repo" > "$dir/.claudible-workspace"
    fi
    marker_ok=1
    (
      cd "$dir" || exit 1
      git add .gitignore .claudible-workspace >/dev/null 2>&1 && \
      git -c user.name="$owner" -c user.email="$owner@users.noreply.github.com" -c commit.gpgsign=false \
          commit -m "claudible: ignore .claude runtime + mark workspace" >/dev/null 2>&1 && \
      git push >/dev/null 2>&1
    ) || marker_ok=0   # &&-chained so marker_ok reflects the WHOLE publish (a failed commit no longer hides behind an up-to-date push); gpgsign disabled so the commit succeeds for gpg/hook users
    if [ "$marker_ok" = 1 ]; then
      if [ -n "$sessions_note" ]; then
        printf '{"ok":true,"kind":"repo","slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s","note":"%s"}' \
          "$slug" "$owner" "$owner" "$slug" "${sessions_note# }"
      else
        printf '{"ok":true,"kind":"repo","slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s","sessionsRepo":"%s/%s"}' \
          "$slug" "$owner" "$owner" "$slug" "$owner" "$sess_repo"
      fi
    else
      printf '{"ok":true,"kind":"repo","slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s","note":"repo created, but publishing the discovery marker failed — collaborators may not see it until your next sync"}' \
        "$slug" "$owner" "$owner" "$slug"
    fi
    ;;

  *)
    printf '{"ok":false,"error":"bad kind"}'
    ;;
esac
