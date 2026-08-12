'use strict';
// Node port of the two python3 JSON transforms in sessions-sync.sh, so the script no longer
// depends on python3. Behavior is byte-identical to the original python.
//
//   subcommand "title-write": env CL_ID, CL_B64, CL_FILE  (was the title-set python block)
//       Decodes a base64 display name, sanitizes it, and merges {id:{title,ts}} into CL_FILE.
//   subcommand "title-read":  env CL_WT, CL_BR            (was the title-list python block)
//       Reads every meta/<author>.json straight off origin/<br> and prints the newest title per id.
//   subcommand "lineage-write": env CL_ID, CL_FROM, CL_FILE   (CLEAR-DRIFT-PATCH-PLAN FIX C1)
//       Merges {newId: {..., continuesFrom: oldId}} last-writer-wins into the same CL_FILE title-write uses.
//   subcommand "index-write": env CL_META, CL_SESSDIR, CL_OUT  (CLEAR-DRIFT-PATCH-PLAN FIX C2)
//       Generates a human-readable Markdown session index (title + lineage) for one author's transcripts.
//
// CommonJS on purpose (the repo's package.json has no "type":"module").

const fs = require('fs');
const { spawnSync } = require('child_process');

// --- base64: faithful port of CPython binascii.a2b_base64 (strict_mode=False) -------------------
// Python's base64.b64decode discards non-alphabet chars and enforces padding/quantum rules, raising
// on bad padding (which the caller turns into the empty-string fallback). Node's Buffer.from(...,
// 'base64') is lenient and would diverge, so we reimplement the python decoder exactly.
const B64TAB = (() => {
  const t = new Int8Array(256).fill(-1);
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = i;
  return t;
})();

function pyB64Decode(str) {
  const out = [];
  let quadPos = 0;
  let leftchar = 0;
  let pads = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (ch === 0x3d /* '=' */) {
      if (quadPos >= 2 && quadPos + (++pads) >= 4) {
        // a valid base64 quantum closed by padding -> done; trailing junk discarded (non-strict)
        return Buffer.from(out);
      }
      continue;
    }
    const d = ch < 256 ? B64TAB[ch] : -1;
    if (d === -1) continue; // skip non-alphabet chars (non-strict mode)
    pads = 0;
    switch (quadPos) {
      case 0:
        quadPos = 1;
        leftchar = d;
        break;
      case 1:
        quadPos = 2;
        out.push(((leftchar << 2) | (d >> 4)) & 0xff);
        leftchar = d & 0x0f;
        break;
      case 2:
        quadPos = 3;
        out.push(((leftchar << 4) | (d >> 2)) & 0xff);
        leftchar = d & 0x03;
        break;
      default: // case 3
        quadPos = 0;
        out.push(((leftchar << 6) | d) & 0xff);
        leftchar = 0;
        break;
    }
  }
  if (quadPos !== 0) {
    // matches python: quadPos===1 vs incorrect-padding; either way the caller falls back to ''
    throw new Error('Incorrect padding');
  }
  return Buffer.from(out);
}

// --- JSON serialization matching python's json.dump / json.dumps -------------------------------
// Python uses separators (', ', ': '); JS JSON.stringify uses no spaces, escapes differently, and
// reorders integer-like object keys. We therefore serialize ourselves, preserving key order via the
// pairs array and matching python's escaping for both ensure_ascii modes.

// codepoints with a short JSON escape in python
const SHORT_ESC = {
  0x22: '\\"',
  0x5c: '\\\\',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
};

function hex4(n) {
  return '\\u' + n.toString(16).padStart(4, '0');
}

// Serialize a JS string the way python's json encoder does.
//   ensureAscii=true  -> every char >= 0x7f becomes \uXXXX (astral -> surrogate pair)
//   ensureAscii=false -> chars >= 0x20 emitted raw, only control chars < 0x20 escaped
function encStr(s, ensureAscii) {
  let r = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i); // UTF-16 unit; matches python's \uXXXX surrogate output in ascii mode
    if (Object.prototype.hasOwnProperty.call(SHORT_ESC, code)) {
      r += SHORT_ESC[code];
    } else if (code < 0x20) {
      r += hex4(code);
    } else if (code < 0x7f) {
      r += s[i];
    } else {
      // code >= 0x7f
      if (ensureAscii) {
        r += hex4(code);
      } else {
        r += s[i];
      }
    }
  }
  return r + '"';
}

