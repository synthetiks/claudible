'use strict';
// Node port of the python3 transform in transcript.sh — removes the python3 dependency.
// Behavior is byte-identical to the original python: reads a .jsonl path from argv[2],
// emits a JSON array of {role,text} messages (oldest-first), or [] on any failure.
// Output matches python's json.dumps (ensure_ascii=True, ', ' / ': ' separators) + a trailing newline.

const fs = require('fs');

const MAX_MSGS = 500; // keep the most recent N turns
const MAX_LEN = 6000; // cap each message so one giant turn can't bloat the payload

// Exact set of characters python's str.strip() treats as whitespace (no ﻿).
const WS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function pyStrip(s) {
  let start = 0;
  let end = s.length;
  while (start < end && WS.has(s.charCodeAt(start))) start++;
  while (end > start && WS.has(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

function isPlainObject(o) {
  return typeof o === 'object' && o !== null && !Array.isArray(o);
}

function textof(content) {
  if (Array.isArray(content)) {
    const parts = [];
    for (const x of content) {
      if (isPlainObject(x) && x.type === 'text') {
        // python: x.get("text", "") — a MISSING key yields "" (joined in), but a
        // PRESENT non-string value makes " ".join(...) raise TypeError, which aborts
        // the whole file to [] via the outer except. Replicate both.
        if (!('text' in x)) {
          parts.push('');
        } else if (typeof x.text === 'string') {
          parts.push(x.text);
        } else {
          throw new Error('non-string text');
        }
      }
    }
    return pyStrip(parts.join(' '));
  }
  if (typeof content === 'string') {
    return pyStrip(content);
  }
  return '';
}

// Serialize a JS string the way python's json.dumps does with ensure_ascii=True.
function pyJsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x08: out += '\\b'; break;
      case 0x09: out += '\\t'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0d: out += '\\r'; break;
      default:
        if (c >= 0x20 && c <= 0x7e) {
          out += s[i];
        } else {
          out += '\\u' + c.toString(16).padStart(4, '0');
        }
    }
  }
  return out + '"';
}

function pyJsonArray(arr) {
  const items = arr.map(
    (m) => '{' + pyJsonString('role') + ': ' + pyJsonString(m.role) + ', ' +
           pyJsonString('text') + ': ' + pyJsonString(m.text) + '}'
  );
  return '[' + items.join(', ') + ']';
}

function main() {
  const f = process.argv[2];
  let out = [];
  try {
    // python opens with encoding="utf-8" (strict): invalid bytes raise UnicodeDecodeError
    // during line iteration → outer except → out=[]. fs.readFileSync(...,'utf8') would
    // silently substitute U+FFFD and never throw, diverging. Use a fatal TextDecoder so bad
    // UTF-8 throws to the outer catch. ignoreBOM:true keeps a leading BOM (python's "utf-8"
    // codec preserves it; only "utf-8-sig" strips), matching python's json.loads-fails-on-BOM.
    const data = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      fs.readFileSync(f)
    );
    // python opens the file in text mode (universal newlines): \r\n, \r and \n all act as
    // line breaks. Split on the same boundaries so line iteration matches. The translated
    // ending is stripped by pyStrip either way, so only the boundary positions matter.
    const lines = data.split(/\r\n|\r|\n/);
    // python's file iteration yields each line WITH its trailing newline; a final line without
    // a newline is still yielded. After .strip() the trailing newline is removed either way, so
    // splitting and stripping each piece is equivalent. (A trailing '' from a final newline
    // strips to '' and is skipped, matching python not yielding an empty final line.)
    for (let li = 0; li < lines.length; li++) {
      const line = pyStrip(lines[li]);
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch (e) {
        continue;
      }
      // python: o.get("type") — if o is not a dict this raises AttributeError, caught by the
      // OUTER except → out=[] and iteration stops. Replicate by throwing to the outer catch.
      if (!isPlainObject(o)) {
        throw new Error('non-object line');
      }
      const typ = o.type;
      if (typ !== 'user' && typ !== 'assistant') continue;
      const msg = o.message;
      if (!isPlainObject(msg)) continue;
      const t = textof(msg.content);
      if (!t) continue;
      // skip tool-result / system-ish user turns and the injected caveat preface
      if (typ === 'user' && (t.startsWith('<') || t.startsWith('Caveat'))) continue;
      let text = t;
      const cps = Array.from(text);
      if (cps.length > MAX_LEN) {
        text = cps.slice(0, MAX_LEN).join('') + '\n…(truncated)';
      }
      out.push({ role: typ === 'user' ? 'you' : 'claude', text: text });
    }
  } catch (e) {
    out = [];
  }
  if (out.length > MAX_MSGS) {
    out = out.slice(out.length - MAX_MSGS);
  }
  process.stdout.write(pyJsonArray(out) + '\n');
}

main();
