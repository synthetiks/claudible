#!/usr/bin/env bash
# ============================================================================
# port-parity.sh — proves the python3 -> Node port (wsl/*-tool.js) is byte-faithful.
#
# For each transform it runs the ORIGINAL python3 block (extracted from the vendored
# pre-port oracle in test/fixtures/preport/) AND the new Node helper on IDENTICAL, nasty fixtures, and
# byte-diffs stdout. Parity is keep-vs-revert per script: a FAIL means that script's
# port is NOT safe and must be reverted to python3 (with the installer providing python3).
#
# Fixtures are adversarial on purpose — emoji/astral chars (ensure_ascii surrogate
# escaping), CJK, malformed JSON lines, excluded prefixes, conditional keys + their
# ordering, whitespace-collapse, empty/fallback inputs, side-effect files.
#
# Needs: python3 (the oracle) + node, both on PATH. CI's ubuntu-latest has both.
# This box: python3 3.10.x == the grammar the timestamp port targeted.
# ============================================================================
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0; FAILED_SCRIPTS=""

# Extract the Nth `<<'PY' ... PY` heredoc body from a (HEAD) script.
extract_py() { # <script-file> <which:1-based>
  awk -v want="$2" '
    /<<'"'"'PY'"'"'/ { n++; if (n==want) { grab=1; next } }
    grab && /^PY$/ { exit }
    grab { print }
  ' "$1"
}

# The python3 ORACLE = the pre-port scripts, vendored as committed fixtures. This must NOT read from
# git HEAD: once the port is committed, HEAD:wsl/*.sh IS the ported (python3-free) code, so the oracle
# would be empty and every check would false-fail (notably in CI). The fixtures pin the python3 source.
HEAD="$ROOT/test/fixtures/preport"
for f in agent-tokens diff plugins sessions transcript workflows skills sessions-sync; do
  [ -f "$HEAD/$f.sh" ] || { echo "  ERR missing oracle fixture test/fixtures/preport/$f.sh"; exit 2; }
done

report() { # <name> <py-out-file> <node-out-file>
  if diff -u "$2" "$3" >/dev/null 2>&1; then
    echo "  ok   $1"; PASS=$((PASS+1))
  else
    echo "  FAIL $1"; echo "    --- python (HEAD)   +++ node (port) ---"
    diff -u "$2" "$3" | sed -n '1,24p' | sed 's/^/    /'
    FAIL=$((FAIL+1)); case " $FAILED_SCRIPTS " in *" $1 "*) ;; *) FAILED_SCRIPTS="$FAILED_SCRIPTS $1";; esac
  fi
}

echo "== port parity: python3 (vendored pre-port oracle) vs Node helpers, adversarial fixtures =="
echo "   python3: $(python3 --version 2>&1) · node: $(node --version)"
echo

# ---------------------------------------------------------------------------
# 1) sessions.sh  — python3 - "$PROJ" "$WT"   |  node sessions-tool.js "$PROJ" "$WT"
#    nasty: emoji (astral surrogate pair), CJK, array content, malformed lines,
#    excluded '<' / 'Caveat' prefixes, whitespace collapse, created||mtime tie-break,
#    tombstoned-not-kept (deletedRemote) + diverged conditional keys + ordering.
# ---------------------------------------------------------------------------
extract_py "$HEAD/sessions.sh" 1 > "$T/sessions.py"
PROJ="$T/s_proj"; WT="$T/s_wt"
mkdir -p "$PROJ" "$WT/sessions/.tombstones"
# s1: emoji + CJK + array content + two msgs (tie-break by created)
printf '%s\n' \
  '{"type":"user","timestamp":"2026-01-01T10:00:00Z","message":{"content":"Hello 🌍 world  with   spaces"}}' \
  '{"type":"user","timestamp":"2026-01-01T10:05:00Z","message":{"content":[{"type":"text","text":"second 你好 кириллица"}]}}' \
  '{"type":"assistant","message":{"content":"ignored"}}' > "$PROJ/s1.jsonl"
# s2: malformed lines + excluded prefixes + whitespace collapse-only valid msg
printf '%s\n' \
  'not json at all' \
  '{"type":"user","timestamp":"2026-01-02T08:00:00Z","message":{"content":"<system-reminder ignore me>"}}' \
  '{"type":"user","message":{"content":"Caveat: also ignored"}}' \
  '{garbage{{' \
  '{"type":"user","timestamp":"2026-01-02T08:00:00Z","message":{"content":"  collapse   THIS\twhitespace  "}}' > "$PROJ/s2.jsonl"