// Serialize a value. Objects are passed as arrays of [key, value] pairs to preserve insertion order
// exactly (python dicts never reorder integer-like keys, JS objects do).
function encVal(v, ensureAscii) {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return encNum(v);
  if (typeof v === 'string') return encStr(v, ensureAscii);
  if (Array.isArray(v)) {
    return '[' + v.map((x) => encVal(x, ensureAscii)).join(', ') + ']';
  }
  if (v && typeof v === 'object') {
    const entries = v.__pairs ? v.__pairs : Object.entries(v);
    let parts = [];
    for (const [k, val] of entries) {
      parts.push(encStr(k, ensureAscii) + ': ' + encVal(val, ensureAscii));
    }
    return '{' + parts.join(', ') + '}';
  }
  throw new Error('unsupported value');
}

function encNum(n) {
  // The only number the tool ever writes is an integer ts (int(time.time())), and String() of an
  // integer matches python's int repr exactly. Infinity/-Infinity/NaN also match python's json output
  // (Infinity / -Infinity / NaN) via String(). The lone gap is re-emitting a *foreign* non-integer ts
  // (e.g. 1e3): python would print "1000.0", String(1000) prints "1000". This cannot occur in
  // tool-authored data and is never emitted to stdout (title-read prints only the title string), so it
  // has no observable effect — see the parity notes.
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Number.isNaN(n)) return 'NaN';
  return String(n);
}

function obj(pairs) {
  return { __pairs: pairs };
}

// --- order-preserving JSON parse, matching python's json.loads -------------------------------
// JS JSON.parse + Object.entries reorders integer-like keys (e.g. "123" jumps ahead of "abc"),
// which would break byte-identical key ordering when we re-emit the file. We parse into ordered
// {__pairs:[...]} objects. We also accept NaN/Infinity/-Infinity literals (python's json.loads does)
// so a peer-authored entry round-trips identically; on any parse error the caller falls back to {}.
function parseJsonOrdered(text) {
  let pos = 0;
  const n = text.length;
  const WS = new Set([0x20, 0x09, 0x0a, 0x0d]); // python json whitespace
  function err() { throw new Error('json parse error'); }
  function skipWs() { while (pos < n && WS.has(text.charCodeAt(pos))) pos++; }
  function parseValue() {
    skipWs();
    if (pos >= n) err();
    const c = text[pos];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    // -Infinity must be checked before the number branch (the leading '-' would otherwise be eaten
    // by parseNumber). python's json.loads accepts NaN / Infinity / -Infinity.
    if (text.startsWith('-Infinity', pos)) { pos += 9; return -Infinity; }
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    if (text.startsWith('true', pos)) { pos += 4; return true; }
    if (text.startsWith('false', pos)) { pos += 5; return false; }
    if (text.startsWith('null', pos)) { pos += 4; return null; }
    if (text.startsWith('NaN', pos)) { pos += 3; return NaN; }
    if (text.startsWith('Infinity', pos)) { pos += 8; return Infinity; }
    return err();
  }
  function parseObject() {
    pos++; // {
    const pairs = [];
    skipWs();
    if (text[pos] === '}') { pos++; return obj(pairs); }
    for (;;) {
      skipWs();
      if (text[pos] !== '"') err();
      const k = parseString();
      skipWs();
      if (text[pos] !== ':') err();
      pos++;
      const v = parseValue();
      pairs.push([k, v]);
      skipWs();
      const ch = text[pos];
      if (ch === ',') { pos++; continue; }
      if (ch === '}') { pos++; break; }
      err();
    }
    return obj(dedupeFirstPosLastVal(pairs));
  }
  function parseArray() {
    pos++; // [
    const arr = [];
    skipWs();
    if (text[pos] === ']') { pos++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      const ch = text[pos];
      if (ch === ',') { pos++; continue; }
      if (ch === ']') { pos++; break; }
      err();
    }
    return arr;
  }
  function parseString() {
    pos++; // opening quote
    let s = '';
    for (;;) {
      if (pos >= n) err();
      const c = text[pos++];
      if (c === '"') break;
      if (c === '\\') {
        const e = text[pos++];
        if (e === '"') s += '"';
        else if (e === '\\') s += '\\';
        else if (e === '/') s += '/';
        else if (e === 'b') s += '\b';
        else if (e === 'f') s += '\f';
        else if (e === 'n') s += '\n';
        else if (e === 'r') s += '\r';
        else if (e === 't') s += '\t';
        else if (e === 'u') {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) err();
          pos += 4;
          s += String.fromCharCode(parseInt(hex, 16));
        } else err();
      } else {
        // python's json (strict=True, the default) rejects raw control chars inside a string
        if (c.charCodeAt(0) < 0x20) err();
        s += c;
      }
    }
    return s;
  }
  function parseNumber() {
    const start = pos;
    if (text[pos] === '-') pos++;
    while (pos < n && text[pos] >= '0' && text[pos] <= '9') pos++;
    if (text[pos] === '.') { pos++; while (pos < n && text[pos] >= '0' && text[pos] <= '9') pos++; }
    if (text[pos] === 'e' || text[pos] === 'E') {
      pos++;
      if (text[pos] === '+' || text[pos] === '-') pos++;
      while (pos < n && text[pos] >= '0' && text[pos] <= '9') pos++;
    }
    const tok = text.slice(start, pos);
    // enforce python json's number grammar (no leading zeros, '.' must have fraction digits, exponent
    // must have digits) so we reject exactly what json.loads rejects; otherwise the consumer would keep
    // a file python would skip.
    if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) err();
    return Number(tok);
  }
  // python dict from json: duplicate keys keep the FIRST position but take the LAST value.
  function dedupeFirstPosLastVal(pairs) {
    if (pairs.length < 2) return pairs;
    const idx = new Map(); // key -> index in out
    const out = [];
    for (const [k, v] of pairs) {
      if (idx.has(k)) out[idx.get(k)][1] = v; // update value, keep position
      else { idx.set(k, out.length); out.push([k, v]); }
    }
    return out;
  }
  const v = parseValue();
  skipWs();
  if (pos !== n) err();
  return v;
}

