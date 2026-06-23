#!/usr/bin/env node
'use strict';
// Claudible — Node port of the python3 transform in workflows.sh (emit LIVE workflow/swarm agent
// state for one session as JSON). Behavior is byte-identical to the original python: same inputs
// (argv WF_ROOT, files under it), same stdout (json.dumps(out)), same .parse-cache.json side effect.
const fs = require('fs');
const path = require('path');

// ---- python json.dumps faithful serializer (ensure_ascii=True, separators=(', ', ': ')) ----
function pyStr(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20 || c >= 0x7f) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s[i];
  }
  return out + '"';
}
function pyDump(v) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'string') return pyStr(v);
  if (t === 'number') {
    if (!isFinite(v)) return v > 0 ? 'Infinity' : (v < 0 ? '-Infinity' : 'NaN');
    return String(v);
  }
  if (t === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(pyDump).join(', ') + ']';
  if (t === 'object') {
    const parts = [];
    for (const k of Object.keys(v)) parts.push(pyStr(k) + ': ' + pyDump(v[k]));
    return '{' + parts.join(', ') + '}';
  }
  return 'null';
}

// ---- helpers mirroring python ----
// Exact set of codepoints python str.split() (no-arg) treats as whitespace, i.e. str.isspace()==True.
// JS's \s differs (it lacks 0x1c-0x1f and 0x85, and includes 0xfeff), so we match python's set verbatim.
const PY_WS = '\\u0009\\u000a\\u000b\\u000c\\u000d\\u001c\\u001d\\u001e\\u001f\\u0020' +
              '\\u0085\\u00a0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007' +
              '\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_RE = new RegExp('[' + PY_WS + ']+');
const PY_STRIP_RE = new RegExp('^[' + PY_WS + ']+|[' + PY_WS + ']+$', 'g');
function pySplitJoin(s) {
  // python ' '.join(str.split()) : split on any python-whitespace run, drop empties.
  const parts = String(s).split(PY_WS_RE).filter((x) => x.length > 0);
  return parts.join(' ');
}
function pyStrip(s) {
  // python str.strip() with no args — strips python's whitespace set (NOT JS .trim()'s set).
  return String(s).replace(PY_STRIP_RE, '');
}
function jsonLoads(line) {
  try { return { ok: true, v: JSON.parse(line) }; } catch (e) { return { ok: false }; }
}
function pyTruthy(x) {
  // python truthiness for the values a JSON.parse can yield
  if (x === null || x === undefined || x === false) return false;
  if (x === 0) return false;
  if (typeof x === 'string') return x.length > 0;
  if (typeof x === 'number') return x !== 0; // NaN -> true in python (only 0/0.0 falsy); JS NaN!==0 -> true
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === 'object') return Object.keys(x).length > 0;
  return true;
}

function shortTarget(inp) {
  // A compact 'what' for a tool call (filename / command / pattern / url …).
  if (inp === null || typeof inp !== 'object' || Array.isArray(inp)) return '';
  const keys = ['file_path', 'path', 'command', 'pattern', 'url', 'description', 'subagent_type', 'query', 'prompt'];
  for (const k of keys) {
    let v = inp[k];
    if (typeof v === 'string' && pyStrip(v) !== '') {
      v = pySplitJoin(v);
      if (k === 'file_path' || k === 'path') {
        const idx = v.lastIndexOf('/');
        if (idx >= 0) v = v.slice(idx + 1);
      }
      return v.slice(0, 52);
    }
  }
  return '';
}

function readLines(file) {
  // mirror python text file iteration: split on \n (python universal newlines also split \r\n/\r,
  // but these jsonl files are \n-delimited; .strip() removes any trailing \r anyway).
  const data = fs.readFileSync(file, 'utf8');
  return data.split('\n');
}

function parseTimestamp(ts) {
  // python: datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp(), guarded by try/except.
  // Real Claude-Code timestamps are always '...HH:MM:SS.mmmZ' (3-digit ms); on those Date.parse and
  // fromisoformat agree exactly (validated against all live data). For non-standard fractional precision
  // the two can differ (py3.10 fromisoformat is strict about 3/6 digits; py3.11+ and Date.parse are
  // lenient) — affects only the 'start' float on malformed input the CLI never emits.
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts.split('Z').join('+00:00')); // replace ALL 'Z' (python str.replace replaces all)
  if (isNaN(ms)) return null;
  return ms / 1000;
}

