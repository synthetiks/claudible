#!/usr/bin/env bash
# Claudible — resolve a repo's STABLE identity (numeric id + its CURRENT name) from a possibly-STALE name.
#
# GitHub's REST API follows a rename redirect on GET, so `gh api repos/<owner>/<oldname>` answers with the repo
# under its CURRENT name and its permanent numeric id. That is what lets main.js backfill ghId/repoName onto
# workspaces created before ids were stored — INCLUDING ones whose repo was renamed on GitHub outside Claudible,
# which otherwise never match discovery and re-appear as a phantom "clone me" duplicate on every launch.
#
# Args: $1 = owner, $2 = the repo name we currently believe (both strict [A-Za-z0-9-]).
# Read-only: one GET, no side effects. Emits one JSON line.
set -u

owner="${1:-}"
name="${2:-}"
case "$owner" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad owner"}'; exit 0 ;; esac
case "$name"  in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad name"}';  exit 0 ;; esac

command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed"}'; exit 0; }

# Gate on gh's EXIT STATUS, not on "did it print something": on a 404/403 `gh api --jq` writes the raw error JSON
# to STDOUT and exits 1, so a non-empty check would sail through and hand that blob to the parser below.
if ! out="$(gh api "repos/$owner/$name" --jq '[(.id|tostring), .name] | @tsv' 2>/dev/null)"; then
  printf '{"ok":false,"error":"repo not found"}'; exit 0
fi
[ -n "$out" ] || { printf '{"ok":false,"error":"repo not found"}'; exit 0; }

id="$(printf '%s' "$out" | cut -f1)"
cur="$(printf '%s' "$out" | cut -f2)"
case "$id"  in '' | *[!0-9]*)        printf '{"ok":false,"error":"bad id"}';          exit 0 ;; esac
case "$cur" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"unsupported name"}'; exit 0 ;; esac   # a name outside the Claudible slug charset can't round-trip our bash args

printf '{"ok":true,"ghId":%s,"repoName":"%s"}' "$id" "$cur"