// --- python str.strip() whitespace set (codepoints) --------------------------------------------
// JS .trim() differs (it strips U+FEFF but not U+0085, and the reverse), so use python's exact set.
const PY_STRIP = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
  0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function pyStrip(s) {
  // operate on codepoints
  const cps = Array.from(s);
  let start = 0;
  let end = cps.length;
  while (start < end && PY_STRIP.has(cps[start].codePointAt(0))) start++;
  while (end > start && PY_STRIP.has(cps[end - 1].codePointAt(0))) end--;
  return cps.slice(start, end).join('');
}

// ===============================================================================================

function titleWrite() {
  const f = process.env.CL_FILE;
  const i = process.env.CL_ID;
  let n;
  try {
    const bytes = pyB64Decode(process.env.CL_B64 || '');
    // ignoreBOM:true is load-bearing: the default TextDecoder strips a leading U+FEFF, but python's
    // bytes.decode('utf-8','replace') keeps it. fatal:false gives U+FFFD replacement == 'replace'.
    n = new TextDecoder('utf-8', { ignoreBOM: true, fatal: false }).decode(bytes);
  } catch (e) {
    n = '';
  }
  // strip control chars/newlines (codepoint < 32), cap length to 200 codepoints, then strip
  const filtered = Array.from(n).filter((c) => c.codePointAt(0) >= 32);
  n = pyStrip(filtered.slice(0, 200).join(''));

  // load existing file as ordered pairs; reset to {} if not a JSON object (matches python's
  // `d = json.load(open(f)); if not isinstance(d, dict): d = {}` with the except -> {} fallback).
  let pairs = [];
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const parsed = parseJsonOrdered(raw);
    if (parsed !== null && typeof parsed === 'object' && parsed.__pairs) {
      pairs = parsed.__pairs;
    } else {
      pairs = [];
    }
  } catch (e) {
    pairs = [];
  }

  // d[i] = {"title": n, "ts": now}  — update in place if key exists, else append. Fields OTHER than
  // title/ts already present on the entry (e.g. "continuesFrom", written by lineage-write below) are
  // preserved rather than clobbered — this file is additive-merge by design (CLEAR-DRIFT-PATCH-PLAN
  // :91-94: lineage costs no new plumbing precisely because it rides this same merge).
  // ts is MILLISECONDS now (was int(time.time()) seconds): two collaborators renaming inside the same
  // wall-clock second used to tie, and the tie-break (file order at read + each side preferring its own
  // local name) let the two machines disagree FOREVER. titleRead normalizes old second-stamps up to ms,
  // so UPGRADED readers compare mixed old/new entries correctly. Known transition artifact: a peer still
  // on an OLD build compares raw magnitudes, so any ms entry out-ranks their seconds entries until they
  // upgrade — bounded, self-healing (their next rename after upgrading stamps ms), and better than keeping
  // the permanent same-second split.
  let idx = -1;
  for (let k = 0; k < pairs.length; k++) { if (pairs[k][0] === i) { idx = k; break; } }
  const entryPairs = (idx !== -1 && pairs[idx][1] && typeof pairs[idx][1] === 'object' && pairs[idx][1].__pairs)
    ? pairs[idx][1].__pairs.slice()
    : [];
  setPair(entryPairs, 'title', n);
  setPair(entryPairs, 'ts', Date.now());
  const entry = obj(entryPairs);
  if (idx !== -1) pairs[idx][1] = entry; else pairs.push([i, entry]);

  const outStr = encVal(obj(pairs), /*ensureAscii=*/ false);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, outStr); // json.dump writes no trailing newline
  fs.renameSync(tmp, f); // os.replace == atomic rename
}

