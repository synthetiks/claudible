#!/usr/bin/env node
'use strict';
// Node port of the python3 JSON transforms formerly inlined in skills.sh.
// Shared by the WSL, Posix and Windows backends, so output MUST stay
// byte-identical to the original python (json.dumps / json.dump semantics).
//
// Subcommands:
//   list  <SDIR>                -> prints json.dumps(items)             (python block 1)
//   set   <SDIR> <name> <state> -> writes settings.local.json + prints  (python block 2)
//
// On any error the process exits non-zero so the shell `|| printf '<fallback>'`
// keeps producing the original fallback output.

const fs = require('fs');
const os = require('os');
const path = require('path');

// --- python json compatibility -------------------------------------------
// Reproduce CPython json.dumps / json.dump exactly:
//   * ensure_ascii=True  -> escape every non-ASCII codepoint as \uXXXX
//   * default separators -> ", " and ": "
//   * indent=N           -> items separated by ",\n", key/value by ": "
// Object key order follows insertion order (matches python dict / our usage).

function pyEscapeString(s) {
  // Mirror CPython's c_encode_basestring_ascii: standard short escapes,
  // everything else < 0x20 or > 0x7e emitted as \uXXXX (UTF-16 code units,
  // so astral chars become surrogate pairs exactly like python).
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c > 0x7e) {
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function pyDumps(value, indent) {
  // indent undefined -> compact with ", " / ": "; number -> pretty like python.
  const pretty = typeof indent === 'number';
  const itemSep = pretty ? ',' : ', ';
  const kvSep = ': ';

  function enc(v, depth) {
    if (v === null || v === undefined) return 'null';
    const t = typeof v;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') return String(v);
    if (t === 'string') return pyEscapeString(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      if (!pretty) {
        return '[' + v.map((x) => enc(x, depth + 1)).join(itemSep) + ']';
      }
      const pad = ' '.repeat(indent * (depth + 1));
      const padEnd = ' '.repeat(indent * depth);
      return '[\n' + v.map((x) => pad + enc(x, depth + 1)).join(itemSep + '\n') + '\n' + padEnd + ']';
    }
    if (t === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 0) return '{}';
      if (!pretty) {
        return '{' + keys.map((k) => pyEscapeString(k) + kvSep + enc(v[k], depth + 1)).join(itemSep) + '}';
      }
      const pad = ' '.repeat(indent * (depth + 1));
      const padEnd = ' '.repeat(indent * depth);
      return '{\n' + keys.map((k) => pad + pyEscapeString(k) + kvSep + enc(v[k], depth + 1)).join(itemSep + '\n') + '\n' + padEnd + '}';
    }
    return 'null';
  }
  return enc(value, 0);
}

// --- python str helpers ---------------------------------------------------

// python str.strip() default whitespace set (ASCII subset that matters here).
const PY_WS = ' \t\n\r\v\f';
function pyStripWs(s) {
  return stripChars(s, PY_WS);
}

// python str.strip(chars): strip ALL leading/trailing chars contained in `set`.
function stripChars(s, chSet) {
  let start = 0;
  let end = s.length;
  while (start < end && chSet.indexOf(s[start]) !== -1) start++;
  while (end > start && chSet.indexOf(s[end - 1]) !== -1) end--;
  return s.slice(start, end);
}

