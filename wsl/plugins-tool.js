#!/usr/bin/env node
// Claudible — Node port of the python3 JSON transforms in plugins.sh (removes the python3 dependency).
// Shared by the WSL backend and the Posix/Windows backends, so output MUST stay byte-identical to the
// original python3 (json.dumps defaults: ", "/": " separators + ensure_ascii=True). Subcommand selects
// the transform: "list" (installed plugins) or "available" (marketplace catalog). Fallback is the caller's
// `|| printf '[]'`, so on any error we just exit non-zero and emit nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Faithful re-implementation of Python's json.dumps(obj) with default kwargs ---
// Defaults: item_separator=", ", key_separator=": ", ensure_ascii=True.
function pyStr(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i); // UTF-16 code unit; matches Python's per-surrogate \uXXXX emission
    switch (ch) {
      case '"': out += '\\"'; continue;
      case '\\': out += '\\\\'; continue;
      case '\n': out += '\\n'; continue;
      case '\r': out += '\\r'; continue;
      case '\t': out += '\\t'; continue;
      case '\b': out += '\\b'; continue;
      case '\f': out += '\\f'; continue;
    }
    if (code < 0x20 || code >= 0x7f) {
      out += '\\u' + code.toString(16).padStart(4, '0'); // lowercase hex, like Python
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function pyDumps(obj) {
  if (obj === null) return 'null';
  const t = typeof obj;
  if (t === 'boolean') return obj ? 'true' : 'false';
  if (t === 'number') {
    if (Number.isInteger(obj)) return String(obj);
    return String(obj); // numbers don't occur in these transforms beyond ints, kept simple
  }
  if (t === 'string') return pyStr(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(pyDumps).join(', ') + ']';
  }
  // plain object: preserve insertion order, ": " between key/value, ", " between items
  const parts = [];
  for (const k of Object.keys(obj)) {
    parts.push(pyStr(k) + ': ' + pyDumps(obj[k]));
  }
  return '{' + parts.join(', ') + '}';
}

// --- Helpers mirroring the python ---
function load(p) {
  // python: try json.load(open(p)) except Exception: return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return {};
  }
}

// Python str.lower() for sort key. Plugin names are practically ASCII; toLowerCase() matches for those.
function lowerKey(x) {
  return String(x).toLowerCase();
}

// Stable sort by code-point comparison (Python compares strings by Unicode code point).
function sortByName(arr) {
  arr
    .map((v, i) => [v, i])
    .sort((a, b) => {
      const ka = lowerKey(a[0].name);
      const kb = lowerKey(b[0].name);
      const cmp = cmpCodepoints(ka, kb);
      return cmp !== 0 ? cmp : a[1] - b[1];
    })
    .forEach((pair, idx) => { arr[idx] = pair[0]; });
}

// Compare two strings by Unicode code point (not UTF-16 code unit), matching Python's str ordering.
function cmpCodepoints(a, b) {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done && bn.done) return 0;
    if (an.done) return -1;
    if (bn.done) return 1;
    const ac = an.value.codePointAt(0);
    const bc = bn.value.codePointAt(0);
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
}