// Replace-in-place-or-append a [key, value] pair inside an ordered __pairs array (mutates + returns nothing).
function setPair(pairs, key, val) {
  for (const p of pairs) { if (p[0] === key) { p[1] = val; return; } }
  pairs.push([key, val]);
}

// subcommand "lineage-write": env CL_ID (the NEW session id), CL_FROM (the OLD id it continues), CL_FILE
// (same meta/<author>.json title-write merges into). CLEAR-DRIFT-PATCH-PLAN FIX C1 (:91-94): additive —
// merges {newId: {..., continuesFrom: oldId}} last-writer-wins into the existing {id:{title,ts}} map,
// preserving whatever title/ts a title-write already put there (and vice versa: titleWrite above now
// preserves continuesFrom the same way), so calling both ops on the same id in either order never loses data.
function lineageWrite() {
  const f = process.env.CL_FILE;
  const nid = process.env.CL_ID;
  const oid = process.env.CL_FROM;

  let pairs = [];
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const parsed = parseJsonOrdered(raw);
    if (parsed !== null && typeof parsed === 'object' && parsed.__pairs) pairs = parsed.__pairs;
  } catch (e) {
    pairs = [];
  }

  let idx = -1;
  for (let k = 0; k < pairs.length; k++) { if (pairs[k][0] === nid) { idx = k; break; } }
  const entryPairs = (idx !== -1 && pairs[idx][1] && typeof pairs[idx][1] === 'object' && pairs[idx][1].__pairs)
    ? pairs[idx][1].__pairs.slice()
    : [];
  setPair(entryPairs, 'continuesFrom', oid);
  const entry = obj(entryPairs);
  if (idx !== -1) pairs[idx][1] = entry; else pairs.push([nid, entry]);

  const outStr = encVal(obj(pairs), /*ensureAscii=*/ false);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, outStr);
  fs.renameSync(tmp, f);
}

// --- index-write: a generated, human-readable per-author session index -------------------------
const IDX_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function idxShort(id) { return String(id || '').slice(0, 8); }
function idxDate(ms) {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return IDX_MON[d.getUTCMonth()] + ' ' + d.getUTCDate();
}
function idxDateTime(ms) {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return idxDate(ms) + ' ' + hh + ':' + mm;
}

