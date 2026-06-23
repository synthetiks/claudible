'use strict';
// Claudible — Node port of the python3 JSON transform in sessions.sh (removes the python3 dependency).
// Behavior MUST stay byte-identical to the original python: same inputs (argv/env/stdin), same stdout.
// argv: [node, sessions-tool.js, <proj>, <wt?>]  — mirrors `python3 - "$PROJ" "$WT"`.
const fs = require('fs');
const path = require('path');

const proj = process.argv[2];
const wt = process.argv.length > 3 ? process.argv[3] : '';

// --- JSON serialization that matches python json.dumps defaults --------------
// json.dumps uses ", " / ": " separators and ensure_ascii=True (every codepoint
// >= 0x80 escaped as lowercase \uXXXX, astral chars as surrogate pairs).
function jstr(s) {
  // JSON.stringify already matches python for quotes, backslash, \n, \t and the
  // control-char escapes; we only need to ASCII-ify the non-ASCII codepoints.
  return JSON.stringify(s).replace(/[\u0080-\uffff]/g, function (c) {
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  });
}
function dumpRec(rec) {
  // Object key order mirrors python insertion order:
  // id, mtime, created, preview, msgs, [deletedRemote], [diverged]
  const parts = [];
  parts.push(jstr('id') + ': ' + jstr(rec.id));
  parts.push(jstr('mtime') + ': ' + String(rec.mtime));
  parts.push(jstr('created') + ': ' + String(rec.created));
  parts.push(jstr('preview') + ': ' + jstr(rec.preview));
  parts.push(jstr('msgs') + ': ' + String(rec.msgs));
  if (rec.deletedRemote === true) parts.push(jstr('deletedRemote') + ': ' + 'true');
  if (rec.diverged === true) parts.push(jstr('diverged') + ': ' + 'true');
  return '{' + parts.join(', ') + '}';
}
function dumpArr(arr) {
  return '[' + arr.map(dumpRec).join(', ') + ']';
}

// --- helpers mirroring the python --------------------------------------------
function readIds(p) {
  // set(x.strip() for x in fh if x.strip())  — non-empty stripped lines.
  try {
    const data = fs.readFileSync(p, 'utf8');
    const s = new Set();
    for (const raw of data.split('\n')) {
      const t = raw.trim();
      if (t) s.add(t);
    }
    return s;
  } catch (e) {
    return new Set();
  }
}

// Replicate datetime.datetime.fromisoformat(...).timestamp() for Python 3.10,
// applied to s.strip().replace("Z","+00:00"); int() truncates toward zero.
// Returns the integer epoch, or 0 on any parse failure (the python except path).
function parseTs(s) {
  let str = s.trim().replace(/Z/g, '+00:00');
  // fromisoformat 3.10 grammar: YYYY-MM-DD optionally followed by [Tt ] time.
  // Time: HH:MM[:SS[.ffffff]] with 3 or 6 fractional digits; tz: +HH:MM[:SS[.ffffff]] or 'Z'(already replaced).
  const m = str.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}(?:\d{3})?))?)?)?([+-]\d{2}:\d{2}(?::\d{2}(?:\.\d{6})?)?)?$/
  );
  if (!m) return 0;
  const year = +m[1], month = +m[2], day = +m[3];
  const hasTime = m[4] !== undefined;
  const hour = hasTime ? +m[4] : 0;
  const minute = hasTime ? +m[5] : 0;
  const second = m[6] !== undefined ? +m[6] : 0;
  const fracStr = m[7]; // 3 or 6 digits (validated by regex), or undefined
  const offStr = m[8];
  // Field range validation (fromisoformat raises ValueError on out-of-range).
  if (month < 1 || month > 12) return 0;
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) return 0;
  if (hour > 23 || minute > 59 || second > 59) return 0;
  // Fractional seconds -> microseconds (python keeps full precision but int() of
  // .timestamp() truncates toward zero, so sub-second only matters near negatives).
  let micro = 0;
  if (fracStr !== undefined) {
    micro = fracStr.length === 3 ? +fracStr * 1000 : +fracStr;
  }
  if (offStr) {
    // Aware datetime: epoch is tz-independent.
    const sign = offStr[0] === '-' ? -1 : 1;
    const oh = +offStr.slice(1, 3);
    const om = +offStr.slice(4, 6);
    let os = 0, ofrac = 0;
    if (offStr.length > 6) {
      os = +offStr.slice(7, 9);
      if (offStr.length > 9) ofrac = +offStr.slice(10, 16); // microseconds
    }
    const offsetSec = sign * (oh * 3600 + om * 60 + os) + (sign * ofrac) / 1e6;
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    // total seconds = utc-epoch-of-walltime - offset, plus fractional micro.
    const totalSec = utcMs / 1000 - offsetSec + micro / 1e6;
    return Math.trunc(totalSec);
  }
  // Naive datetime: .timestamp() interprets it in the system local timezone.
  const d = new Date(year, month - 1, day, hour, minute, second, 0);
  // Guard against JS Date normalizing an invalid wall time (shouldn't happen
  // after range checks, but be safe and match python's exact-field semantics).
  const ms = d.getTime();
  if (isNaN(ms)) return 0;
  return Math.trunc(ms / 1000 + micro / 1e6);
}