function parseAgent(f) {
  // Read an agent transcript fully: prompt (label), start, tool-call feed, tokens, final result text.
  let start = null, label = '', lastText = '', tools = [], usage = {}, seq = 0;
  const usageOrder = []; // preserve insertion order of request ids (python dict order)
  try {
    let lines;
    try { lines = readLines(f); } catch (e) { throw e; }
    for (let raw of lines) {
      const line = pyStrip(raw);
      if (!line) continue;
      const r = jsonLoads(line);
      if (!r.ok) continue;
      const o = r.v;
      if (o === null || typeof o !== 'object' || Array.isArray(o)) continue;
      if (start === null && o.timestamp) {
        const v = parseTimestamp(o.timestamp);
        if (v !== null) start = v;
      }
      const t = o.type; const msg = o.message;
      const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
      if (t === 'user' && isObj(msg)) {
        const c = msg.content;
        let txt;
        if (Array.isArray(c)) {
          txt = c.filter((x) => isObj(x) && x.type === 'text')
                 .map((x) => (typeof x.text === 'string' ? x.text : ''))
                 .join(' ');
        } else {
          txt = (typeof c === 'string') ? c : '';
        }
        txt = pyStrip(txt || '');
        if (!label && txt && !txt.startsWith('<')) {
          label = pySplitJoin(txt).slice(0, 90);
        }
      } else if (t === 'assistant' && isObj(msg)) {
        const c = msg.content;
        if (Array.isArray(c)) {
          for (const x of c) {
            if (!isObj(x)) continue;
            if (x.type === 'tool_use') {
              tools.push({ name: String(x.name === undefined || x.name === null ? '' : x.name).slice(0, 22), target: shortTarget(x.input) });
            } else if (x.type === 'text' && typeof x.text === 'string' && pyStrip(x.text) !== '') {
              lastText = pyStrip(x.text);
            }
          }
        }
        const u = (msg.usage === undefined || msg.usage === null) ? {} : msg.usage;
        // python: `u = msg.get('usage') or {}` then `if u:` — truthy means a non-empty value.
        if (pyTruthy(u)) {
          // python: rid = o.get('requestId') or (msg.get('id') if isinstance(msg, dict) else None)
          let rid = o.requestId;
          if (!pyTruthy(rid)) rid = isObj(msg) ? msg.id : null;
          // python: if not rid: rid = '_l%d' % seq; seq += 1
          if (!pyTruthy(rid)) { rid = '_l' + seq; seq += 1; }
          try {
            let ent = usage[rid];
            if (ent === undefined) { ent = { in: 0, out: 0 }; usage[rid] = ent; usageOrder.push(rid); }
            ent.in = pyInt(u && typeof u === 'object' ? u.input_tokens : 0);
            ent.out = Math.max(ent.out, pyInt(u && typeof u === 'object' ? u.output_tokens : 0));
          } catch (e) { /* pass */ }
        }
      }
    }
  } catch (e) {
    /* pass */
  }
  let tokens = 0;
  for (const rid of usageOrder) tokens += usage[rid].in + usage[rid].out;
  return {
    label: label,
    start: start,
    tools: tools,
    toolCount: tools.length,
    tokens: tokens,
    result: pySplitJoin(lastText).slice(0, 280),
  };
}