// subcommand "index-write": env CL_META (meta/<author>.json), CL_SESSDIR (sessions/<author>/, the dir whose
// *.jsonl transcripts we're indexing), CL_OUT (path to write, e.g. sessions/<author>/INDEX.md).
// CLEAR-DRIFT-PATCH-PLAN FIX C2 (:96-104). Fully DERIVED — regenerable from its two inputs, so it is safe to
// regenerate on every sync and nothing may ever depend on its content (only humans reading it on GitHub).
// Never renames or touches a transcript file (C3, :106-113).
function indexWrite() {
  const metaFile = process.env.CL_META;
  const sessDir = process.env.CL_SESSDIR;
  const out = process.env.CL_OUT;

  const meta = Object.create(null); // id -> {title, continuesFrom}
  try {
    const raw = fs.readFileSync(metaFile, 'utf8');
    const parsed = parseJsonOrdered(raw);
    if (parsed && typeof parsed === 'object' && parsed.__pairs) {
      for (const [id, v] of parsed.__pairs) {
        if (!v || typeof v !== 'object' || !v.__pairs) continue;
        let title = '', continuesFrom = null;
        for (const [k, vv] of v.__pairs) {
          if (k === 'title' && typeof vv === 'string') title = vv;
          else if (k === 'continuesFrom' && typeof vv === 'string' && vv) continuesFrom = vv;
        }
        meta[id] = { title, continuesFrom };
      }
    }
  } catch (e) { /* no meta yet → every row falls back to its short id as the name */ }

  let names = [];
  try { names = fs.readdirSync(sessDir); } catch (e) { names = []; }
  const ids = [];
  const stats = Object.create(null); // id -> {started, lastActive} (ms)
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const id = n.slice(0, -'.jsonl'.length);
    if (!id || /[^A-Za-z0-9-]/.test(id)) continue; // same id charset every other op enforces
    let st;
    try { st = fs.statSync(sessDir + '/' + n); } catch (e) { continue; }
    const started = (st.birthtimeMs && st.birthtimeMs > 0) ? st.birthtimeMs : st.mtimeMs; // some filesystems don't track birthtime → fall back to mtime rather than emit a blank column
    stats[id] = { started, lastActive: st.mtimeMs };
    ids.push(id);
  }

  const idSet = new Set(ids);
  const children = new Map(); // parent id -> [child id, ...], only for parents that themselves have a transcript here
  for (const id of ids) {
    const from = meta[id] && meta[id].continuesFrom;
    if (from && idSet.has(from)) {
      if (!children.has(from)) children.set(from, []);
      children.get(from).push(id);
    }
  }
  for (const [, kids] of children) kids.sort((a, b) => stats[a].started - stats[b].started); // a chain of clears renders oldest-child-first
  const isChild = new Set();
  for (const [, kids] of children) for (const k of kids) isChild.add(k);
  // Roots = every transcript NOT claimed as someone's continuation. A continuesFrom cycle (never produced by
  // the real drift path — ids are minted forward-only) would leave both sides mutually "claimed" and simply
  // drop out of the listing rather than recurse forever; a safe degradation, not a crash.
  const roots = ids.filter((id) => !isChild.has(id));
  roots.sort((a, b) => stats[b].lastActive - stats[a].lastActive); // most recently active conversation first

  const lines = [];
  lines.push('<!-- Generated by wsl/sessions-sync-tool.js index-write on every sync/push.');
  lines.push('     DERIVED — regenerated from meta/<author>.json and this directory\'s transcripts.');
  lines.push('     Nothing reads this file back; it exists only for humans browsing the sessions branch. -->');
  lines.push('');
  lines.push('| Session | Started | Last active | Id |');
  lines.push('|---|---|---|---|');

  const emitRow = (id, label) => {
    const s = stats[id];
    const m = meta[id] || { title: '', continuesFrom: null };
    const name = label || (m.title || ('`' + idxShort(id) + '`'));
    lines.push('| ' + name + ' | ' + idxDate(s.started) + ' | ' + idxDateTime(s.lastActive) + ' | `' + idxShort(id) + '` |');
    for (const k of (children.get(id) || [])) emitRow(k, '↳ continued after /clear');
  };
  for (const r of roots) emitRow(r, null);

  const outStr = lines.join('\n') + '\n';
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, outStr);
  fs.renameSync(tmp, out);
}