// python str.splitlines() boundary set.
function pySplitlines(s) {
  const lines = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === '\r') {
      lines.push(cur);
      cur = '';
      if (s[i + 1] === '\n') i++; // \r\n is one boundary
    } else if (
      ch === '\n' ||
      c === 0x0b || c === 0x0c || // \v \f
      c === 0x1c || c === 0x1d || c === 0x1e || // FS GS RS
      c === 0x85 || c === 0x2028 || c === 0x2029
    ) {
      lines.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// --- frontmatter ----------------------------------------------------------
// Port of python front(path):
//   * read file utf-8; on error -> {}
//   * must start with "---"
//   * end = t.find("\n---", 3); if <0 -> {}
//   * parse lines in t[3:end]; value = strip().strip('"').strip("'")
//   * later duplicate keys overwrite earlier ones (dict assignment)
// Regex anchored at start (re.match), no DOTALL so (.*) excludes newlines; we
// already feed it single lines so [\s\S] is equivalent and safe.
const FRONT_RE = /^\s*([A-Za-z0-9_-]+)\s*:\s*([\s\S]*)$/;

// Strict UTF-8 decoder: python's open(encoding="utf-8").read() RAISES on
// invalid bytes (so front() returns {}); Node's readFileSync('utf8') would
// silently substitute U+FFFD. {fatal:true} reproduces python's behavior.
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function front(p) {
  let t;
  try {
    t = UTF8.decode(fs.readFileSync(p));
  } catch (e) {
    return {};
  }
  if (t.indexOf('---') !== 0) return {};
  const end = t.indexOf('\n---', 3);
  if (end < 0) return {};
  const out = {};
  const block = t.slice(3, end);
  for (const line of pySplitlines(block)) {
    const m = FRONT_RE.exec(line);
    if (m) {
      let val = m[2];
      val = pyStripWs(val);
      val = stripChars(val, '"');
      val = stripChars(val, "'");
      out[m[1]] = val;
    }
  }
  return out;
}

// glob.glob(base/*/SKILL.md) sorted: immediate subdirs containing SKILL.md,
// sorted by full path string (codepoint order, like python sorted()).
function globSkills(base) {
  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch (e) {
    return [];
  }
  const hits = [];
  for (const name of entries) {
    if (name[0] === '.') continue; // glob '*' does not match leading-dot dirs
    const sk = path.join(base, name, 'SKILL.md');
    let st;
    try {
      st = fs.statSync(sk);
    } catch (e) {
      continue;
    }
    if (st.isFile()) hits.push(sk);
  }
  hits.sort();
  return hits;
}

function cmdList(sdir) {
  const home = os.homedir();
  const items = [];
  const seen = new Set();

  function scan(base, scope) {
    for (const sk of globSkills(base)) {
      const fm = front(sk);
      const nm = fm.name || path.basename(path.dirname(sk));
      if (seen.has(nm)) continue;
      seen.add(nm);
      // python str[:240] slices by code point, not UTF-16 unit.
      const desc = Array.from(fm.description || '').slice(0, 240).join('');
      items.push({ name: nm, scope: scope, description: desc });
    }
  }

  scan(path.join(home, '.claude', 'skills'), 'user');
  if (sdir) scan(path.join(sdir, '.claude', 'skills'), 'project');

  let ov = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(sdir, '.claude', 'settings.local.json'), 'utf8'));
    ov = (cfg && cfg.skillOverrides) || {};
    if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) ov = {};
  } catch (e) {
    ov = {};
  }
  for (const it of items) {
    it.state = Object.prototype.hasOwnProperty.call(ov, it.name) ? ov[it.name] : 'on';
  }
  process.stdout.write(pyDumps(items) + '\n'); // python print() adds trailing \n
}

function cmdSet(sdir, name, state) {
  const d = path.join(sdir, '.claude');
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, 'settings.local.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    cfg = {};
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) cfg = {};
  let ov = cfg.skillOverrides || {};
  if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) ov = {};
  if (state === 'on') {
    delete ov[name]; // 'on' is the default -> just clear any override
  } else {
    ov[name] = state;
  }
  cfg.skillOverrides = ov;
  fs.writeFileSync(p, pyDumps(cfg, 2));
  process.stdout.write(pyDumps({ ok: true, state: state }) + '\n'); // python print() adds trailing \n
}

function main() {
  const sub = process.argv[2];
  try {
    if (sub === 'list') {
      cmdList(process.argv[3]);
    } else if (sub === 'set') {
      cmdSet(process.argv[3], process.argv[4], process.argv[5]);
    } else {
      process.exit(1);
    }
  } catch (e) {
    process.exit(1);
  }
}

main();
