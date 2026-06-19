#!/usr/bin/env bash
# Claudible — report the working-tree changes in a workspace's git repo as structured JSON, for the
# in-app Diff Review panel. Read-only. Resolves the SAME per-workspace cwd as sessions.sh, then parses
# `git diff HEAD` into files → hunks, and emits for EACH hunk a self-contained patch that `git apply -R`
# can reverse (so the UI can revert one hunk). Untracked files are listed separately.
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
cd "$SDIR" 2>/dev/null || { printf '{"ok":true,"repo":false,"files":[],"untracked":[]}'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '{"ok":true,"repo":false,"files":[],"untracked":[]}'; exit 0; }

# Raw unified diff of the whole working tree vs HEAD (binary patches excluded by --text? keep default; python skips binary).
diff_text="$(git -c core.quotepath=false diff HEAD --no-color 2>/dev/null)"
untracked="$(git -c core.quotepath=false ls-files --others --exclude-standard 2>/dev/null)"

DIFF="$diff_text" UNTRACKED="$untracked" python3 - <<'PY' 2>/dev/null || printf '{"ok":true,"repo":true,"files":[],"untracked":[]}'
import os, json
diff = os.environ.get("DIFF", "")
untracked = [l for l in os.environ.get("UNTRACKED", "").split("\n") if l.strip()]
lines = diff.split("\n")
files = []
i = 0
n = len(lines)
def parse_path(header_lines):
    # prefer the +++ b/<path>; fall back to the diff --git target
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
    # collect file header until the first hunk (@@) or next file
    while i < n and not lines[i].startswith("@@ ") and not lines[i].startswith("diff --git "):
        header.append(lines[i]); i += 1
    path = parse_path(header) or lines[start].split(" b/")[-1]
    # is this a binary patch? then skip hunks
    is_binary = any(l.startswith("Binary files ") or l.startswith("GIT binary patch") for l in header)
    header_block = "\n".join([h for h in header if h.startswith(("diff --git", "old mode", "new mode", "deleted file", "new file", "index", "--- ", "+++ "))])
    hunks = []
    adds = dels = 0
    while i < n and lines[i].startswith("@@ "):
        hstart = i
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
            elif c == "\\": ls.append({"t": "\\", "s": b[1:]})  # "\ No newline at end of file"
            else: ls.append({"t": " ", "s": b[1:]})
        # self-contained patch for THIS hunk: file header + this one hunk (+ trailing newline)
        patch = header_block + "\n" + hhead + "\n" + "\n".join(body) + "\n"
        hunks.append({"header": hhead, "lines": ls, "patch": patch})
    if is_binary:
        files.append({"path": path, "binary": True, "additions": 0, "deletions": 0, "hunks": [], "filePatch": ""})
    else:
        file_patch = header_block + "\n" + "\n".join(
            (h["header"] + "\n" + "\n".join(x for x in (
                [(("+" if l["t"]=="+" else "-" if l["t"]=="-" else "\\" if l["t"]=="\\" else " ") + l["s"]) for l in h["lines"]])
            )) for h in hunks
        ) + "\n" if hunks else ""
        files.append({"path": path, "binary": False, "additions": adds, "deletions": dels, "hunks": hunks, "filePatch": file_patch})
print(json.dumps({"ok": True, "repo": True, "files": files, "untracked": untracked[:200]}))
PY
