#!/usr/bin/env node
// Claudible — batch stub scanner for sessions-sync.sh (one node start per sync pass, not per file).
//
// stdin:  newline-delimited transcript paths.
// stdout: '#ok' on the first line, then every input path that holds >= 1 REAL prompt.
//         (The '#ok' header lets the shell tell "node ran, zero files qualify" apart from "node failed".)
//
// A REAL prompt uses the SAME rule as sessions-tool.js's msgs counter (the app's one stub definition —
// the picker hides msgs===0 sessions): a type:"user" line whose message.content text (a string, or the
// joined text-items of an array) is non-empty after trim and does not start with '<' or 'Caveat'.
// The old sync gate was a bare grep for '"type":"user"', which caveat injections, tool_result wrappers
// and command/bash echoes all satisfy — so stubs the app itself hides could still spread to collaborators.
'use strict';
const fs = require('fs');

const isPlainDict = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function hasRealPrompt(file) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const line of data.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (!isPlainDict(o) || o.type !== 'user' || !isPlainDict(o.message)) continue;
    const c = o.message.content;
    let t;
    if (Array.isArray(c)) {
      const texts = [];
      for (const x of c) {
        if (isPlainDict(x) && x.type === 'text') texts.push(typeof x.text === 'string' ? x.text : '');
      }
      t = texts.join(' ');
    } else {
      t = typeof c === 'string' ? c : '';
    }
    t = (t || '').trim();
    if (t && !t.startsWith('<') && !t.startsWith('Caveat')) return true;
  }
  return false;
}

let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const out = ['#ok'];
  for (const p of buf.split('\n')) {
    const f = p.trim();
    if (f && hasRealPrompt(f)) out.push(f);
  }
  process.stdout.write(out.join('\n') + '\n');
});