# s3: normal session, will be flagged deletedRemote (tomb & not kept) + diverged
printf '%s\n' \
  '{"type":"user","timestamp":"2026-01-03T09:00:00Z","message":{"content":"third session preview"}}' > "$PROJ/s3.jsonl"
# s4: empty-ish (no user msgs) -> "(empty session)" preview, created falls back to mtime
printf '%s\n' '{"type":"assistant","message":{"content":"only assistant"}}' > "$PROJ/s4.jsonl"
: > "$PROJ/.claudible-kept"            # kept is empty -> s3 stays deletedRemote
printf 's3\n' > "$PROJ/.claudible-diverged"
: > "$WT/sessions/.tombstones/s3"      # tombstone for s3
python3 "$T/sessions.py" "$PROJ" "$WT" > "$T/sessions.py.out" 2>/dev/null
node "$ROOT/wsl/sessions-tool.js" "$PROJ" "$WT" > "$T/sessions.node.out" 2>/dev/null
report "sessions.sh" "$T/sessions.py.out" "$T/sessions.node.out"

# ---------------------------------------------------------------------------
# 2) transcript.sh — python3 - "$f"  |  node transcript-tool.js "$f"
#    nasty: emoji, CJK, control chars, malformed lines, many message types.
# ---------------------------------------------------------------------------
extract_py "$HEAD/transcript.sh" 1 > "$T/transcript.py"
TF="$T/transcript.jsonl"
printf '%s\n' \
  '{"type":"user","message":{"content":"plain ask 🚀"}}' \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"reply with 中文 and  bell"}]}}' \
  'totally not json' \
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}' \
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"out\nput"}]}}' \
  '{"type":"system","subtype":"x"}' \
  '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm émoji ñ"}]}}' > "$TF"
python3 "$T/transcript.py" "$TF" > "$T/transcript.py.out" 2>/dev/null
node "$ROOT/wsl/transcript-tool.js" "$TF" > "$T/transcript.node.out" 2>/dev/null
report "transcript.sh" "$T/transcript.py.out" "$T/transcript.node.out"

# ---------------------------------------------------------------------------
# 3) diff.sh — env DIFF/UNTRACKED/CDIFF/CLOG  |  node diff-tool.js (reads same env)
#    nasty: non-ASCII path + content, binary file, multi-hunk, \ no-newline,
#    untracked list, multi-commit CLOG (\x1f-separated), empty-repo fallback.
#    macOS CAVEAT (see docs/OS-PORT-STATUS Part C): diff-tool.js reads /proc/self/environ for python's
#    surrogateescape parity. This test runs on Linux/WSL (/proc present) so it's byte-exact. On macOS
#    (no /proc) an INVALID-UTF-8 byte in the diff CONTENT decodes to U+FFFD vs python's U+DCxx — a known,
#    macOS-only, non-UTF-8-only gap to fix (pass bytes via stdin/file) when the mac .dmg ships.
# ---------------------------------------------------------------------------
extract_py "$HEAD/diff.sh" 1 > "$T/diff.py"
US=$'\x1f'
DIFFV=$'diff --git a/café.txt b/café.txt\nindex e69de29..d95f3ad 100644\n--- a/café.txt\n+++ b/café.txt\n@@ -0,0 +1,2 @@\n+héllo wörld 🌍\n+second line\n\\ No newline at end of file\ndiff --git a/bin.dat b/bin.dat\nnew file mode 100644\nindex 0000000..1234567\nBinary files /dev/null and b/bin.dat differ'
UNTRACKEDV=$'new1.txt\n\nnew2-ünïcode.txt\n   \nnew3.txt'
CDIFFV=$'diff --git a/old.js b/old.js\nindex 111..222 100644\n--- a/old.js\n+++ b/old.js\n@@ -1 +1 @@\n-was\n+now'
CLOGV="abc123${US}first commit 🎉${US}Alice${US}2026-01-01"$'\n'"def456${US}second${US}Bob${US}2026-01-02"
# `week` is a passthrough of the WEEK env var added AFTER the port (the commit-list fix); the frozen python
# oracle predates it and never emits it. It is not part of the DIFF/CDIFF/CLOG/UNTRACKED parsing this test
# pins, so strip it from the node output before diffing (same spirit as normalizing title-write's wall-clock ts).
strip_week() { sed 's/"week": [0-9]*, //' "$1" > "$1.norm"; }
# (A) populated
DIFF="$DIFFV" UNTRACKED="$UNTRACKEDV" CDIFF="$CDIFFV" CLOG="$CLOGV" python3 "$T/diff.py" > "$T/diff.py.out" 2>/dev/null
DIFF="$DIFFV" UNTRACKED="$UNTRACKEDV" CDIFF="$CDIFFV" CLOG="$CLOGV" node "$ROOT/wsl/diff-tool.js" > "$T/diff.node.out" 2>/dev/null
strip_week "$T/diff.node.out"
report "diff.sh [populated]" "$T/diff.py.out" "$T/diff.node.out.norm"
# (B) empty / fallback
DIFF="" UNTRACKED="" CDIFF="" CLOG="" python3 "$T/diff.py" > "$T/diff2.py.out" 2>/dev/null
DIFF="" UNTRACKED="" CDIFF="" CLOG="" node "$ROOT/wsl/diff-tool.js" > "$T/diff2.node.out" 2>/dev/null
strip_week "$T/diff2.node.out"
report "diff.sh [empty]" "$T/diff2.py.out" "$T/diff2.node.out.norm"

