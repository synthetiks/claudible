#!/usr/bin/env node
// Claudible — Node port of the python3 JSON transform in diff.sh (drops the python3 dependency).
// Reads env DIFF/UNTRACKED/CDIFF/CLOG and prints the diff JSON
//   {ok,repo,files,untracked,committed,commits}
// Output is byte-identical to the original `python3 ... json.dumps(...)` (default separators ", "/": ",
// ensure_ascii=True), so the live WSL backend and the Posix/Windows backends stay in lockstep.
'use strict';

const fs = require('fs');

// --- environment with python os.environ parity -----------------------------
// CPython decodes os.environ with the surrogateescape error handler: bytes that
// aren't valid UTF-8 (e.g. a Latin-1 0xE9 from a non-UTF-8 source file's diff
// content) decode to lone surrogates U+DC80..U+DCFF rather than the U+FFFD
// replacement char Node's process.env produces. To stay byte-identical we read
// the raw env bytes from /proc/self/environ (Linux/WSL) and decode them the same
// way python would. On platforms without /proc (or any failure) we fall back to
// process.env, which matches python wherever the bytes were valid UTF-8 anyway.
function decodeSurrogateescape(buf) {
  let out = '';
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; continue; }
    let len;
    let cp;
    let min;
    if (b >= 0xc2 && b <= 0xdf) { len = 2; cp = b & 0x1f; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { len = 3; cp = b & 0x0f; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { len = 4; cp = b & 0x07; min = 0x10000; }
    else { out += String.fromCharCode(0xdc00 + b); i += 1; continue; }
    if (i + len > n) { out += String.fromCharCode(0xdc00 + b); i += 1; continue; }
    let ok = true;
    for (let k = 1; k < len; k += 1) {
      const c = buf[i + k];
      if (c < 0x80 || c > 0xbf) { ok = false; break; }
    }
    if (!ok) { out += String.fromCharCode(0xdc00 + b); i += 1; continue; }
    let v = cp;
    for (let k = 1; k < len; k += 1) v = (v << 6) | (buf[i + k] & 0x3f);
    if (v < min || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) {
      out += String.fromCharCode(0xdc00 + b);
      i += 1;
      continue;
    }
    out += String.fromCodePoint(v);
    i += len;
  }
  return out;
}

function loadEnv() {
  try {
    const buf = fs.readFileSync('/proc/self/environ');
    const env = {};
    let s = 0;
    for (let i = 0; i <= buf.length; i += 1) {
      if (i === buf.length || buf[i] === 0) {
        if (i > s) {
          const ent = buf.slice(s, i);
          const eq = ent.indexOf(0x3d); // '='
          if (eq > 0) {
            env[decodeSurrogateescape(ent.slice(0, eq))] = decodeSurrogateescape(ent.slice(eq + 1));
          }
        }
        s = i + 1;
      }
    }
    return env;
  } catch (e) {
    return process.env;
  }
}