function titleRead() {
  const wt = process.env.CL_WT;
  const br = process.env.CL_BR;
  const git = (...a) => {
    const r = spawnSync('git', ['-C', wt, ...a], { encoding: 'utf8' });
    // python subprocess.run captures stdout; on failure it returns '' (no exception); mirror that.
    return r.stdout || '';
  };
  const paths = git('ls-tree', '-r', '--name-only', 'origin/' + br, '--', 'meta/')
    .split('\n')
    .filter((p) => p.endsWith('.json'));

  // dict.get(key, default) over our ordered-pairs object
  const getKey = (o, k, dflt) => {
    for (const [pk, pv] of o.__pairs) if (pk === k) return pv;
    return dflt;
  };

  // best: id -> [ts, title]; iteration order preserved via Map (== file/path order, like python)
  const best = new Map();
  for (const p of paths) {
    let d;
    try {
      d = parseJsonOrdered(git('show', 'origin/' + br + ':' + p) || '{}');
    } catch (e) {
      continue;
    }
    if (d === null || typeof d !== 'object' || !d.__pairs) continue; // not a dict -> skip
    for (const [i, v] of d.__pairs) {
      if (v === null || typeof v !== 'object' || !v.__pairs) continue; // not a dict -> skip
      let ts = getKey(v, 'ts', 0);
      const t = getKey(v, 'title', '');
      // python: isinstance(ts,(int,float)) — bool is an int subclass there, so booleans pass too
      // (True acts as 1, False as 0 in the > comparison). Mirror that exactly.
      if (typeof ts === 'boolean') ts = ts ? 1 : 0;
      else if (typeof ts !== 'number') continue;
      if (typeof t !== 'string') continue;
      // UNIT-SAFE newest-wins: titleWrite now stamps ms, but branch files written by older builds hold
      // seconds. Normalize seconds→ms before comparing (and emitting), or every new-format rename would
      // beat a genuinely newer old-format one purely on magnitude. (Epoch seconds < 1e12 < epoch ms.)
      if (ts > 0 && ts < 1e12) ts = ts * 1000;
      if (!best.has(i) || ts > best.get(i)[0]) best.set(i, [ts, t]);
    }
  }

  // CL_TS=1 (opt-in, set by sessions-sync.sh) emits {id:{n,ts}} instead of {id:title} — the winning
  // timestamp lets each machine's UI apply GLOBAL newest-wins against its own local rename (without it,
  // a machine's stale local rename shadowed a collaborator's newer one forever). Opt-in ONLY:
  // test/port-parity.sh runs this tool without the env and must stay byte-identical.
  const titlePairs = [];
  if (process.env.CL_TS === '1') {
    for (const [i, [ts, t]] of best) titlePairs.push([i, obj([['n', t], ['ts', ts]])]);
  } else {
    for (const [i, [, t]] of best) titlePairs.push([i, t]);
  }
  const result = obj([
    ['ok', true],
    ['op', 'title-list'],
    ['titles', obj(titlePairs)],
  ]);
  process.stdout.write(encVal(result, /*ensureAscii=*/ true) + '\n'); // print() adds newline
}

// subcommand "presence-filter": read candidate live/<author>.json blobs from stdin (one per line), keep ONLY those
// that parse as a single well-formed JSON object, and print the complete presence-list result line. A strict
// JSON.parse rejects exactly the junk the old brace-only bash guard let through — torn writes, trailing garbage
// ("{}x{}"), two concatenated objects — so one corrupt collaborator file can no longer poison the whole peers[]
// array (which would make the renderer's JSON.parse throw and silently kill the roster / "Join live" badge). Each
// surviving object is re-serialized so the emitted array is guaranteed valid JSON.
function presenceFilter() {
  let d = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { d += c; });
  process.stdin.on('end', () => {
    const out = [];
    for (const ln of d.split('\n')) {
      const s = ln.trim();
      if (!s) continue;
      let o;
      try { o = JSON.parse(s); } catch (e) { continue; }              // not a single valid JSON value → drop this peer, keep the rest
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(JSON.stringify(o));   // must be a plain object (a bare number/array/null/true is not a peer)
    }
    process.stdout.write('{"ok":true,"op":"presence-list","peers":[' + out.join(',') + ']}\n');
  });
}

