'use strict';
// Claudible — Node port of the python3 JSON transform in sessions.sh (removes the python3 dependency).
// Behavior MUST stay byte-identical to the original python: same inputs (argv/env/stdin), same stdout.
// argv: [node, sessions-tool.js, <proj>, <wt?>]  — mirrors `python3 - "$PROJ" "$WT"`.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// --- parse cache -------------------------------------------------------------------------------------
// preview/msgs/created/lastTs are derived from a transcript's BYTES and nothing else, so a file whose
// identity has not changed can be answered from memory instead of re-read and re-parsed. On a project with a
// long history that is the difference between reading tens of megabytes on EVERY session-list call and
// reading none of it. Everything else in a record still comes from a fresh stat, and readdir remains the sole
// truth about which sessions exist — a cache can make this faster, never wronger about what is there.
//
// THE KEY IS (size, mtimeMs, ctimeMs) AT FULL PRECISION — deliberately not the second-truncated mtime the
// output carries. ctimeMs is load-bearing, not belt-and-braces: sessions-sync.sh stamps every imported
// collaborator transcript `touch -d '2000-01-01T00:00:00'` so the auto-resume heuristic can never pick a
// foreign file, which means for those sessions mtime is pinned at the sentinel FOREVER and a key without
// ctime would degenerate to size-only. ctime moves on every import (the copy lands on a fresh inode and is
// renamed into place), which is precisely when the content changed.
//
// The cache lives under the user's home, NOT beside the transcripts and NOT inside any git tree: a cache that
// synced between machines would re-import the my-own-rewrite-looks-like-a-fork bug class. A missing, corrupt,
// stale or unwritable cache costs one full parse — today's behaviour exactly — and never an error.
const CACHE_VER = 1;
// CLAUDIBLE_CACHE_DIR exists so the suite can point this at a scratch directory. It is the ONLY way to
// sandbox it: os.homedir() reads USERPROFILE on Windows and ignores $HOME, so a test that set HOME would
// silently write into the real cache instead. Never set in normal operation.
function cachePath() {
  try {
    const h = crypto.createHash('sha1').update(path.resolve(proj)).digest('hex').slice(0, 16);
    const base = process.env.CLAUDIBLE_CACHE_DIR || path.join(os.homedir(), '.claudible', 'cache');
    return path.join(base, 'sessions-' + h + '.json');
  } catch (e) { return ''; }
}
function loadCache() {
  const p = cachePath();
  if (!p) return {};
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!o || o.v !== CACHE_VER || !o.e || typeof o.e !== 'object') return {};   // a version bump invalidates wholesale
    return o.e;
  } catch (e) { return {}; }
}
function saveCache(entries) {
  const p = cachePath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp.' + process.pid;                    // atomic: a torn cache must never be readable
    fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VER, e: entries }));
    fs.renameSync(tmp, p);
  } catch (e) { /* a cache we cannot write is simply a cache we do not have */ }
}