// --- json.dumps(...)-compatible serializer ---------------------------------
// Matches CPython's json.dumps defaults: ensure_ascii=True, separators (", ", ": "),
// no trailing whitespace, dict insertion order preserved.
const ESCAPE_MAP = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function pyJsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    const esc = ESCAPE_MAP[ch];
    if (esc !== undefined) {
      out += esc;
    } else if (code < 0x20 || code > 0x7e) {
      // Control chars (< 0x20) without a short escape, plus everything >= 0x7f
      // (DEL and all non-ASCII, including each half of a surrogate pair), as \uXXXX.
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function pyJson(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return pyJsonString(value);
  if (t === 'number') {
    // All numbers here are integers (additions/deletions). Match python int repr.
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(pyJson).join(', ') + ']';
  }
  // Plain object — preserve insertion order, ", " between pairs, ": " in pairs.
  const parts = [];
  for (const key of Object.keys(value)) {
    parts.push(pyJsonString(key) + ': ' + pyJson(value[key]));
  }
  return '{' + parts.join(', ') + '}';
}

// --- python str.strip() parity ---------------------------------------------
// The python code uses `s.strip()` to test for blank lines. JS String.trim()
// strips a slightly different code-point set (e.g. it strips U+FEFF but not the
// C1/separator controls U+001C..U+001F and U+0085 that python strips). We only
// need the "is this string all-whitespace per python" predicate, so replicate
// python's exact whitespace set here.
const PY_STRIP_WS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// True when `s` is empty or contains only python-whitespace (i.e. s.strip()=="").
function pyBlank(s) {
  for (let i = 0; i < s.length; i++) {
    if (!PY_STRIP_WS.has(s.charCodeAt(i))) return false;
  }
  return true;
}

// --- diff parsing (faithful port of the python parse_diff) ------------------
function parsePath(headerLines) {
  for (const l of headerLines) {
    if (l.startsWith('+++ b/')) return l.slice(6);
    if (l.startsWith('+++ ')) return l.slice(4);
  }
  return null;
}

const HEADER_PREFIXES = [
  'diff --git', 'old mode', 'new mode', 'deleted file', 'new file', 'index', '--- ', '+++ ',
];

function startsWithAny(s, prefixes) {
  for (const p of prefixes) {
    if (s.startsWith(p)) return true;
  }
  return false;
}

function parseDiff(diff) {
  const lines = diff.split('\n');
  const files = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (!lines[i].startsWith('diff --git ')) {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    const header = [lines[start]];
    while (i < n && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff --git ')) {
      header.push(lines[i]);
      i += 1;
    }
    // path = parse_path(header) or lines[start].split(" b/")[-1]
    let path = parsePath(header);
    if (path === null) {
      const segs = lines[start].split(' b/');
      path = segs[segs.length - 1];
    }
    let isBinary = false;
    for (const l of header) {
      if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) {
        isBinary = true;
        break;
      }
    }
    const headerBlock = header.filter((h) => startsWithAny(h, HEADER_PREFIXES)).join('\n');
    const hunks = [];
    let adds = 0;
    let dels = 0;
    while (i < n && lines[i].startsWith('@@ ')) {
      const hhead = lines[i];
      i += 1;
      const body = [];
      while (i < n && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff --git ')) {
        body.push(lines[i]);
        i += 1;
      }
      const ls = [];
      for (const b of body) {
        if (!b) {
          ls.push({ t: ' ', s: '' });
          continue;
        }
        const c = b[0];
        if (c === '+') {
          adds += 1;
          ls.push({ t: '+', s: b.slice(1) });
        } else if (c === '-') {
          dels += 1;
          ls.push({ t: '-', s: b.slice(1) });
        } else if (c === '\\') {
          ls.push({ t: '\\', s: b.slice(1) });
        } else {
          ls.push({ t: ' ', s: b.slice(1) });
        }
      }
      const patch = headerBlock + '\n' + hhead + '\n' + body.join('\n') + '\n';
      hunks.push({ header: hhead, lines: ls, patch });
    }
    if (isBinary) {
      files.push({
        path, binary: true, additions: 0, deletions: 0, hunks: [], filePatch: '',
      });
    } else {
      let filePatch = '';
      if (hunks.length) {
        filePatch = headerBlock + '\n' + hunks.map((h) => (
          h.header + '\n' + h.lines.map((l) => (
            (l.t === '+' ? '+' : l.t === '-' ? '-' : l.t === '\\' ? '\\' : ' ') + l.s
          )).join('\n')
        )).join('\n') + '\n';
      }
      files.push({
        path, binary: false, additions: adds, deletions: dels, hunks, filePatch,
      });
    }
  }
  return files;
}

function main() {
  const env = loadEnv();
  const untracked = (env.UNTRACKED || '').split('\n').filter((l) => !pyBlank(l));
  const files = parseDiff(env.DIFF || '');
  const committed = parseDiff(env.CDIFF || '');
  const commits = [];
  for (const line of (env.CLOG || '').split('\n')) {
    if (pyBlank(line)) continue;
    const parts = line.split('\x1f');
    commits.push({
      hash: parts.length > 0 ? parts[0] : '',
      subject: parts.length > 1 ? parts[1] : '',
      author: parts.length > 2 ? parts[2] : '',
      date: parts.length > 3 ? parts[3] : '',
    });
  }
  const out = {
    ok: true,
    repo: true,
    total: Number(env.TOTAL) || 0,
    files,
    untracked: untracked.slice(0, 200),
    committed,
    commits,
  };
  // python used print(...), which appends a trailing newline — match it byte-for-byte.
  process.stdout.write(pyJson(out) + '\n');
}

main();