// subcommand "live-holder": env CL_DIR (the worktree's live/ dir), CL_SID (session being claimed),
// CL_ME (my author login). ONE live host per session: decides whether presence-set may claim CL_SID.
// Prints a COMPLETE presence-set refusal line ({"ok":false,...,"error":"already-live","by":...}) when
// another author holds a FRESH claim on the session and I don't win it — or prints NOTHING when the
// claim may proceed. Rules:
//   · my own fresh claim on the session → proceed (the ~45s heartbeat re-stamps; never self-refuse)
//   · another author's claim is fresh (ts within LIVE_TTL, the SAME window the renderer's Join badge uses —
//     renderer LIVE_TTL_S; a crashed host goes stale and stops blocking) → refuse…
//   · …UNLESS my own fresh claim ALSO exists (the post-write push-retry re-check: both of us pushed in
//     the same race window — per-author files merge cleanly, so git ordering alone can't arbitrate) and
//     I WIN the deterministic tie-break: earlier ts first (first click wins), login ascending on a tie.
//     Exactly one side wins on identical inputs, so one host yields instead of both (or neither).
// Corrupt/unparseable peer files are ignored (like presence-filter) — junk must never lock a session.
// A claim dated further ahead than this is from a machine whose clock we cannot trust. It must be IGNORED, not
// clamped: `now - ts` going negative reads as "always fresh", so a forward-skewed (or hand-crafted — any peer
// with push access can write any author path, see the trust note above) stamp could refuse every future claim on
// that session FOREVER, with no TTL escape. Ignoring it fails in the safe direction: worst case an honest host
// with a badly-drifted clock is briefly not seen, instead of every host being permanently locked out.
// MUST match the renderer's SKEW_TOL_S.
const SKEW_TOL = 120;
const LIVE_TTL = 120;   // a live host re-stamps every ~45s (main.js heartbeat); 120s = ~2.6 missed beats of slack before a genuinely-crashed host's claim ages out. MUST match the renderer's LIVE_TTL_S.
function liveHolder() {
  const dir = process.env.CL_DIR || '';
  const sid = process.env.CL_SID || '';
  const me = process.env.CL_ME || '';
  if (!dir || !sid) return;
  // Age claims on the SAME clock the stamps were written with. main.js injects CLAUDIBLE_NOW (its Electron/Windows
  // clock) for every presence op, so post-fix ts values live in that domain; reading the WSL2 Date.now() here
  // instead would re-introduce the very sleep-drift skew the injection removes. Falls back to local time for direct CLI.
  const envNow = Number(process.env.CLAUDIBLE_NOW);
  const now = Number.isFinite(envNow) && envNow > 0 ? Math.floor(envNow) : Math.floor(Date.now() / 1000);
  const claims = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }          // no live/ dir → nobody holds anything
  for (const f of names) {
    if (!/^[^/\\]+\.json$/.test(f)) continue;
    let o;
    try { o = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch (e) { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const login = String(o.login || f.replace(/\.json$/, ''));
    const ts = Number(o.ts) || 0;
    if (String(o.session || '') !== sid) continue;
    // A phase-1 (starting:true) claim ages at the renderer's OWN 60s window (STARTING_TTL_S) — with the
    // full 120s here, an orphaned starting stamp kept refusing new claims for a minute AFTER every UI had
    // already stopped showing anyone live ("already-live" with nobody visibly live).
    const claimTtl = o.starting === true ? 60 : LIVE_TTL;
    if (ts > now + SKEW_TOL) continue;                                // future-dated → untrusted clock; must never lock the session
    if (now - ts >= claimTtl) continue;                               // stale claim (crashed/sleeping host) never blocks
    claims.push({ login, ts, name: String(o.name || '') });
  }
  const mine = claims.find((c) => c.login === me);
  const theirs = claims.filter((c) => c.login !== me);
  if (!theirs.length) return;                                         // free (or only me) → proceed
  if (mine) {                                                         // race: both fresh → deterministic winner
    const rival = theirs.slice().sort((a, b) => (a.ts - b.ts) || (a.login < b.login ? -1 : 1))[0];
    if (mine.ts < rival.ts || (mine.ts === rival.ts && mine.login < rival.login)) return;   // I was first → proceed
  }
  const holder = theirs.slice().sort((a, b) => (a.ts - b.ts) || (a.login < b.login ? -1 : 1))[0];
  process.stdout.write(JSON.stringify({ ok: false, op: 'presence-set', error: 'already-live', by: holder.name || holder.login, login: holder.login }) + '\n');
}

const sub = process.argv[2];
if (sub === 'title-write') {
  titleWrite();
} else if (sub === 'title-read') {
  titleRead();
} else if (sub === 'lineage-write') {
  lineageWrite();
} else if (sub === 'index-write') {
  indexWrite();
} else if (sub === 'presence-filter') {
  presenceFilter();
} else if (sub === 'live-holder') {
  liveHolder();
} else {
  process.stderr.write('unknown subcommand\n');
  process.exit(1);
}