# ---------------------------------------------------------------------------
# 4) agent-tokens.sh — python3 - "$SA"  |  node agent-tokens-tool.js "$SA"
#    nasty: nested *.jsonl (recursive), dotfile/dotdir skipped, empty {}/[] in
#    message/usage slots (python `or {}` falsy), malformed line, integer tokens.
#    (float token values are a documented non-real-data divergence — not tested.)
# ---------------------------------------------------------------------------
extract_py "$HEAD/agent-tokens.sh" 1 > "$T/agent-tokens.py"
SA="$T/sa"; mkdir -p "$SA/sub" "$SA/.hidden"
printf '%s\n' \
  '{"message":{"usage":{"output_tokens":10,"cache_creation_input_tokens":5}}}' \
  'not json' \
  '{"message":{"usage":{}}}' \
  '{"message":[]}' \
  '{"message":{"usage":{"output_tokens":7}}}' > "$SA/a.jsonl"
printf '%s\n' '{"message":{"usage":{"output_tokens":100,"cache_creation_input_tokens":1}}}' > "$SA/sub/b.jsonl"
printf '%s\n' '{"message":{"usage":{"output_tokens":999}}}' > "$SA/.hidden/c.jsonl"   # dotdir -> skipped
printf '%s\n' '{"message":{"usage":{"output_tokens":888}}}' > "$SA/.skip.jsonl"        # dotfile -> skipped
python3 "$T/agent-tokens.py" "$SA" > "$T/at.py.out" 2>/dev/null
node "$ROOT/wsl/agent-tokens-tool.js" "$SA" > "$T/at.node.out" 2>/dev/null
report "agent-tokens.sh" "$T/at.py.out" "$T/at.node.out"

# ---------------------------------------------------------------------------
# 5) workflows.sh — python3 - "$WF_ROOT"  |  node workflows-tool.js "$WF_ROOT"
#    All-done fixture (every agent has a 'result' -> isRunning=false -> `now` does
#    not affect stdout), fresh mtimes. Run in SEPARATE copies (cp -rp preserves
#    mtimes) so the .parse-cache.json side effect can't cross-contaminate stdout.
# ---------------------------------------------------------------------------
extract_py "$HEAD/workflows.sh" 1 > "$T/workflows.py"
WSRC="$T/wf_src"; mkdir -p "$WSRC/wf_AAA111" "$WSRC/wf_BBB222"
printf '%s\n' \
  '{"agentId":"ag1","type":"spawn"}' '{"agentId":"ag1","type":"result"}' \
  '{"agentId":"ag2","type":"spawn"}' '{"agentId":"ag2","type":"result"}' > "$WSRC/wf_AAA111/journal.jsonl"
printf '%s\n' \
  '{"type":"user","timestamp":"2026-06-01T10:00:00.000Z","message":{"content":"find the bug 🐛 please"}}' \
  '{"type":"assistant","requestId":"r1","message":{"id":"m1","usage":{"input_tokens":120,"output_tokens":40},"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"TODO","path":"/x/y/file.js"}},{"type":"text","text":"done hére"}]}}' > "$WSRC/wf_AAA111/agent-ag1.jsonl"
printf '%s\n' \
  '{"type":"user","timestamp":"2026-06-01T10:01:00.000Z","message":{"content":"second agent 你好"}}' \
  '{"type":"assistant","message":{"usage":{"input_tokens":5,"output_tokens":9},"content":[{"type":"text","text":"ok"}]}}' > "$WSRC/wf_AAA111/agent-ag2.jsonl"