// Python truthiness: None/""/0/[]/{} are falsy; everything else truthy. Used to mirror `a or b or []`.
function pyTruthy(v) {
  if (v === null || v === undefined) return false;
  if (v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// Mirror python `a or b or c ...`: returns the first python-truthy value, else the last argument.
function pyOr() {
  for (let i = 0; i < arguments.length; i++) {
    if (i === arguments.length - 1 || pyTruthy(arguments[i])) return arguments[i];
  }
}

// Slice the first n Unicode code points, matching Python's str[:n].
function sliceCodepoints(s, n) {
  let out = '';
  let count = 0;
  for (const ch of s) {
    if (count >= n) break;
    out += ch;
    count++;
  }
  return out;
}

function listCmd(home) {
  const ip = load(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const settings = load(path.join(home, '.claude', 'settings.json'));
  const en = (settings && settings.enabledPlugins) || {};
  const out = [];
  const plugins = (ip && ip.plugins) || {};
  for (const key of Object.keys(plugins)) {
    const arr = plugins[key];
    // python: info = (arr or [{}])[0] if isinstance(arr, list) else {}
    let info;
    if (Array.isArray(arr)) {
      const a = (arr && arr.length) ? arr : [{}];
      info = a[0];
    } else {
      info = {};
    }
    if (info === null || typeof info !== 'object') info = {};
    // python: nm, _, mkt = key.partition("@")
    const at = key.indexOf('@');
    const nm = at === -1 ? key : key.slice(0, at);
    const mkt = at === -1 ? '' : key.slice(at + 1);
    out.push({
      key: key,
      name: nm,
      marketplace: mkt,
      version: getStr(info, 'version', ''),
      scope: getStr(info, 'scope', ''),
      enabled: Boolean(en[key]),
    });
  }
  sortByName(out);
  process.stdout.write(pyDumps(out) + '\n');
}

// python: info.get("version", "") — returns value as-is if present, else default.
function getStr(obj, k, def) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  return def;
}

function availableCmd(home) {
  // python: inst = set of installed plugin keys, default empty set on any error
  let inst;
  try {
    const ipFile = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')
    );
    inst = new Set(Object.keys((ipFile && ipFile.plugins) || {}));
  } catch (e) {
    inst = new Set();
  }
  const out = [];
  const cats = globMarketplaces(home);
  for (const cat of cats) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(cat, 'utf8'));
    } catch (e) {
      continue;
    }
    // mkt = basename(dirname(dirname(cat)))
    const mkt = path.basename(path.dirname(path.dirname(cat)));
    // python: (d.get("plugins") or d.get("entries") or []) — empty list/dict is falsy and falls through.
    const list = pyOr(d && d.plugins, d && d.entries, []);
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) continue;
      const nm = p.name;
      if (!nm) continue; // python: if not nm: continue  (falsy)
      const descRaw = p.description || '';
      const desc = sliceCodepoints(String(descRaw), 160);
      out.push({
        name: nm,
        marketplace: mkt,
        description: desc,
        installed: inst.has(nm + '@' + mkt),
      });
    }
  }
  sortByName(out);
  process.stdout.write(pyDumps(out) + '\n');
}

// Emulate glob.glob(home/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json).
// glob.glob does NOT sort: it yields matches in raw directory (readdir(3)) order, same as os.scandir.
// That order is load-bearing here because the final list is sorted by name with a STABLE sort, so
// when two marketplaces expose the same plugin name the directory order decides the tie. fs.readdirSync
// sorts its results, which would diverge from python; fs.opendirSync preserves raw directory order and
// matches os.scandir, so we use it.
function globMarketplaces(home) {
  const base = path.join(home, '.claude', 'plugins', 'marketplaces');
  let dir;
  try {
    dir = fs.opendirSync(base);
  } catch (e) {
    return [];
  }
  const results = [];
  try {
    let ent;
    while ((ent = dir.readSync()) !== null) {
      // glob's `*` wildcard never matches names beginning with '.', so skip hidden dirs.
      if (ent.name.startsWith('.')) continue;
      const cand = path.join(base, ent.name, '.claude-plugin', 'marketplace.json');
      let st;
      try {
        st = fs.statSync(cand);
      } catch (e) {
        continue;
      }
      if (st.isFile()) results.push(cand);
    }
  } finally {
    dir.closeSync();
  }
  return results;
}

function main() {
  const sub = process.argv[2];
  const home = os.homedir();
  if (sub === 'list') {
    listCmd(home);
  } else if (sub === 'available') {
    availableCmd(home);
  } else {
    // Unknown subcommand: behave like a hard failure so the shell `|| printf '[]'` fallback triggers.
    process.exit(2);
  }
}

main();
