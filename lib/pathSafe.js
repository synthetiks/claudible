'use strict';
// One predicate for: may this filesystem path cross into a bash argument and come back out through JSON?
//
// A workspace path takes two hostile trips. main.js interpolates it into a SINGLE-QUOTED bash argument
//     bash create-workspace.sh 'local' 'my-proj' '<path>'
// and the script prints it straight back into a JSON string with `printf '…"path":"%s"…'` — no escaping at
// either end. So four classes of character are unusable:
//
//   '            ends the shell quote; everything after it becomes shell words
//   "            terminates the JSON string → JSON.parse throws
//   \            starts a JSON escape → "a\b" parses to a DIFFERENT path (backspace), "a\z" throws
//   \x00-\x1f    forbidden raw inside a JSON string (RFC 8259 §7) → JSON.parse throws
//
// And when JSON.parse throws, the folder is already on disk — created, and owned by nothing.
//
// Windows filenames cannot contain any of these. Linux and macOS filenames can: `mkdir 'a"b'` is legal, and so
// is a newline. So this is reachable today by picking such a folder in the native directory picker.
//
// Four call sites had four different charsets — `'` only, `'"`, `'"\`, and (create-workspace's custom parent
// dir) nothing at all. This is their union, in one place.
//
// We REJECT rather than escape, which is what workspace:adopt already did: a path we cannot round-trip is a
// path we cannot store in workspaces.json or hand to a script, so there is nothing to salvage by escaping it.
//
// NOT the same question as runners/_shared.js wsEnv(), which only forbids `'`. That is correct there: it builds
// a shell string alone, never JSON, and inside single quotes a `"` or `\` is an ordinary character.

const PATH_UNSAFE = /['"\\]|[\u0000-\u001f\u007f]/;   // quote · dquote · backslash · C0 controls · DEL

function isSafePath(p) { return typeof p === 'string' && p.length > 0 && !PATH_UNSAFE.test(p); }
// '' when unsafe or empty — every call site already reads '' as "refuse, or use the default".
function safePath(p) { return isSafePath(p) ? p : ''; }

// The one sentence the user sees. Names all four classes without saying "control character 0x0a".
const PATH_UNSAFE_MSG = 'that folder’s path contains a quote, a backslash or a line break — Claudible can’t use it';

// isContainedPath — a STRICTER predicate for the handful of call sites that take a workspace's stored path
// straight out of workspaces.json (hand-editable — CASE-24) and hand it to a script that builds another path
// underneath it (clone/upgrade). isSafePath alone only rules out the shell/JSON-breaking charset; it still
// accepts 'relative/x' or 'C:/a/../b', either of which lets a hand-edited registry entry walk the resulting
// path outside the folder the script means to operate in.
//
// Custom save locations are a real feature — containment here does NOT mean "under some fixed root". It means
// "a real absolute path with no traversal segments": isSafePath, PLUS rooted (drive-letter or POSIX `/`), PLUS
// no `.` or `..` path segment anywhere in it.
const PATH_ABSOLUTE = /^([A-Za-z]:[\\/]|\/)/;
function isContainedPath(p) {
  if (!isSafePath(p)) return false;
  if (!PATH_ABSOLUTE.test(p)) return false;
  const segs = p.split(/[\\/]+/);
  for (const s of segs) { if (s === '.' || s === '..') return false; }
  return true;
}
const PATH_TRAVERSAL_MSG = 'that project’s saved path isn’t a safe absolute location — Claudible won’t use it';

module.exports = { isSafePath, safePath, PATH_UNSAFE, PATH_UNSAFE_MSG, isContainedPath, PATH_TRAVERSAL_MSG };