printf '%s\n' '{"agentId":"agZ","type":"result"}' > "$WSRC/wf_BBB222/journal.jsonl"
printf '%s\n' '{"type":"user","timestamp":"2026-06-01T11:00:00.000Z","message":{"content":"lonely"}}' > "$WSRC/wf_BBB222/agent-agZ.jsonl"
cp -rp "$WSRC" "$T/wf_py"; cp -rp "$WSRC" "$T/wf_node"
python3 "$T/workflows.py" "$T/wf_py" > "$T/wf.py.out" 2>/dev/null
node "$ROOT/wsl/workflows-tool.js" "$T/wf_node" > "$T/wf.node.out" 2>/dev/null
# wf path basenames differ (wf_py vs wf_node) only in the ROOT, not the wf_* names; output uses
# basename(wf) = wf_AAA111 etc. — identical. Diff directly.
report "workflows.sh [stdout]" "$T/wf.py.out" "$T/wf.node.out"
# cross-engine cache: node reads python's populated cache -> stdout must still match python-fresh.
node "$ROOT/wsl/workflows-tool.js" "$T/wf_py" > "$T/wf.node2.out" 2>/dev/null
report "workflows.sh [node reads py-cache]" "$T/wf.py.out" "$T/wf.node2.out"

# ---------------------------------------------------------------------------
# 6) plugins.sh — block1 'list', block2 'available'. python reads $HOME/.claude.
#    nasty: @-partitioned keys, unicode descriptions (codepoint slice + ensure_ascii),
#    codepoint sort order (alpha/béta/zeta), enabled flags, empty plugins.
# ---------------------------------------------------------------------------
extract_py "$HEAD/plugins.sh" 1 > "$T/plugins-list.py"
extract_py "$HEAD/plugins.sh" 2 > "$T/plugins-avail.py"
PH="$T/p_home"; mkdir -p "$PH/.claude/plugins/marketplaces/m1/.claude-plugin"
cat > "$PH/.claude/plugins/installed_plugins.json" <<'JSON'
{"plugins":{"zeta@m1":[{"version":"1.0","scope":"user"}],"alpha":[{}],"béta@m2":[{"version":"2.0"}]}}
JSON
cat > "$PH/.claude/settings.json" <<'JSON'
{"enabledPlugins":{"zeta@m1":true,"alpha":false}}
JSON
cat > "$PH/.claude/plugins/marketplaces/m1/.claude-plugin/marketplace.json" <<'JSON'
{"plugins":[{"name":"alpha","description":"unicode 你好 description with emoji 🎯 long enough"},{"name":"zeta","description":"z"}]}
JSON
HOME="$PH" python3 "$T/plugins-list.py" > "$T/pl.py.out" 2>/dev/null
HOME="$PH" node "$ROOT/wsl/plugins-tool.js" list > "$T/pl.node.out" 2>/dev/null
report "plugins.sh [list]" "$T/pl.py.out" "$T/pl.node.out"
HOME="$PH" python3 "$T/plugins-avail.py" > "$T/pa.py.out" 2>/dev/null
HOME="$PH" node "$ROOT/wsl/plugins-tool.js" available > "$T/pa.node.out" 2>/dev/null
report "plugins.sh [available]" "$T/pa.py.out" "$T/pa.node.out"

# ---------------------------------------------------------------------------
# 7) skills.sh — block1 'list "$SDIR"', block2 'set "$SDIR" name state'.
#    nasty: user+project scope, frontmatter quotes, unicode description (240 cp
#    slice + ensure_ascii), overrides; set writes settings.local.json (indent=2).
# ---------------------------------------------------------------------------
extract_py "$HEAD/skills.sh" 1 > "$T/skills-list.py"
extract_py "$HEAD/skills.sh" 2 > "$T/skills-set.py"
SH="$T/sk_home"; SDIR="$T/sk_proj"
mkdir -p "$SH/.claude/skills/user-skill" "$SDIR/.claude/skills/proj-skill"
printf -- '---\nname: user-skill\ndescription: "quoted désc 中文 %s"\n---\nbody\n' "$(printf 'x%.0s' $(seq 1 250))" > "$SH/.claude/skills/user-skill/SKILL.md"
printf -- "---\nname: proj-skill\ndescription: 'single quoted'\n---\nbody\n" > "$SDIR/.claude/skills/proj-skill/SKILL.md"
cat > "$SDIR/.claude/settings.local.json" <<'JSON'
{"skillOverrides":{"proj-skill":"off"}}
JSON
HOME="$SH" python3 "$T/skills-list.py" "$SDIR" > "$T/sk.py.out" 2>/dev/null
HOME="$SH" node "$ROOT/wsl/skills-tool.js" list "$SDIR" > "$T/sk.node.out" 2>/dev/null
report "skills.sh [list]" "$T/sk.py.out" "$T/sk.node.out"
# set: run on SEPARATE copies, diff both stdout AND the written settings.local.json.
cp -rp "$SDIR" "$T/sk_py"; cp -rp "$SDIR" "$T/sk_node"
HOME="$SH" python3 "$T/skills-set.py" "$T/sk_py" "newskill" "name-only" > "$T/sks.py.out" 2>/dev/null
HOME="$SH" node "$ROOT/wsl/skills-tool.js" set "$T/sk_node" "newskill" "name-only" > "$T/sks.node.out" 2>/dev/null
report "skills.sh [set stdout]" "$T/sks.py.out" "$T/sks.node.out"
report "skills.sh [set settings.local.json]" "$T/sk_py/.claude/settings.local.json" "$T/sk_node/.claude/settings.local.json"