function daysInMonth(y, mth) {
  if (mth === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mth - 1];
}

// --- main: mirror the python control flow ------------------------------------
function main() {
  // Tombstones: os.listdir(wt/sessions/.tombstones) -> set of names.
  let tombs = new Set();
  if (wt) {
    try {
      tombs = new Set(fs.readdirSync(path.join(wt, 'sessions', '.tombstones')));
    } catch (e) {
      tombs = new Set();
    }
  }
  const kept = readIds(path.join(proj, '.claudible-kept'));
  const diverged = readIds(path.join(proj, '.claudible-diverged'));

  // glob.glob(proj/*.jsonl): readdir order, hidden (leading-dot) names excluded,
  // only entries ending in .jsonl. python `*` matches names not starting with '.'.
  let names;
  try {
    names = fs.readdirSync(proj);
  } catch (e) {
    // glob of a missing dir yields []; the loop just produces no records.
    names = [];
  }
  const files = names.filter(n => !n.startsWith('.') && n.endsWith('.jsonl'));

  const out = [];
  for (const name of files) {
    const f = path.join(proj, name);
    const sid = name.slice(0, -6); // os.path.basename(f)[:-6] strips ".jsonl"
    let mtime;
    try {
      mtime = Math.trunc(fs.statSync(f).mtimeMs / 1000);
    } catch (e) {
      mtime = 0;
    }
    let preview = '';
    let msgs = 0;
    let created = 0;
    try {
      const content = fs.readFileSync(f, 'utf8');
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (o === null || typeof o !== 'object') continue; // o.get(...) needs a dict
        if (!created) {
          const ts = o.timestamp;
          if (typeof ts === 'string') created = parseTs(ts);
        }
        if (o.type === 'user' && isPlainDict(o.message)) {
          const c = o.message.content;
          let t;
          if (Array.isArray(c)) {
            const texts = [];
            for (const x of c) {
              if (isPlainDict(x) && x.type === 'text') {
                texts.push(typeof x.text === 'string' ? x.text : '');
              }
            }
            t = texts.join(' ');
          } else {
            t = typeof c === 'string' ? c : '';
          }
          t = (t || '').trim();
          if (t && !t.startsWith('<') && !t.startsWith('Caveat')) {
            msgs += 1;
            if (!preview) {
              // " ".join(t.split())[:90] — collapse whitespace, slice 90 codepoints.
              const collapsed = t.split(/\s+/).filter(Boolean).join(' ');
              preview = Array.from(collapsed).slice(0, 90).join('');
            }
          }
        }
      }
    } catch (e) {
      // pass — keep whatever we accumulated
    }
    const rec = {
      id: sid,
      mtime: mtime,
      created: created || mtime,
      preview: preview || '(empty session)',
      msgs: msgs
    };
    if (tombs.has(sid) && !kept.has(sid)) rec.deletedRemote = true;
    if (diverged.has(sid)) rec.diverged = true;
    out.push(rec);
  }
  // Stable sort by (created || mtime) descending. JS sort is stable (Node >= 11).
  out.sort((a, b) => {
    const ka = a.created || a.mtime;
    const kb = b.created || b.mtime;
    return kb - ka;
  });
  process.stdout.write(dumpArr(out) + '\n');
}

// python: isinstance(x, dict). For x.get("text"), the value must be a JSON object
// (not array, not null). x.get(...) on a dict.
function isPlainDict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

main();
