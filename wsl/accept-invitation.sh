#!/usr/bin/env bash
# Claudible — B17 UX: accept ONE pending GitHub repository collaborator invitation, by its numeric id (as
# listed by pending-invites.sh). This is a shortcut for the exact thing clicking "Accept" on github.com does —
# nothing here bypasses GitHub's own consent; the invite still had to exist and name this account.
# Args: $1 = invitation id (digits only). On success, main.js kicks an immediate discoverWorkspaces() so the
# now-accessible repo shows up right away instead of waiting for the next focus/boot discovery pass.
set -u
id="${1:-}"
case "$id" in ''|*[!0-9]*) printf '{"ok":false,"error":"bad id"}'; exit 0 ;; esac
command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"gh-missing"}'; exit 0; }
case "$(uname -r 2>/dev/null)" in *[Mm]icrosoft*) case "$(command -v gh 2>/dev/null)" in *.exe|/mnt/*) { printf '{"ok":false,"error":"gh-missing"}'; exit 0; } ;; esac ;; esac
# PATCH /user/repository_invitations/{id} accepts the invitation; 204 No Content on success. --silent suppresses
# gh's own stdout (the empty body) so only our own printf below is ever read by main.js.
if gh api --silent -X PATCH "user/repository_invitations/$id" 2>/dev/null; then
  printf '{"ok":true}'
else
  printf '{"ok":false,"error":"accept failed"}'
fi