// --with-authors (opt-in flag set by sessions.sh) additionally stamps each FOREIGN session with the
// collaborator who created it, derived from the sync worktree's sessions/<author>/<id>.jsonl layout.
// Opt-in ONLY: test/port-parity.sh runs this tool WITHOUT the flag and byte-compares against the
// original python — the unflagged output must stay identical forever.
let _av = process.argv.slice(2);
let WITH_AUTHORS = false;
if (_av[0] === '--with-authors') { WITH_AUTHORS = true; _av = _av.slice(1); }
const proj = _av[0];
const wt = _av.length > 1 ? _av[1] : '';

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
  if (rec.used != null) parts.push(jstr('used') + ': ' + String(rec.used));   // --with-authors only (like `author`) — the parity (unflagged) shape is untouched
  if (rec.deletedRemote === true) parts.push(jstr('deletedRemote') + ': ' + 'true');
  if (rec.diverged === true) parts.push(jstr('diverged') + ': ' + 'true');
  if (rec.author) parts.push(jstr('author') + ': ' + jstr(rec.author));   // only ever set in --with-authors mode — the parity (unflagged) shape is untouched
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
  // --with-authors: who created each session, straight from the sync worktree's per-author layout
  // (sessions/<author>/<id>.jsonl). Only FOREIGN (collaborator-imported) ids get stamped — your own
  // sessions carry no author so the sidebar shows a pill only for other people's work.
  const authorOf = {};
  let foreign = new Set();
  if (WITH_AUTHORS && wt) {
    foreign = readIds(path.join(proj, '.claudible-foreign'));
    try {
      for (const dir of fs.readdirSync(path.join(wt, 'sessions'))) {
        if (dir.charCodeAt(0) === 0x2e || !/^[A-Za-z0-9_.-]+$/.test(dir)) continue;   // skip .tombstones/dotdirs + anything not a plausible login
        let files = [];
        try { files = fs.readdirSync(path.join(wt, 'sessions', dir)); } catch (e) { continue; }
        for (const f of files) if (f.endsWith('.jsonl')) authorOf[f.slice(0, -6)] = dir;
      }
    } catch (e) { /* no worktree yet → no authors */ }
  }

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
  const cacheIn = loadCache();
  const cacheOut = {};              // rebuilt from the files present NOW, so a deleted session evicts itself
  for (const name of files) {
    const f = path.join(proj, name);
    const sid = name.slice(0, -6); // os.path.basename(f)[:-6] strips ".jsonl"
    let mtime;
    let st = null;
    try {
      st = fs.statSync(f);
      mtime = Math.trunc(st.mtimeMs / 1000);
    } catch (e) {
      mtime = 0;
    }
    // One stat already ran; the identity key costs nothing more than reading three fields off it.
    const ckey = st ? (st.size + ':' + st.mtimeMs + ':' + st.ctimeMs) : '';
    let preview = '';
    let msgs = 0;
    let created = 0;
    let lastTs = 0;   // newest content timestamp — the "last real conversation activity" clock (see `used` below)
    const c = ckey ? cacheIn[sid] : null;
    // Types are checked, not trusted: a hand-edited or half-written cache must fall back to a real parse
    // rather than emit a record of the wrong shape. Wrong-but-well-formed is the failure mode worth fearing.
    const hit = c && c.k === ckey && typeof c.p === 'string'
      && typeof c.m === 'number' && typeof c.c === 'number' && typeof c.l === 'number' ? c : null;
    if (hit) {
      preview = hit.p; msgs = hit.m; created = hit.c; lastTs = hit.l;
    } else try {
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
        {
          const ts = o.timestamp;
          if (typeof ts === 'string') {
            const t = parseTs(ts);
            if (!created) created = t;
            if (t > lastTs) lastTs = t;
          }
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
    if (ckey) cacheOut[sid] = { k: ckey, p: preview, m: msgs, c: created, l: lastTs };
    const rec = {
      id: sid,
      mtime: mtime,
      created: created || mtime,
      preview: preview || '(empty session)',
      msgs: msgs
    };
    // `used` = when this session was genuinely LAST TOUCHED, for display/ordering: the newest of
    //   · the newest content timestamp (fs mtime is useless for collaborator imports — they're deliberately
    //     aged to 2000-01-01 so the auto-resume heuristic can never pick a foreign transcript; content
    //     timestamps are the real activity clock and max() lets them win over the sentinel),
    //   · the activation stamp session.sh drops in .claudible-used/<id> when it actually resumes the
    //     session (opening a conversation to READ it appends nothing to the .jsonl — without the stamp its
    //     row sits at "9d ago" forever no matter how often it's opened),
    //   · the fs mtime (still the freshest signal for a local file mid-write).
    // Emitted only in --with-authors mode, like `author`: the unflagged (parity-oracle) shape is untouched.
    if (WITH_AUTHORS) {
      let act = 0;
      try { act = Math.trunc(fs.statSync(path.join(proj, '.claudible-used', sid)).mtimeMs / 1000); } catch (e) {}
      rec.used = Math.max(lastTs, act, mtime);
    }
    if (tombs.has(sid) && !kept.has(sid)) rec.deletedRemote = true;
    if (diverged.has(sid)) rec.diverged = true;
    if (WITH_AUTHORS && foreign.has(sid) && authorOf[sid]) rec.author = String(authorOf[sid]).slice(0, 40);
    out.push(rec);
  }
  // Stable sort by (created || mtime) descending. JS sort is stable (Node >= 11).
  out.sort((a, b) => {
    const ka = a.created || a.mtime;
    const kb = b.created || b.mtime;
    return kb - ka;
  });
  // Written AFTER the answer is fully assembled and BEFORE it is printed, so a cache write that fails cannot
  // affect what the caller receives. saveCache never throws.
  saveCache(cacheOut);
  process.stdout.write(dumpArr(out) + '\n');
}

// python: isinstance(x, dict). For x.get("text"), the value must be a JSON object
// (not array, not null). x.get(...) on a dict.
function isPlainDict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

main();