# ---------------------------------------------------------------------------
# 8) sessions-sync.sh — title-write (env, writes file) + title-read (env, git repo).
#    title-write nasty: base64 of a name with BOM + control chars + unicode + emoji;
#    ts is wall-clock (int(time())) so we normalize "ts": N before diffing the file.
#    title-read nasty: two meta/*.json on a faked origin/<br>, newest-ts-per-id wins.
# ---------------------------------------------------------------------------
extract_py "$HEAD/sessions-sync.sh" 1 > "$T/ssync-write.py"
extract_py "$HEAD/sessions-sync.sh" 2 > "$T/ssync-read.py"
# --- title-write ---
B64="$(printf '\xef\xbb\xbfMy \x01Title 你好 \xf0\x9f\x9a\x80 trailing  ' | base64 -w0)"
printf '%s' '{"existing":{"title":"old","ts":1}}' > "$T/cw_py.json"
printf '%s' '{"existing":{"title":"old","ts":1}}' > "$T/cw_node.json"
CL_ID="sessABC" CL_B64="$B64" CL_FILE="$T/cw_py.json"   python3 "$T/ssync-write.py" >/dev/null 2>&1
CL_ID="sessABC" CL_B64="$B64" CL_FILE="$T/cw_node.json" node "$ROOT/wsl/sessions-sync-tool.js" title-write >/dev/null 2>&1
# normalize the wall-clock ts before diffing (logic-under-test is decode+sanitize+merge+order)
sed 's/"ts": [0-9]*/"ts": N/g' "$T/cw_py.json"   > "$T/cw_py.norm"
sed 's/"ts": [0-9]*/"ts": N/g' "$T/cw_node.json" > "$T/cw_node.norm"
report "sessions-sync.sh [title-write file]" "$T/cw_py.norm" "$T/cw_node.norm"
# --- title-read (git fixture: meta/*.json on a faked origin/<br>) ---
GR="$T/repo"; mkdir -p "$GR/meta"
( cd "$GR" && git init -q && git config user.email t@t && git config user.name t \
  && printf '%s' '{"s1":{"title":"older 中文","ts":100},"s2":{"title":"keep-s2","ts":50}}' > meta/alice.json \
  && printf '%s' '{"s1":{"title":"newer 🎉 wins","ts":200}}' > meta/bob.json \
  && git add -A && git commit -qm x \
  && git update-ref refs/remotes/origin/work HEAD ) >/dev/null 2>&1
CL_WT="$GR" CL_BR="work" python3 "$T/ssync-read.py" > "$T/sr.py.out" 2>/dev/null
CL_WT="$GR" CL_BR="work" node "$ROOT/wsl/sessions-sync-tool.js" title-read > "$T/sr.node.out" 2>/dev/null
report "sessions-sync.sh [title-read]" "$T/sr.py.out" "$T/sr.node.out"

echo
echo "============================================================"
echo "  PORT PARITY: $PASS passed, $FAIL failed"
if [ -n "$FAILED_SCRIPTS" ]; then
  echo "  REVERT candidates (port NOT byte-faithful):$FAILED_SCRIPTS"
  echo "  -> revert that wsl/<script>.sh to python3 + provision python3 in the installer."
else
  echo "  Every python3 transform is byte-faithful across adversarial fixtures."
  echo "  The port is safe to keep on the live WSL path and all native backends."
fi
echo "============================================================"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
