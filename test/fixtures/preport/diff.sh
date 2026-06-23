#!/usr/bin/env bash
# Claudible — report a workspace's git changes as structured JSON, for the in-app Diff Review panel. Read-only.
# Resolves the SAME per-workspace cwd as sessions.sh, then emits BOTH:
#   * uncommitted working-tree changes (`git diff HEAD`) → files → hunks, each with a self-contained patch
#     `git apply -R` can reverse (so the UI can revert one hunk). Untracked files are listed separately.
#   * recently-COMMITTED changes (net diff of the last few commits) → so work that's already committed is still
#     reviewable (git diff HEAD alone shows nothing once Claude commits). Committed changes are review-only.
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
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"
cd "$SDIR" 2>/dev/null || { printf '{"ok":true,"repo":false,"files":[],"untracked":[],"committed":[],"commits":[]}'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '{"ok":true,"repo":false,"files":[],"untracked":[],"committed":[],"commits":[]}'; exit 0; }

# Uncommitted: raw unified diff of the whole working tree vs HEAD (python skips binary).
diff_text="$(git -c core.quotepath=false diff HEAD --no-color 2>/dev/null)"
untracked="$(git -c core.quotepath=false ls-files --others --exclude-standard 2>/dev/null)"

# Committed: net diff of the last N commits (so work Claude already committed is still visible). Bounded so we
# never dump the whole history; never reaches past the root commit.
ccount="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
N=0
if [ "${ccount:-0}" -gt 1 ]; then N=10; [ "$ccount" -le "$N" ] && N=$((ccount-1)); fi
cdiff_text=""; clog=""
if [ "$N" -gt 0 ]; then
  cdiff_text="$(git -c core.quotepath=false diff "HEAD~$N" HEAD --no-color 2>/dev/null)"
  clog="$(git log --no-color --format='%h%x1f%s%x1f%an%x1f%ad' --date=short "HEAD~$N"..HEAD 2>/dev/null)"
fi

DIFF="$diff_text" UNTRACKED="$untracked" CDIFF="$cdiff_text" CLOG="$clog" python3 - <<'PY' 2>/dev/null || printf '{"ok":true,"repo":true,"files":[],"untracked":[],"committed":[],"commits":[]}'
import os, json

def parse_diff(diff):
    lines = diff.split("\n")
    files = []
    i = 0
    n = len(lines)
    def parse_path(header_lines):
        for l in header_lines:
            if l.startswith("+++ b/"): return l[6:]
            if l.startswith("+++ "):   return l[4:]
        return None
    while i < n:
        if not lines[i].startswith("diff --git "):
            i += 1; continue
        start = i
        i += 1
        header = [lines[start]]
        while i < n and not lines[i].startswith("@@ ") and not lines[i].startswith("diff --git "):
            header.append(lines[i]); i += 1
        path = parse_path(header) or lines[start].split(" b/")[-1]
        is_binary = any(l.startswith("Binary files ") or l.startswith("GIT binary patch") for l in header)
        header_block = "\n".join([h for h in header if h.startswith(("diff --git", "old mode", "new mode", "deleted file", "new file", "index", "--- ", "+++ "))])
        hunks = []
        adds = dels = 0
        while i < n and lines[i].startswith("@@ "):
            hhead = lines[i]; i += 1
            body = []
            while i < n and not lines[i].startswith("@@ ") and not lines[i].startswith("diff --git "):
                body.append(lines[i]); i += 1
            ls = []
            for b in body:
                if not b:
                    ls.append({"t": " ", "s": ""}); continue
                c = b[0]
                if c == "+": adds += 1; ls.append({"t": "+", "s": b[1:]})
                elif c == "-": dels += 1; ls.append({"t": "-", "s": b[1:]})
                elif c == "\\": ls.append({"t": "\\", "s": b[1:]})
                else: ls.append({"t": " ", "s": b[1:]})
            patch = header_block + "\n" + hhead + "\n" + "\n".join(body) + "\n"
            hunks.append({"header": hhead, "lines": ls, "patch": patch})
        if is_binary:
            files.append({"path": path, "binary": True, "additions": 0, "deletions": 0, "hunks": [], "filePatch": ""})
        else:
            file_patch = header_block + "\n" + "\n".join(
                (h["header"] + "\n" + "\n".join(
                    [(("+" if l["t"]=="+" else "-" if l["t"]=="-" else "\\" if l["t"]=="\\" else " ") + l["s"]) for l in h["lines"]]
                )) for h in hunks
            ) + "\n" if hunks else ""
            files.append({"path": path, "binary": False, "additions": adds, "deletions": dels, "hunks": hunks, "filePatch": file_patch})
    return files

untracked = [l for l in os.environ.get("UNTRACKED", "").split("\n") if l.strip()]
files = parse_diff(os.environ.get("DIFF", ""))
committed = parse_diff(os.environ.get("CDIFF", ""))
commits = []
for line in os.environ.get("CLOG", "").split("\n"):
    if not line.strip(): continue
    parts = line.split("\x1f")
    commits.append({"hash": parts[0] if len(parts) > 0 else "",
                    "subject": parts[1] if len(parts) > 1 else "",
                    "author": parts[2] if len(parts) > 2 else "",
                    "date": parts[3] if len(parts) > 3 else ""})
print(json.dumps({"ok": True, "repo": True, "files": files, "untracked": untracked[:200], "committed": committed, "commits": commits}))
PY
