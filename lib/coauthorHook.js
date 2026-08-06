'use strict';
// lib/coauthorHook.js — C-10.6: the git hook that credits live-session guests as Co-authored-by trailers on
// commits the USER makes in their own project (never the claudible-development-style session-sync bookkeeping —
// that is Claudible's own commit, not the user's). Pure filesystem logic, no git plumbing beyond writing files —
// so it unit-tests against a plain temp directory standing in for a repo's real hooks dir. The wsl-side adapter
// (coauthor-hook.sh -> coauthor-tool.js) resolves the REAL hooks dir + git dir (via `git rev-parse --git-path
// hooks` / `--git-dir`, so a repo with core.hooksPath moved still gets the right file) and calls install() /
// uninstall() / writeCoauthorsFile() here.
//
// NEVER CLOBBER (the load-bearing guarantee): if `hooksDir/prepare-commit-msg` already exists and was NOT
// written by us (no MARKER), install() copies it to `prepare-commit-msg.pre-claudible` ONCE and our hook CHAINS
// to it — the foreign hook still runs first and its exit code still gates the commit. uninstall() reverses that
// exactly: restore the backup if one exists, else (we created the file fresh, nothing to restore) delete our
// own hook. A hook file that is present but is neither ours nor backed up (someone hand-replaced our file, or
// deleted the backup) is left completely alone — uninstall only ever touches what it can prove it owns.

const fs = require('fs');
const path = require('path');

const MARKER = '# claudible:coauthor-hook v1';
const HOOK_NAME = 'prepare-commit-msg';
const BACKUP_SUFFIX = '.pre-claudible';
const COAUTHORS_FILE = 'claudible-coauthors';   // lives in the git dir: gitDir/claudible-coauthors, one "Name <email>" per line

function hookPaths(hooksDir) {
  const hookPath = path.join(hooksDir, HOOK_NAME);
  return { hookPath, backupPath: hookPath + BACKUP_SUFFIX };
}
function isOurs(content) { return typeof content === 'string' && content.indexOf(MARKER) !== -1; }

// The hook script Claudible installs. chainLine = a shell fragment that runs a backed-up FOREIGN hook first
// ('' when there is none to chain to). Trailers are added only for a plain authored message — never for
// merge/squash, where git already assembled the message and an extra trailer would land in the wrong spot.
// An empty or missing coauthors file means "no live guests right now" -> silent no-op, so a solo commit never
// gets a trailer (C-10.6's "solo commits get no trailer").
function hookScript(chainLine) {
  const lines = ['#!/bin/sh', MARKER,
    '# Installed by Claudible (C-10.6). Turning the Settings toggle off, or ending the live share, uninstalls',
    '# this and restores whatever hook was here before — see lib/coauthorHook.js uninstall().'];
  if (chainLine) lines.push(chainLine);
  lines.push(
    'msgfile="$1"; src="${2:-}"',
    'case "$src" in merge|squash) exit 0 ;; esac',
    'dir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0',
    'coauthors="$dir/' + COAUTHORS_FILE + '"',
    '[ -s "$coauthors" ] || exit 0',
    'while IFS= read -r line; do',
    '  [ -n "$line" ] || continue',
    '  grep -qF "Co-authored-by: $line" "$msgfile" 2>/dev/null && continue',
    '  printf "\\nCo-authored-by: %s\\n" "$line" >> "$msgfile"',
    'done < "$coauthors"',
    'exit 0'
  );
  return lines.join('\n') + '\n';
}

// Install (or refresh) the coauthor hook in `hooksDir`. Returns { ok, chained, error? }. Idempotent: calling
// this again (setting stays on, another guest joins) only ever rewrites OUR OWN file — it never re-backs-up,
// because a second backup would silently drop whatever ran between the first install and now.
function install(hooksDir) {
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    const { hookPath, backupPath } = hookPaths(hooksDir);
    let existing = null;
    try { existing = fs.readFileSync(hookPath, 'utf8'); } catch { existing = null; }
    const alreadyOurs = existing !== null && isOurs(existing);
    let chained = fs.existsSync(backupPath);
    if (existing !== null && !alreadyOurs && !chained) {
      // A real foreign hook we have never seen before -> back it up FIRST. This backup is the only surviving
      // copy of it from here on; nothing below may run until it is safely on disk.
      fs.copyFileSync(hookPath, backupPath);
      try { fs.chmodSync(backupPath, 0o755); } catch {}
      chained = true;
    }
    const chainLine = chained
      ? 'hd="$(cd "$(dirname "$0")" && pwd)"; if [ -x "$hd/' + HOOK_NAME + BACKUP_SUFFIX + '" ]; then "$hd/' + HOOK_NAME + BACKUP_SUFFIX + '" "$@" || exit $?; fi'
      : '';
    fs.writeFileSync(hookPath, hookScript(chainLine));
    try { fs.chmodSync(hookPath, 0o755); } catch {}
    return { ok: true, chained };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Reverse install(). Returns { ok, restored, error? }.
function uninstall(hooksDir) {
  try {
    const { hookPath, backupPath } = hookPaths(hooksDir);
    let current = null;
    try { current = fs.readFileSync(hookPath, 'utf8'); } catch { current = null; }
    if (current === null) return { ok: true, restored: false };   // nothing installed — clean no-op
    if (!isOurs(current)) return { ok: false, error: 'hooks/prepare-commit-msg is not Claudible\'s — left untouched' };
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, hookPath);   // restore verbatim (rename preserves the backup's own mode bits)
      return { ok: true, restored: true };
    }
    fs.unlinkSync(hookPath);
    return { ok: true, restored: false };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// entries: [{ name, email?, login?, id? }] — the roster (guest display names) plus whatever GitHub identity is
// known for each from the invite flow. Prefers a known email; else builds a GitHub noreply address from a known
// login (id+login when the numeric GitHub id is known, matching GitHub's own convention; plain login@ otherwise);
// else the identity is genuinely unknown -> SKIP that person rather than fabricate an address.
function buildCoauthorLines(entries) {
  const lines = [], skipped = [], seen = new Set();
  for (const e of (entries || [])) {
    const name = String((e && e.name) || '').trim();
    if (!name) continue;
    let email = e && e.email ? String(e.email).trim() : '';
    if (!email && e && e.login) {
      const login = String(e.login).replace(/[^A-Za-z0-9-]/g, '');
      if (login) {
        const idNum = e.id != null ? parseInt(e.id, 10) : NaN;
        email = Number.isFinite(idNum) ? `${idNum}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
      }
    }
    if (!email || /[\s<>]/.test(email)) { skipped.push(name); continue; }
    const line = `${name} <${email}>`;
    if (seen.has(line)) continue;
    seen.add(line); lines.push(line);
  }
  return { lines, skipped };
}

// gitDir = the repo's real git dir (git rev-parse --git-dir, resolved by the caller). Zero lines CLEARS the
// file rather than leaving an empty one on disk — either shape makes the hook a no-op (`[ -s ... ]`), but
// removing it means a repo with no live guests right now shows no stray Claudible file in `git status`.
function writeCoauthorsFile(gitDir, lines) {
  const p = path.join(gitDir, COAUTHORS_FILE);
  try {
    if (!lines || !lines.length) { try { fs.unlinkSync(p); } catch {} return { ok: true, count: 0 }; }
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return { ok: true, count: lines.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

module.exports = {
  MARKER, HOOK_NAME, BACKUP_SUFFIX, COAUTHORS_FILE,
  hookScript, install, uninstall, buildCoauthorLines, writeCoauthorsFile,
  _internals: { hookPaths, isOurs },
};