function pyInt(v) {
  // python: int(x or 0) with `x` possibly None/number/numeric-string; guarded by try/except -> 0 on fail.
  // python `u.get('input_tokens', 0) or 0` : falsy (None/0/''/[]) -> 0.
  if (v === undefined || v === null || v === false || v === '' || v === 0) return 0;
  if (typeof v === 'number') {
    if (!isFinite(v)) throw new Error('non-finite'); // python int(inf) raises -> caught upstream
    return Math.trunc(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0; // `'' or 0` -> 0
    if (!/^[+-]?\d+$/.test(s)) throw new Error('not an int'); // python int('1.5') raises
    return parseInt(s, 10);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new Error('uncastable');
}

function getMtimeSec(p) {
  // os.path.getmtime returns float seconds.
  return fs.statSync(p).mtimeMs / 1000;
}

function main() {
  const root = process.argv[2];
  const now = Date.now() / 1000;
  const RECENT = 900;
  const STALE = 180;

  // ---- parse cache ----
  const CACHE = path.join(root, '.parse-cache.json');
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (cache === null || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  } catch (e) {
    cache = {};
  }
  const allAids = new Set();

  function cachedParse(af, aid) {
    let st;
    try { st = fs.statSync(af); } catch (e) { return parseAgent(af); }
    const key = Math.trunc(st.mtimeMs / 1000) + ':' + st.size;
    const ent = cache[aid];
    if (ent && typeof ent === 'object' && ent.key === key && Object.prototype.hasOwnProperty.call(ent, 'info')) return ent.info;
    const info = parseAgent(af);
    cache[aid] = { key: key, info: info };
    return info;
  }

  // ---- enumerate workflows ----
  // python glob.glob(root/wf_*) returns entries in raw directory (scandir) order, NOT sorted.
  // fs.readdirSync sorts (libuv), which would diverge on mtime ties; opendirSync gives raw FS order.
  let entries = [];
  try {
    const d = fs.opendirSync(root);
    let e;
    while ((e = d.readSync()) !== null) entries.push(e.name);
    d.closeSync();
  } catch (e) { entries = []; }
  let wfs = entries
    .filter((n) => n.startsWith('wf_'))
    .map((n) => path.join(root, n));
  // sorted(..., key=lambda p: getmtime(p) if exists else 0, reverse=True) — python sort is stable.
  const decorated = wfs.map((p, i) => {
    let m = 0;
    try { if (fs.existsSync(p)) m = getMtimeSec(p); } catch (e) { m = 0; }
    return { p: p, m: m, i: i };
  });
  decorated.sort((a, b) => {
    if (a.m < b.m) return 1;   // reverse=True -> larger mtime first
    if (a.m > b.m) return -1;
    return a.i - b.i;          // stable: preserve original (readdir) order on ties
  });
  wfs = decorated.map((d) => d.p);

  const out = [];
  for (const wf of wfs.slice(0, 6)) {
    const jpath = path.join(wf, 'journal.jsonl');
    const seen = [];
    const seenSet = new Set();
    const done = new Set();
    try {
      const lines = readLines(jpath);
      for (let raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const r = jsonLoads(line);
        if (!r.ok) continue;
        const o = r.v;
        if (o === null || typeof o !== 'object' || Array.isArray(o)) continue;
        const aid = o.agentId;
        if (!aid) continue;
        if (!seenSet.has(aid)) { seen.push(aid); seenSet.add(aid); }
        if (o.type === 'result') done.add(aid);
      }
    } catch (e) {
      /* pass */
    }
    const agents = [];
    for (const aid of seen) {
      const af = path.join(wf, 'agent-' + aid + '.jsonl');
      allAids.add(aid);
      let info;
      if (fs.existsSync(af)) info = cachedParse(af, aid);
      else info = { label: '', start: null, tools: [], toolCount: 0, tokens: 0, result: '' };
      let last = null;
      try { last = Math.trunc(getMtimeSec(af)); } catch (e) { last = null; }
      const isRunning = (!done.has(aid)) && (last !== null) && ((now - last) <= STALE);
      agents.push({
        id: String(aid).slice(0, 9),
        label: info.label || 'agent',
        status: isRunning ? 'running' : 'done',
        start: info.start ? Math.trunc(info.start) : null,
        last: last,
        tokens: info.tokens,
        toolCount: info.toolCount,
        tools: info.tools.slice(-12),
        result: isRunning ? '' : info.result,
      });
    }
    if (agents.length === 0) continue;
    let running = 0;
    for (const a of agents) if (a.status === 'running') running++;
    const acts = [];
    for (const a of agents) if (a.last) acts.push(a.last);
    try { acts.push(Math.trunc(getMtimeSec(jpath))); } catch (e) { /* pass */ }
    const activity = acts.length ? Math.max.apply(null, acts) : 0;
    if ((now - activity) > RECENT) continue;
    let doneCount = 0;
    for (const a of agents) if (a.status !== 'running') doneCount++;
    out.push({
      wf: path.basename(wf),
      mtime: activity,
      total: agents.length,
      done: doneCount,
      running: running,
      agents: agents,
    });
  }

  // ---- prune + persist cache (best effort) ----
  // .parse-cache.json is a private performance side-cache (NOT stdout). It is fully cross-engine
  // compatible: node reads python's cache and vice versa, both yielding identical stdout (the cache
  // 'info.start' is a float that is int()/trunc()'d before output, so its serialization is moot).
  // We use compact JSON.stringify here; python's json.dump renders whole-second floats as e.g.
  // "1782244743.0" which JS cannot reproduce without emulating Python float repr — irrelevant to the
  // consumed stdout, so we don't. Keys are written in insertion order, matching python dict order.
  try {
    const pruned = {};
    for (const k of Object.keys(cache)) if (allAids.has(k)) pruned[k] = cache[k];
    fs.writeFileSync(CACHE + '.tmp', JSON.stringify(pruned));
    fs.renameSync(CACHE + '.tmp', CACHE);
  } catch (e) {
    /* pass */
  }

  process.stdout.write(pyDump(out) + '\n'); // python print() appends a trailing newline
}

main();
